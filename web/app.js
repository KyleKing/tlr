import {
  bucketOf,
  buildBuckets,
  milestoneDisplayName,
  milestoneForecast,
  missingData,
  orderingRisks,
  personCycleCapacity,
  slopHash,
  slopScan,
  statusRank,
  teamWeeklyThroughput,
  weeksBetween,
} from "./lib/planning.js"
import { liveSnapshot } from "./lib/issues.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"
import { resolveProjectSlug, wireProjectPicker } from "./lib/nav.js"
import { showError } from "./lib/errorBanner.js"
import { openEditModal } from "./lib/editForm.js"
import { setPersonCycle } from "./lib/config.js"
import { whatIfPlan } from "./lib/whatif.js"

const STATUS = {
  started: { label: "In progress", color: "var(--st-started)", fg: "var(--st-started-fg)" },
  unstarted: { label: "Todo", color: "var(--st-unstarted)", fg: "var(--st-unstarted-fg)" },
  triage: { label: "Triage", color: "var(--st-triage)", fg: "var(--st-triage-fg)" },
  backlog: { label: "Backlog", color: "var(--st-backlog)", fg: "var(--st-backlog-fg)" },
  completed: { label: "Done", color: "var(--st-completed)", fg: "var(--st-completed-fg)" },
  canceled: { label: "Canceled", color: "var(--st-canceled)", fg: "var(--st-canceled-fg)" },
}
const FLAGS = { slop: "⚠ slop", risk: "⛔ ordering risk", miss: "◑ missing (in cycle)" }
const DEFAULT_STATUSES = ["started", "unstarted", "triage", "backlog"]
const REVIEW_KEY = "tlr.notslop"

// mutable module data, replaced on refresh
let buckets, bucketByKey, bucketWeeks, byId, riskIds, forecastByKey
// What the board draws: the stored snapshot (`data`) normally, its what-if simulation while that mode
// is on. Everything that renders reads `view`; only the real write paths read `data`.
let view, plan

function deriveBuckets() {
  buckets = buildBuckets(view, view.issues)
  bucketByKey = Object.fromEntries(buckets.map((b) => [b.key, b]))
  forecastByKey = Object.fromEntries(
    milestoneForecast(view, teamWeeklyThroughput(view)).milestones.map((m) => [m.key, m]),
  )
  bucketWeeks = {}
  view.milestones.forEach((m, idx) => {
    const start = idx === 0
      ? view.asOf
      : (new Date(view.asOf) > new Date(view.milestones[idx - 1].target) ? view.asOf : view.milestones[idx - 1].target)
    bucketWeeks[m.key] = Math.max(0.5, weeksBetween(start, m.target))
  })
  for (const b of buckets) if (b.kind === "cycle") bucketWeeks[b.key] = 1
  bucketWeeks.BACKLOG = Infinity
}

function enrich() {
  for (const i of view.issues) {
    // Every render/sort/group path below keys off the "Unassigned" sentinel string, not a real Linear
    // ingest's null (transformIssue normalizes it, but a hand-edited or older data file might not).
    i.assignee ||= "Unassigned"
    i.blocks ||= []
    i.blockedBy ||= []
    i.related ||= []
    i._bucket = bucketOf(i)
    i._bucketEnd = (bucketByKey[i._bucket] || { end: "9999-12-31" }).end
    i._slop = slopScan(i.description)
    i._slopHash = slopHash(i.description)
    i._miss = missingData(i)
  }
  riskIds = new Set(orderingRisks(view.issues).flatMap((r) => [r.issue, r.blocker]))
  for (const i of view.issues) i._risk = riskIds.has(i.id) && (i.blockedBy.length > 0)
  byId = Object.fromEntries(view.issues.map((i) => [i.id, i]))
}

// Rebuild everything derived from the snapshot. Overlays are re-applied from the stored data each
// time, so a simulation never compounds on top of a previous one.
function recompute() {
  plan = whatIf.on ? whatIfPlan(data, whatIf.overlays) : null
  view = plan ? plan.snapshot : data
  deriveBuckets()
  enrich()
}

async function loadProjects() {
  const r = await fetch("/data/projects.json", { cache: "no-store" })
  return r.ok ? r.json() : []
}

let currentDataFile = "cpu.json"
// true when the project's own data file was missing and we fell back to the bundled sample
let isSampleData = false

// Archived tickets are dropped on the way in, once, so nothing downstream — buckets, capacity, the
// forecast, the slop scan, the issue count in the header — has to remember to exclude them. The
// Changes and Review pages read the same file and keep them, which is the point of ingesting them.
async function loadData(dataFile = currentDataFile) {
  currentDataFile = dataFile
  const r = await fetch(`/data/${dataFile}`, { cache: "no-store" })
  isSampleData = !r.ok
  return liveSnapshot(await (r.ok ? r : await fetch("/data-sample.json", { cache: "no-store" })).json())
}

// not-slop dismissals persist locally, keyed by content hash so an edit re-flags
const reviewed = JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}")
const isDismissed = (i) => reviewed[i.id] === i._slopHash
const isSlop = (i) => i._slop.score >= 2 && !isDismissed(i)
function toggleReviewed(i) {
  if (isDismissed(i)) delete reviewed[i.id]
  else reviewed[i.id] = i._slopHash
  localStorage.setItem(REVIEW_KEY, JSON.stringify(reviewed))
  render()
}

const state = {
  q: "",
  statuses: new Set(DEFAULT_STATUSES),
  bucketKeys: null, // set after first load to all keys
  flags: new Set(),
  expanded: false,
  transpose: true, // rows: buckets by default — one row per cycle/milestone, not per person
}

// What-if planning. Overlays live here and nowhere else: never in the stored snapshot, never in
// localStorage, and never in a request body. Leaving the mode drops them, so the board cannot be left
// quietly showing simulated numbers.
const whatIf = { on: false, overlays: [] }

const projects = await loadProjects()
const requestedSlug = new URLSearchParams(location.search).get("project")
const currentProject = resolveProjectSlug(projects, requestedSlug)
const data = await loadData(currentProject?.dataFile)
recompute()
state.bucketKeys = new Set(buckets.map((b) => b.key))
hydrateStateFromUrl()
let loadedAt = new Date()

// Filters and view mode read back from the URL on load, so a refresh, a bookmark, or a shared link
// keeps them instead of always resetting to defaults. Only non-default values are ever written back
// (see syncUrl), so a plain "/" stays a plain "/" until something is actually changed.
function hydrateStateFromUrl() {
  const p = new URLSearchParams(location.search)
  if (p.has("q")) state.q = p.get("q")
  if (p.has("status")) state.statuses = new Set(p.get("status").split(",").filter(Boolean))
  if (p.has("buckets")) {
    const wanted = new Set(p.get("buckets").split(",").filter(Boolean))
    state.bucketKeys = new Set(buckets.map((b) => b.key).filter((k) => wanted.has(k)))
  }
  if (p.has("flags")) state.flags = new Set(p.get("flags").split(",").filter(Boolean))
  if (p.has("expanded")) state.expanded = true
  if (p.has("rows")) state.transpose = p.get("rows") !== "people"
}

// Writes the current filters/view mode into the URL (replacing history, not pushing — this fires on
// every render, and a back-button entry per filter click would be unusable) so the address bar always
// reflects what's on screen. Only non-default values are written, keeping a default-filtered URL plain.
function syncUrl() {
  const url = new URL(location.href)
  const p = url.searchParams
  state.q ? p.set("q", state.q) : p.delete("q")

  const statuses = [...state.statuses].sort().join(",")
  const defaultStatuses = [...DEFAULT_STATUSES].sort().join(",")
  statuses === defaultStatuses ? p.delete("status") : p.set("status", statuses)

  const bucketKeys = [...state.bucketKeys].sort().join(",")
  const allBucketKeys = buckets.map((b) => b.key).sort().join(",")
  bucketKeys === allBucketKeys ? p.delete("buckets") : p.set("buckets", bucketKeys)

  state.flags.size ? p.set("flags", [...state.flags].join(",")) : p.delete("flags")
  state.expanded ? p.set("expanded", "1") : p.delete("expanded")
  state.transpose ? p.delete("rows") : p.set("rows", "people")

  history.replaceState(null, "", url)
}

// header + controls
document.getElementById("title").textContent = data.project.name
// A project with neither a start nor a target date drops the range rather than printing "null → null".
function renderMeta() {
  const { start, target, url } = data.project
  const range = start || target ? `${start ?? "—"} → ${target ?? "—"} · ` : ""
  document.getElementById("meta").innerHTML = `${data.issues.length} issues · ${range}` +
    `<a href="${url}" target="_blank">Linear ↗</a>`
}
renderMeta()

wireProjectPicker(projects, currentProject)

// theme: applied from the shared appearance helper, so a choice made on Settings shows here too
applyTheme(loadTheme())

const search = document.getElementById("search")
search.value = state.q
search.oninput = () => {
  state.q = search.value.trim().toLowerCase()
  render()
}
const exp = document.getElementById("expand")
exp.setAttribute("aria-pressed", state.expanded)
exp.textContent = state.expanded ? "Compact" : "Expand"
exp.onclick = () => {
  state.expanded = !state.expanded
  exp.setAttribute("aria-pressed", state.expanded)
  exp.textContent = state.expanded ? "Compact" : "Expand"
  render()
}
const orient = document.getElementById("orient")
orient.setAttribute("aria-pressed", state.transpose)
orient.textContent = state.transpose ? "Rows: buckets" : "Rows: people"
orient.onclick = () => {
  state.transpose = !state.transpose
  orient.setAttribute("aria-pressed", state.transpose)
  orient.textContent = state.transpose ? "Rows: buckets" : "Rows: people"
  render()
}
const refreshBtn = document.getElementById("refresh")
refreshBtn.onclick = () => refresh()

// Paint a chip's pressed/unpressed look from its semantic color, so selected vs unselected reads
// clearly regardless of which color a status/bucket/flag happens to carry: unselected dims to plain
// gray text, selected gets full text plus a color-mix tint (never a solid fill, which would need a
// per-color contrast check we can't do from a CSS var string).
function paintChip(b, color, pressed) {
  const tint = color || "var(--accent)"
  b.style.color = pressed ? "var(--text)" : "var(--subtext0)"
  b.style.borderColor = pressed ? tint : ""
  b.style.background = pressed ? `color-mix(in srgb, ${tint} 22%, var(--mantle))` : ""
}

function chipButton(host, label, on, color, cls, toggle, onSolo) {
  const b = document.createElement("button")
  b.className = `chip ${cls || ""}`
  b.textContent = label
  b.setAttribute("aria-pressed", on)
  b.dataset.chipColor = color || ""
  paintChip(b, color, on)
  if (onSolo) b.title = "double-click to show only this"
  b.onclick = () => {
    const pressed = b.getAttribute("aria-pressed") !== "true"
    b.setAttribute("aria-pressed", pressed)
    paintChip(b, color, pressed)
    toggle(pressed)
    render()
  }
  if (onSolo) {
    b.ondblclick = () => {
      onSolo()
      syncChips()
      render()
    }
  }
  host.appendChild(b)
  return b
}

const statusChipEls = new Map()
function syncChips() {
  for (const [k, b] of statusChipEls) {
    const pressed = state.statuses.has(k)
    b.setAttribute("aria-pressed", pressed)
    paintChip(b, b.dataset.chipColor, pressed)
  }
}

const statusHost = document.getElementById("status-chips")
for (const [k, v] of Object.entries(STATUS)) {
  statusChipEls.set(
    k,
    chipButton(
      statusHost,
      v.label,
      state.statuses.has(k),
      v.color,
      "",
      (on) => on ? state.statuses.add(k) : state.statuses.delete(k),
      () => {
        const solo = state.statuses.size === 1 && state.statuses.has(k)
        state.statuses = new Set(solo ? DEFAULT_STATUSES : [k])
      },
    ),
  )
}
const cycleBuckets = buckets.filter((b) => b.kind !== "milestone")
const milestoneBuckets = buckets.filter((b) => b.kind === "milestone")
const knownBucketKeys = new Set(buckets.map((b) => b.key))

// One "Buckets" popover with two checkbox sections (Cycles, Milestones) instead of a chip row plus a
// separate milestone popover — a milestone without the "M1: " short-name convention has no compact
// form, so a chip-per-milestone row either overflows or shows the full name, and cycles/milestones are
// both just "which bucket columns show" so one control covers both.
function initBucketSelect() {
  const root = document.getElementById("bucket-select")
  const btn = document.getElementById("bsel-btn")
  const panel = document.getElementById("bsel-panel")
  const countEl = document.getElementById("bsel-count")
  const cycleList = document.getElementById("cycle-list")
  const mileList = document.getElementById("msel-list")
  const mileSearch = document.getElementById("msel-search")

  const displayName = (b) => b.name ?? b.label

  function syncButton() {
    const n = buckets.filter((b) => state.bucketKeys.has(b.key)).length
    const total = buckets.length
    countEl.hidden = n === total
    countEl.textContent = n === 0 ? "0" : `${n}/${total}`
    btn.setAttribute("aria-pressed", n !== total)
  }

  function renderChecklist(list, items, query) {
    const q = (query ?? "").trim().toLowerCase()
    const rows = items.filter((b) => !q || displayName(b).toLowerCase().includes(q))
    list.innerHTML = rows.length
      ? rows.map((b) => {
        const checked = state.bucketKeys.has(b.key)
        const name = escapeHtml(displayName(b))
        return `<li role="option" aria-selected="${checked}">` +
          `<label><input type="checkbox" data-key="${escapeHtml(b.key)}"${checked ? " checked" : ""} /> ` +
          `<span title="${name}">${name}</span></label></li>`
      }).join("")
      : `<li class="msel-empty">No matches</li>`
    for (const cb of list.querySelectorAll("input[type=checkbox]")) {
      cb.onchange = () => {
        if (cb.checked) state.bucketKeys.add(cb.dataset.key)
        else state.bucketKeys.delete(cb.dataset.key)
        syncButton()
        render()
      }
    }
  }

  function renderAll() {
    renderChecklist(cycleList, cycleBuckets)
    renderChecklist(mileList, milestoneBuckets, mileSearch.value)
  }

  function open() {
    panel.hidden = false
    btn.setAttribute("aria-expanded", "true")
    mileSearch.value = ""
    renderAll()
  }
  function close() {
    panel.hidden = true
    btn.setAttribute("aria-expanded", "false")
  }

  btn.onclick = () => (panel.hidden ? open() : close())
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !root.contains(e.target)) close()
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close()
  })
  mileSearch.oninput = () => renderChecklist(mileList, milestoneBuckets, mileSearch.value)

  const bulkToggle = (items, add) => () => {
    for (const b of items) add ? state.bucketKeys.add(b.key) : state.bucketKeys.delete(b.key)
    syncButton()
    renderAll()
    render()
  }
  document.getElementById("cycle-all").onclick = bulkToggle(cycleBuckets, true)
  document.getElementById("cycle-none").onclick = bulkToggle(cycleBuckets, false)
  document.getElementById("msel-all").onclick = bulkToggle(milestoneBuckets, true)
  document.getElementById("msel-none").onclick = bulkToggle(milestoneBuckets, false)
  syncButton()
}
initBucketSelect()

// Flags filter as a checklist popover, same shape as Buckets: a "Filter" button with an active count
// that opens a panel instead of a row of chips (only 3 flags, but keeping the pattern consistent).
function initFlagSelect() {
  const root = document.getElementById("flag-select")
  const btn = document.getElementById("fsel-btn")
  const panel = document.getElementById("fsel-panel")
  const countEl = document.getElementById("fsel-count")
  const list = document.getElementById("flag-list")

  function syncButton() {
    const n = state.flags.size
    countEl.hidden = n === 0
    countEl.textContent = n
    btn.setAttribute("aria-pressed", n > 0)
  }

  function renderList() {
    list.innerHTML = Object.entries(FLAGS).map(([k, label]) => {
      const checked = state.flags.has(k)
      return `<li role="option" aria-selected="${checked}">` +
        `<label><input type="checkbox" data-key="${k}"${checked ? " checked" : ""} /> ` +
        `<span>${label}</span></label></li>`
    }).join("")
    for (const cb of list.querySelectorAll("input[type=checkbox]")) {
      cb.onchange = () => {
        if (cb.checked) state.flags.add(cb.dataset.key)
        else state.flags.delete(cb.dataset.key)
        syncButton()
        render()
      }
    }
  }

  function open() {
    panel.hidden = false
    btn.setAttribute("aria-expanded", "true")
    renderList()
  }
  function close() {
    panel.hidden = true
    btn.setAttribute("aria-expanded", "false")
  }

  btn.onclick = () => (panel.hidden ? open() : close())
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !root.contains(e.target)) close()
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close()
  })
  syncButton()
}
initFlagSelect()

// Per-group bulk toggles so a wholesale change is one click, not one per chip.
function bulk(setState) {
  setState()
  syncChips()
  render()
}
document.getElementById("status-all").onclick = () => bulk(() => (state.statuses = new Set(Object.keys(STATUS))))
document.getElementById("status-none").onclick = () => bulk(() => (state.statuses = new Set()))

// interactive hover card (holds the not-slop action, so it must stay reachable)
const tip = document.getElementById("tip")
let hoverIssue = null
let hideTimer = null
// A what-if move form lives inside the tip, so while one is open the tip stops auto-hiding on
// mouseleave/blur (selecting naturally moves focus off the ticket and the mouse off the tip's original
// bounds) and hovering a different ticket is ignored instead of clobbering the open form. A real edit
// needs none of this: it opens the modal and the tip goes away.
let tipPinned = false
let mode = { demo: false, workspace: "live" }
fetch("/api/mode", { cache: "no-store" }).then((r) => r.ok && r.json()).then((m) => m && (mode = m))

function relText(i) {
  const parts = []
  if (i.blockedBy.length) parts.push(`blocked by ${i.blockedBy.join(", ")}`)
  if (i.blocks.length) parts.push(`blocks ${i.blocks.join(", ")}`)
  if (i.related.length) parts.push(`related ${i.related.join(", ")}`)
  return parts.join(" · ")
}
function showTip(e, i) {
  if (tipPinned) return
  const rel = relText(i)
  const mile = i.milestone || (i._bucket === "BACKLOG" ? "backlog" : i._bucket)
  tip.innerHTML = `<div class="tip-h"><b>${i.id}</b><span class="tip-pt">${i.estimate || "–"}pt</span></div>` +
    `<div class="tip-t">${escapeHtml(i.title)}</div>` +
    `<dl class="tip-meta">` +
    `<div><dt>Status</dt><dd>${STATUS[i.statusType]?.label ?? i.statusType}</dd></div>` +
    `<div><dt>Assignee</dt><dd>${escapeHtml(i.assignee)}</dd></div>` +
    `<div><dt>Milestone</dt><dd>${escapeHtml(mile)}</dd></div>` +
    (i.cycle ? `<div><dt>Cycle</dt><dd>${i.cycle}</dd></div>` : "") +
    (i.priority != null ? `<div><dt>Priority</dt><dd>${i.priority}</dd></div>` : "") +
    `</dl>` +
    (rel ? `<div class="tip-rel">${rel}</div>` : "") +
    (i._risk ? `<div class="tip-f risk">⛔ ordering risk: blocker finishes later</div>` : "") +
    (i._miss.blocking ? `<div class="tip-f miss">◑ in cycle, missing: ${i._miss.flags.join(", ")}</div>` : "") +
    (isSlop(i) || isDismissed(i)
      ? `<div class="tip-f slop">⚠ ${i._slop.flags.join(", ")}</div>` +
        `<button class="tip-act" data-act="slop">${isDismissed(i) ? "Re-flag as slop" : "Mark not slop"}</button>`
      : "") +
    `<button class="tip-act" data-act="edit">${whatIf.on ? "Move (what-if)" : "Edit"}</button>` +
    `<a class="tip-act tip-link" href="${i.url}" target="_blank">Open in Linear ↗</a>`
  const btn = tip.querySelector('[data-act="slop"]')
  if (btn) {
    btn.onclick = () => {
      toggleReviewed(i)
      hideTip()
    }
  }
  tip.querySelector('[data-act="edit"]').onclick = () => whatIf.on ? openTipMove(i) : openTipEdit(i)
  tip.style.display = "block"
  const w = tip.offsetWidth || 300, h = tip.offsetHeight || 120
  tip.style.left = `${Math.max(8, Math.min(e.clientX + 14, innerWidth - w - 8))}px`
  tip.style.top = `${Math.max(8, Math.min(e.clientY + 16, innerHeight - h - 8))}px`
}

// The form is much taller than a normal hover card, and showTip() only ever positioned for that
// smaller size — reclamp so the buttons can't land below the viewport.
function clampTip() {
  const left = parseFloat(tip.style.left) || 8
  const top = parseFloat(tip.style.top) || 8
  tip.style.left = `${Math.max(8, Math.min(left, innerWidth - tip.offsetWidth - 8))}px`
  tip.style.top = `${Math.max(8, Math.min(top, innerHeight - tip.offsetHeight - 8))}px`
}

// The hover card only launches the editor; the modal owns the edit from there, so the card can hide
// the moment it opens. Focus goes back to the ticket in the grid rather than to the card's own button,
// which is gone by then and gone again after an apply re-renders.
function openTipEdit(i) {
  if (whatIf.on) throw new Error("what-if mode never opens the real edit form")
  hideTip()
  openEditModal({
    dataFile: currentDataFile,
    issue: i,
    mode,
    onApplied: async () => await reloadFromFile(),
    returnFocus: () => nodeById.get(i.id),
    snapshot: data,
    source: "board",
  })
}

function selectHTML(name, pairs, selected) {
  const opts = pairs.map(([value, label]) =>
    `<option value="${escapeHtml(String(value))}"${String(value) === String(selected) ? " selected" : ""}>${
      escapeHtml(label)
    }</option>`
  ).join("")
  return `<select name="${name}">${opts}</select>`
}

// Only the fields a move actually changes, compared against the ticket as the simulation currently
// shows it, so re-opening the form and pressing Simulate without touching anything adds nothing.
function movePatch(form, cur) {
  const patch = {}
  const milestone = form.milestone.value || null
  if (milestone !== (cur.milestone ?? null)) patch.milestone = milestone
  const cycle = form.cycle.value === "" ? null : Number(form.cycle.value)
  if (cycle !== (cur.cycle ?? null)) patch.cycle = cycle
  const assignee = form.assignee.value
  if (assignee !== cur.assignee) patch.assignee = assignee
  return patch
}

// The hover card's Edit button in what-if mode: the same cycle/milestone/assignee grammar as the real
// edit form, routed to an overlay instead of /api/edit.
function openTipMove(i) {
  tipPinned = true
  tip.classList.add("tip-editing")
  const names = new Set(Object.keys(view.capacity?.roster ?? {}))
  if (i.assignee !== "Unassigned") names.add(i.assignee)
  tip.innerHTML = `<div class="tip-h"><b>${i.id}</b><span class="tip-pt">what-if move</span></div>` +
    `<form class="editf whatif-move" data-id="${escapeHtml(i.id)}">` +
    `<div class="editf-row">` +
    `<label>Milestone${
      selectHTML("milestone", [["", "— none —"], ...view.milestones.map((m) => [m.key, m.name])], i.milestone ?? "")
    }</label>` +
    `<label>Cycle${
      selectHTML("cycle", [["", "— none —"], ...view.cycles.map((c) => [c.n, `Cycle ${c.n}`])], i.cycle ?? "")
    }</label>` +
    `</div>` +
    `<label>Assignee${
      selectHTML("assignee", [["Unassigned", "Unassigned"], ...[...names].sort().map((n) => [n, n])], i.assignee)
    }</label>` +
    `<p class="editf-warn">Simulation only — this never reaches Linear.</p>` +
    `<div class="editf-actions">` +
    `<button type="button" class="chip" data-act="simulate">Simulate move</button>` +
    `<button type="button" class="chip ghost" data-act="cancel">Cancel</button>` +
    `</div></form>`
  clampTip()
  const form = tip.querySelector("form.whatif-move")
  const unpin = () => {
    tipPinned = false
    hideTip()
  }
  form.querySelector('[data-act="simulate"]').onclick = () => {
    const patch = movePatch(form, i)
    unpin()
    if (Object.keys(patch).length) addOverlay({ kind: "scope", id: i.id, patch })
  }
  form.querySelector('[data-act="cancel"]').onclick = unpin
}

function hideTip() {
  if (tipPinned) return
  tip.style.display = "none"
  tip.classList.remove("tip-editing")
  if (hoverIssue) hoverDeps(hoverIssue, false)
  hoverIssue = null
}
tip.onmouseenter = () => clearTimeout(hideTimer)
tip.onmouseleave = () => hideTip()
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && tipPinned) {
    tipPinned = false
    hideTip()
  }
  if (e.key === "Escape" && !ovPopup.hidden) closeOvPopup()
})

// On-call/out-days editing, right on the board: click an existing 📟/🧳 badge to edit that person's
// cycle entry, or right-click anywhere else in an eligible cell to add one. Replaces the old Settings
// "Calendar overrides" form/page (a big per-person/per-cycle grid of inputs for something a refresh
// mostly fills in anyway) with editing exactly where the data already shows.
const ovPopup = document.getElementById("ov-popup")

function ovEntry(name, cycleN) {
  return view.capacity?.people?.[name]?.cycles?.[cycleN] ?? {}
}

function openOvPopup(name, cycleN, x, y) {
  const entry = ovEntry(name, cycleN)
  // In what-if mode the same popup writes an overlay instead of the stored capacity block. "Locked"
  // is dropped there: it governs what a refresh may overwrite, which a simulation never reaches.
  const sim = whatIf.on
  ovPopup.innerHTML = `<h4>${sim ? "What-if · " : ""}${escapeHtml(name)} · Cycle ${cycleN}</h4>` +
    `<label><input type="checkbox" id="ov-oncall" ${entry.oncall ? "checked" : ""} /> On-call</label>` +
    `<label>Out days<input type="number" id="ov-outdays" min="0" value="${entry.outDays ?? ""}" /></label>` +
    `<label>Reason<input type="text" id="ov-reason" value="${escapeHtml(entry.reason ?? "")}" /></label>` +
    (sim
      ? ""
      : `<label><input type="checkbox" id="ov-locked" ${
        entry.locked ? "checked" : ""
      } /> Locked (a refresh won't overwrite)</label>`) +
    `<div class="ov-popup-actions">` +
    `<button type="button" class="chip mini" data-act="save">${sim ? "Simulate" : "Save"}</button>` +
    `<button type="button" class="chip mini ghost" data-act="delete">Clear</button>` +
    `<button type="button" class="chip mini ghost" data-act="cancel">Cancel</button>` +
    `</div>`
  ovPopup.hidden = false
  const w = ovPopup.offsetWidth, h = ovPopup.offsetHeight
  ovPopup.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`
  ovPopup.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`

  const save = (patch) => sim ? simulateOverride(name, cycleN, patch) : saveOverride(name, cycleN, patch)
  ovPopup.querySelector('[data-act="save"]').onclick = () => {
    const outDays = ovPopup.querySelector("#ov-outdays").value
    save({
      oncall: ovPopup.querySelector("#ov-oncall").checked ? true : null,
      outDays: outDays === "" ? null : Number(outDays),
      reason: ovPopup.querySelector("#ov-reason").value.trim() || null,
      ...(sim ? {} : { locked: ovPopup.querySelector("#ov-locked").checked ? true : null }),
    })
  }
  ovPopup.querySelector('[data-act="delete"]').onclick = () =>
    save({ oncall: null, outDays: null, reason: null, ...(sim ? {} : { locked: null }) })
  ovPopup.querySelector('[data-act="cancel"]').onclick = closeOvPopup
}

function closeOvPopup() {
  ovPopup.hidden = true
}

function simulateOverride(name, cycleN, patch) {
  closeOvPopup()
  addOverlay({ kind: "capacity", person: name, cycle: cycleN, patch })
}

async function saveOverride(name, cycleN, patch) {
  if (whatIf.on) throw new Error("what-if mode never writes a real on-call/out-days override")
  const capacity = setPersonCycle(data.capacity, name, cycleN, patch)
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataFile: currentDataFile, capacity }),
    })
    if (!res.ok) throw new Error(`save failed: ${res.status} ${res.statusText}`)
    data.capacity = capacity
    closeOvPopup()
    recompute()
    render()
  } catch (err) {
    showError(err, "Saving the on-call/out-days override failed")
  }
}

document.addEventListener("click", (e) => {
  const badge = e.target.closest(".cf.oncall, .cf.out")
  if (badge) {
    const td = badge.closest("td[data-name]")
    if (td) openOvPopup(td.dataset.name, td.dataset.cycle, e.clientX, e.clientY)
    return
  }
  if (!ovPopup.hidden && !ovPopup.contains(e.target)) closeOvPopup()
})
document.addEventListener("contextmenu", (e) => {
  const td = e.target.closest("td[data-name]")
  if (!td || e.target.closest(".cf.oncall, .cf.out")) return
  e.preventDefault()
  openOvPopup(td.dataset.name, td.dataset.cycle, e.clientX, e.clientY)
})

// What-if mode. The toggle and its banner are built here rather than in the board template so the
// mode's chrome ships with the code that owns it. Both entry points into a simulation are the ones
// the board already has: the 📟/🧳 badge (or a right-click on a cycle cell) for a person's on-call and
// out-days, and the hover card's Edit button for moving a ticket.
function initWhatIf() {
  const btn = document.createElement("button")
  btn.id = "whatif-btn"
  btn.type = "button"
  btn.className = "chip"
  btn.textContent = "What-if"
  btn.title = "Simulate PTO or a scope move without writing anything"
  btn.setAttribute("aria-pressed", "false")
  btn.onclick = () => setWhatIf(!whatIf.on)
  const controls = document.querySelector(".bar-controls")
  controls.insertBefore(btn, document.querySelector(".sync-box"))

  const bar = document.createElement("div")
  bar.id = "whatif-bar"
  bar.className = "whatif-bar"
  bar.hidden = true
  bar.setAttribute("role", "status")
  bar.innerHTML = `<div class="whatif-head">` +
    `<span class="whatif-tag">What-if</span>` +
    `<span class="whatif-note">Simulated forecast. Nothing here is written to Linear.</span>` +
    `<span class="whatif-count" id="whatif-count"></span>` +
    `<button type="button" class="chip mini" id="whatif-reset">Reset</button>` +
    `<button type="button" class="chip mini" id="whatif-exit">Exit what-if</button>` +
    `</div><div id="whatif-forecast"></div>`
  const freshness = document.getElementById("freshness")
  freshness.parentNode.insertBefore(bar, freshness.nextSibling)
  bar.querySelector("#whatif-reset").onclick = () => {
    whatIf.overlays = []
    refreshWhatIf()
  }
  bar.querySelector("#whatif-exit").onclick = () => setWhatIf(false)
}

function setWhatIf(on) {
  whatIf.on = on
  whatIf.overlays = []
  document.getElementById("whatif-btn").setAttribute("aria-pressed", String(on))
  document.body.classList.toggle("whatif-on", on)
  closeOvPopup()
  tipPinned = false
  hideTip()
  refreshWhatIf()
}

function addOverlay(overlay) {
  whatIf.overlays = [...whatIf.overlays, overlay]
  refreshWhatIf()
}

// A bad overlay must not strand the board on a half-built view, so a failed recompute drops the whole
// stack, reports it, and falls back to the real snapshot.
function refreshWhatIf() {
  try {
    recompute()
  } catch (err) {
    whatIf.overlays = []
    showError(err, "The what-if simulation failed")
    recompute()
  }
  adoptNewBuckets()
  renderWhatIf()
  render()
}

function shiftHTML(shiftDays) {
  if (shiftDays === 0) return `<span class="fc same">no change</span>`
  const late = shiftDays > 0
  return `<span class="fc ${late ? "late" : "early"}">${late ? "▲" : "▼"} ${Math.abs(shiftDays)}d ${
    late ? "later" : "earlier"
  }</span>`
}

// Two colorings, two questions: the landing cell carries the board's usual slip styling (how the
// simulated date sits against the milestone's target), the shift cell how it moved from the baseline.
function forecastRowHTML(m) {
  const landingCls = m.status === "at-risk" ? "late" : m.status === "ahead" ? "early" : ""
  return `<tr><th scope="row" title="${escapeHtml(m.name || m.key)}">${
    escapeHtml(milestoneDisplayName(m.name, m.key))
  }</th>` +
    `<td>${m.target}</td><td>${m.baselineLanding}</td>` +
    `<td class="${landingCls}" title="${forecastPhrase(m)} against the target">${m.landing}</td>` +
    `<td>${shiftHTML(m.shiftDays)}</td></tr>`
}

function forecastTableHTML() {
  const rows = plan?.milestones ?? []
  if (!rows.length) return `<p class="whatif-empty">This project has no milestones to forecast.</p>`
  return `<table class="whatif-table">` +
    `<caption>Forecast, not a real date: landings derived from remaining points and team throughput.</caption>` +
    `<thead><tr><th>Milestone</th><th>Target</th><th>Baseline lands</th><th>What-if lands</th><th>Shift</th></tr>` +
    `</thead><tbody>${rows.map(forecastRowHTML).join("")}</tbody></table>`
}

function renderWhatIf() {
  const bar = document.getElementById("whatif-bar")
  bar.hidden = !whatIf.on
  if (!whatIf.on) return
  const n = whatIf.overlays.length
  document.getElementById("whatif-count").textContent = n === 0
    ? "no overlays yet — click a 📟/🧳 badge, right-click a cycle cell, or use a ticket's Move button"
    : `${n} overlay${n === 1 ? "" : "s"}`
  document.getElementById("whatif-forecast").innerHTML = forecastTableHTML()
}
initWhatIf()

function passes(i) {
  if (!state.statuses.has(i.statusType)) return false
  if (!state.bucketKeys.has(i._bucket)) return false
  if (state.q && !(`${i.id} ${i.title} ${i.description}`.toLowerCase().includes(state.q))) return false
  for (const f of state.flags) {
    if (f === "slop" && !isSlop(i)) return false
    if (f === "risk" && !i._risk) return false
    if (f === "miss" && !i._miss.blocking) return false
  }
  return true
}

const nodeById = new Map()
function hoverDeps(i, on) {
  const rel = new Set([i.id, ...i.blockedBy, ...i.blocks])
  for (const [id, el] of nodeById) {
    el.classList.toggle("hl", on && rel.has(id) && id !== i.id)
    el.classList.toggle("dim", on && !rel.has(id))
  }
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}

function warnClass(i) {
  if (i._risk) return "w-risk"
  if (isSlop(i)) return "w-slop"
  if (i._miss.blocking) return "w-miss"
  return ""
}

// Effective capacity for a person in a bucket. Cycles carry on-call and time-off deflation;
// milestones size off base velocity across their weeks (no near-term calendar events applied).
function cellCapacity(person, b) {
  if (person === "Unassigned" || b.key === "C47" || b.kind === "backlog") return { points: null, factors: [] }
  if (b.kind === "cycle") return personCycleCapacity(person, parseInt(b.key.slice(1), 10), view.capacity)
  const base = personCycleCapacity(person, null, view.capacity).base
  return { points: Math.round(base * bucketWeeks[b.key]), factors: [] }
}

function capFootHTML(factors, capacity, load) {
  const parts = factors.map((f) =>
    f.kind === "oncall"
      ? `<span class="cf oncall"><span class="ico">📟</span> on-call</span>`
      : `<span class="cf out"><span class="ico">🧳</span> ${escapeHtml(f.reason)} ${f.days}d</span>`
  )
  if (capacity != null && load > capacity) parts.push(`<span class="cf over">over +${load - capacity}</span>`)
  return parts.length ? `<div class="capfoot">${parts.join("")}</div>` : ""
}

let passesShown = new Set()
function cellHTML(person, b) {
  const items = view.issues.filter((i) => passesShown.has(i) && i.assignee === person && i._bucket === b.key)
    .sort((a, x) => statusRank(a.statusType) - statusRank(x.statusType) || x.estimate - a.estimate)
  const load = items.reduce((s, i) => s + i.estimate, 0)
  const cls = b.key === "C47" ? "past" : (b.kind === "cycle" ? "now" : "")
  const { points: capacity, factors } = cellCapacity(person, b)
  let heat = ""
  if (capacity && load > 0) {
    const ratio = load / capacity
    const zone = ratio <= 0.8 ? "ok" : ratio <= 1.05 ? "warn" : "over"
    heat = `<div class="heat" style="background:${
      zone === "over" ? "rgba(220,38,38,.16)" : zone === "warn" ? "rgba(217,119,6,.13)" : "rgba(22,163,74,.09)"
    }"></div>`
  }
  const foot = capFootHTML(factors, capacity, load)
  // Only a real (non-Unassigned) person's active-cycle cell has an on-call/out-days override to edit —
  // matches cellCapacity's own eligibility so a data-name/data-cycle attribute never points at a cell
  // that can't actually carry one.
  const editable = person !== "Unassigned" && b.kind === "cycle" && b.key !== "C47"
  const ovAttrs = editable ? ` data-name="${escapeHtml(person)}" data-cycle="${b.key.slice(1)}"` : ""
  return `<td class="${cls}" data-load="${load}" data-cap="${
    capacity ?? ""
  }"${ovAttrs}>${heat}<div class="cellbody">${foot}${renderItems(items)}</div></td>`
}

function render() {
  syncUrl()
  const wrap = document.querySelector(".wrap")
  const sx = wrap ? wrap.scrollLeft : 0, sy = wrap ? wrap.scrollTop : 0
  const shown = view.issues.filter(passes)
  passesShown = new Set(shown)
  // A bucket selected in the filter can still have zero issues once status/search/flag filters also
  // apply — hide it from the grid too, the same way an assignee with nothing currently shown already
  // drops out of `people` below, rather than leaving an empty column/row for whatever's selected.
  const visible = buckets.filter((b) => state.bucketKeys.has(b.key) && shown.some((i) => i._bucket === b.key))
  const people = [...new Set(shown.map((i) => i.assignee))].sort((a, b) =>
    (a === "Unassigned") - (b === "Unassigned") || a.localeCompare(b)
  )
  nodeById.clear()

  const act = shown.filter((i) => i.statusType !== "completed" && i.statusType !== "canceled")
  document.getElementById("summary").innerHTML = [
    `<span><b>${shown.length}</b> shown</span>`,
    `<span><b>${act.reduce((s, i) => s + i.estimate, 0)}</b> pts active</span>`,
    `<span><b>${
      shown.filter((i) => i.assignee === "Unassigned").reduce((s, i) => s + i.estimate, 0)
    }</b> pts unassigned</span>`,
    `<span style="color:var(--slop)"><b>${shown.filter(isSlop).length}</b> slop</span>`,
    `<span style="color:var(--risk)"><b>${shown.filter((i) => i._risk).length}</b> ordering risk</span>`,
    `<span style="color:var(--miss)"><b>${shown.filter((i) => i._miss.blocking).length}</b> missing-in-cycle</span>`,
  ].join("")

  const grid = document.getElementById("grid")
  grid.className = state.transpose ? "transposed" : ""
  grid.innerHTML = state.transpose ? buildTransposed(people, visible) : buildBoard(people, visible)
  wireNodes(grid)
  if (wrap) {
    wrap.scrollLeft = sx
    wrap.scrollTop = sy
  }
}

function buildBoard(people, visible) {
  const nCyc = visible.filter((b) => b.kind === "cycle").length
  const nMile = visible.filter((b) => b.kind === "milestone").length
  const nBack = visible.filter((b) => b.kind === "backlog").length
  let h = "<thead><tr class='grp'><th></th>"
  if (nCyc) h += `<th colspan="${nCyc}">Now · cycles</th>`
  if (nMile) h += `<th colspan="${nMile}">Horizon · milestones</th>`
  if (nBack) h += `<th>Unscheduled</th>`
  h += "</tr><tr class='col'><th>Assignee</th>"
  for (const b of visible) h += bucketTh(b)
  h += "</tr></thead><tbody>"
  for (const person of people) {
    h += `<tr><th>${escapeHtml(person)}${personPts(person)}</th>`
    for (const b of visible) h += cellHTML(person, b)
    h += "</tr>"
  }
  return `${h}</tbody>`
}

function buildTransposed(people, visible) {
  let h = "<thead><tr class='col'><th>Bucket</th>"
  for (const person of people) h += `<th>${escapeHtml(person)}${personPts(person)}</th>`
  h += "</tr></thead><tbody>"
  for (const b of visible) {
    const kindTag = b.kind === "cycle" ? "now" : b.kind === "milestone" ? "horizon" : "backlog"
    h += `<tr><th class="rowhead ${kindTag}" data-key="${b.key}" title="${escapeHtml(bucketDetail(b))}">` +
      `<span class="mlabel">${escapeHtml(b.label)}</span>` +
      `<span class="s">${bucketSub(b)}</span>${forecastBadge(b)}</th>`
    for (const person of people) h += cellHTML(person, b)
    h += "</tr>"
  }
  return `${h}</tbody>`
}

function nodeLabel(i) {
  const st = STATUS[i.statusType]?.label ?? i.statusType
  const flags = [i._risk && "ordering risk", isSlop(i) && "slop", i._miss.blocking && "missing data"].filter(Boolean)
  return `${i.id}: ${i.title}. ${st}, ${i.assignee}, ${i.estimate || "no"} points` +
    (flags.length ? `. Flags: ${flags.join(", ")}` : "")
}

function showTipForEl(el, i) {
  const r = el.getBoundingClientRect()
  showTip({ clientX: r.left, clientY: r.bottom - 8 }, i)
}

// roving tabindex: only one grid node is tab-reachable at a time; arrows move focus between them
function focusNode(el, nodes) {
  for (const n of nodes) n.tabIndex = -1
  el.tabIndex = 0
  el.focus()
}

function arrowTarget(key, el, nodes) {
  const idx = nodes.indexOf(el)
  if (key === "ArrowRight") return nodes[idx + 1] ?? null
  if (key === "ArrowLeft") return nodes[idx - 1] ?? null
  if (key !== "ArrowDown" && key !== "ArrowUp") return null
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  let best = null, bestScore = Infinity
  for (const n of nodes) {
    if (n === el) continue
    const nr = n.getBoundingClientRect()
    const dy = nr.top + nr.height / 2 - cy
    if (key === "ArrowDown" && dy <= 4) continue
    if (key === "ArrowUp" && dy >= -4) continue
    const score = Math.abs(dy) * 2 + Math.abs(nr.left + nr.width / 2 - cx)
    if (score < bestScore) {
      bestScore = score
      best = n
    }
  }
  return best
}

function onGridKey(e, nodes) {
  const el = document.activeElement
  if (!el?.hasAttribute?.("data-id")) return
  const i = byId[el.getAttribute("data-id")]
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    globalThis.open(i.url, "_blank")
    return
  }
  if (e.key === "Escape") {
    hideTip()
    el.blur()
    return
  }
  if (e.key === "s" && (isSlop(i) || isDismissed(i))) {
    e.preventDefault()
    toggleReviewed(i)
    return
  }
  const target = arrowTarget(e.key, el, nodes)
  if (target) {
    e.preventDefault()
    focusNode(target, nodes)
  }
}

function wireNodes(container) {
  const nodes = [...container.querySelectorAll("[data-id]")]
  nodes.forEach((el, idx) => {
    const i = byId[el.getAttribute("data-id")]
    nodeById.set(i.id, el)
    el.tabIndex = idx === 0 ? 0 : -1
    el.setAttribute("role", "button")
    el.setAttribute("aria-label", nodeLabel(i))
    el.addEventListener("mouseenter", (e) => {
      if (tipPinned) return
      clearTimeout(hideTimer)
      hoverIssue = i
      showTip(e, i)
      hoverDeps(i, true)
    })
    el.addEventListener("mouseleave", () => {
      hideTimer = setTimeout(hideTip, 160)
    })
    el.addEventListener("focus", () => {
      if (tipPinned) return
      clearTimeout(hideTimer)
      hoverIssue = i
      showTipForEl(el, i)
      hoverDeps(i, true)
    })
    el.addEventListener("blur", () => {
      hideTimer = setTimeout(hideTip, 160)
    })
  })
  container.onkeydown = (e) => onGridKey(e, nodes)
}

function personPts(person) {
  let pts = 0
  for (const i of passesShown) if (i.assignee === person) pts += i.estimate
  return `<span class="pl"> ${pts}pt</span>`
}
// Visible sub-line under cycle/backlog headers. Milestones carry no sub: their label is the (truncated)
// name, and target, progress, and forecast all live in the hover.
function bucketSub(b) {
  return b.kind === "milestone" ? "" : b.sub
}
// How the forecast landing compares to the target, in words, for the hover.
function forecastPhrase(fc) {
  if (fc.status === "on-track") return "on track"
  return fc.slipDays > 0 ? `${fc.slipDays}d late` : `${-fc.slipDays}d early`
}
// Full detail for the hover title. For milestones the full (untruncated) name leads, then target,
// progress, and the forecast landing.
function bucketDetail(b) {
  if (b.kind !== "milestone") return `${b.label} · ${b.sub}`
  const parts = [b.name || b.label, b.sub]
  if (b.progress != null) parts.push(`${Math.round(b.progress)}%`)
  const fc = forecastByKey?.[b.key]
  if (fc) parts.push(`forecast lands ${fc.landing} (${forecastPhrase(fc)})`)
  return parts.join(" · ")
}
// A compact forecast marker under a milestone header, only when the landing deviates from the target.
function forecastBadge(b) {
  const fc = b.kind === "milestone" ? forecastByKey?.[b.key] : null
  if (!fc || fc.status === "on-track") return ""
  const cls = fc.status === "at-risk" ? "late" : "early"
  const glyph = fc.status === "at-risk" ? "▲" : "▼"
  return `<span class="fc ${cls}">${glyph} ~${Math.abs(fc.slipDays)}d</span>`
}
function bucketTh(b) {
  const title = escapeHtml(bucketDetail(b))
  if (b.kind === "milestone") {
    return `<th class="mile" data-key="${b.key}" title="${title}"><span class="mlabel">${escapeHtml(b.label)}</span>${
      forecastBadge(b)
    }</th>`
  }
  return `<th data-key="${b.key}" title="${title}">${b.label}<span class="s">${bucketSub(b)}</span></th>`
}

function flagBadges(i) {
  let s = ""
  if (i._risk) s += `<span class="badge risk"><span class="ico">⛔</span></span>`
  if (isSlop(i)) s += `<span class="badge slop"><span class="ico">⚠</span>${i._slop.score}</span>`
  if (i._miss.blocking) s += `<span class="badge miss"><span class="ico">◑</span></span>`
  return s
}

// Compact-pill label: a leading flag glyph (so a flag reads even without color), the ticket number,
// and the estimate as "·N" — the only room a pill this small has for a second data point.
// The pill's width already encodes estimate magnitude (see min-width below), and a numeric "·N" suffix
// crammed into a 10px pill was unreadable and redundant with that. The flag glyph is the second signal
// a pill this small has room for; the exact estimate lives in the hover tip.
function tickLabel(i) {
  // Full id (including the team prefix), not just the number — with more than one project in view
  // over time, a bare number is ambiguous about which project's ticket it is.
  const flag = i._risk ? "⛔" : isSlop(i) ? "⚠" : i._miss.blocking ? "◑" : ""
  return `${flag ? `<span class="ico">${flag}</span>` : ""}${escapeHtml(i.id)}`
}

function renderItems(items) {
  if (!state.expanded) {
    return `<div class="ticks">${
      items.map((i) => {
        const st = STATUS[i.statusType]
        return `<span class="tick ${warnClass(i)}" data-id="${i.id}" onclick="window.open('${i.url}','_blank')" ` +
          `style="min-width:${20 + i.estimate * 5}px;background:${st?.color};color:${st?.fg}">${tickLabel(i)}</span>`
      }).join("")
    }</div>`
  }
  return `<div class="cards">${
    items.map((i) =>
      `<div class="card ${warnClass(i)}" data-id="${i.id}" onclick="window.open('${i.url}','_blank')" ` +
      `style="border-left-color:${STATUS[i.statusType]?.color}">` +
      `<div class="top"><span class="id">${i.id.replace(/^[A-Z]+-/, "")}</span>` +
      `<span class="badges">${flagBadges(i)}</span>` +
      `<span class="pts">${i.estimate || "–"}</span></div>` +
      `<div class="t">${escapeHtml(i.title)}</div></div>`
    ).join("")
  }</div>`
}

// Re-reads the project's data file and re-renders, without touching Linear — used by the quiet
// 5-minute poll (which only wants to pick up a file some other process already wrote) and as the
// second half of a live refresh below.
async function reloadFromFile() {
  const fresh = await loadData()
  data.issues = fresh.issues
  data.milestones = fresh.milestones
  data.cycles = fresh.cycles
  data.asOf = fresh.asOf
  data.currentCycle = fresh.currentCycle
  data.project = fresh.project
  data.capacity = fresh.capacity
  recompute()
  adoptNewBuckets()
  loadedAt = new Date()
  renderMeta()
  renderWhatIf()
  render()
}

// A bucket column that appears after the first load (a new cycle, or one a what-if move just put work
// into) starts visible rather than silently filtered out.
function adoptNewBuckets() {
  for (const k of buckets.map((b) => b.key)) {
    if (!knownBucketKeys.has(k)) {
      state.bucketKeys.add(k)
      knownBucketKeys.add(k)
    }
  }
}

// The Refresh button: re-ingests from Linear/Incident.io/Google Calendar (the same POST /api/refresh
// Settings' "Refresh all" uses) before reloading, so it actually pulls current data instead of only
// re-reading the same local file the board already had — which looked like it worked (the "loaded"
// time bumped) without ever changing anything.
async function refresh() {
  refreshBtn.disabled = true
  refreshBtn.textContent = "Refreshing…"
  try {
    const res = await fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataFile: currentDataFile }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.ok) {
      const detail = body?.error ?? `${res.status} ${res.statusText}`
      const log = body?.log?.length ? `\n${body.log.join("\n")}` : ""
      throw new Error(`${detail}${log}`)
    }
    await reloadFromFile()
  } catch (err) {
    showError(err, "Refresh failed")
  } finally {
    refreshBtn.disabled = false
    refreshBtn.textContent = "Refresh"
    updateSync()
  }
}

function pad(n) {
  return String(n).padStart(2, "0")
}
// a snapshot older than this many days gets a visible staleness banner
const STALE_DAYS = 2
function dataAgeDays() {
  const asOf = new Date(data.asOf)
  if (Number.isNaN(asOf.getTime())) return null
  return Math.floor((Date.now() - asOf.getTime()) / 86400000)
}
function ageLabel(days) {
  if (days == null) return ""
  if (days <= 0) return "today"
  return days === 1 ? "1 day old" : `${days} days old`
}
function updateSync() {
  const days = dataAgeDays()
  const age = days != null && days > 0 ? ` · ${ageLabel(days)}` : ""
  document.getElementById("sync").textContent = `data as of ${data.asOf}${age} · loaded ${pad(loadedAt.getHours())}:${
    pad(loadedAt.getMinutes())
  }`
  updateFreshness(days)
}
// Banner above the board: loud when we're showing the bundled sample instead of real data,
// softer when a real snapshot has gone stale. Silent when data is fresh.
function updateFreshness(days = dataAgeDays()) {
  const el = document.getElementById("freshness")
  if (!el) return
  if (isSampleData) {
    el.className = "freshness sample"
    el.textContent = `Showing sample data — no live snapshot for “${data.project?.name ?? currentDataFile}” yet. ` +
      `Run a refresh or “deno task issues” to pull real tickets.`
    el.hidden = false
  } else if (days != null && days >= STALE_DAYS) {
    el.className = "freshness stale"
    el.textContent = `This snapshot is ${ageLabel(days)} (as of ${data.asOf}). Refresh for current data.`
    el.hidden = false
  } else {
    el.hidden = true
  }
}

// auto-refresh every 5 minutes; only re-renders if the payload changed, keeping filters intact
let lastPayload = JSON.stringify(data.issues)
setInterval(async () => {
  const fresh = await loadData().catch(() => null)
  if (!fresh) return
  const sig = JSON.stringify(fresh.issues)
  if (sig !== lastPayload) {
    lastPayload = sig
    await reloadFromFile()
  }
}, 300000)

updateSync()
render()

// Land on the current cycle instead of the leftmost/topmost bucket — with many past cycles that still
// carry tickets (see buildBuckets), "today" can otherwise be scrolled well out of view on first load.
// Only runs once: render() already preserves scroll position across re-renders on its own.
if (data.currentCycle != null) {
  const key = `C${data.currentCycle}`
  const target = document.querySelector(`[data-key="${key}"]`)
  target?.scrollIntoView({ block: "nearest", inline: "nearest" })
}
