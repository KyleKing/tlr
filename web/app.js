import {
  bucketOf,
  buildBuckets,
  dependencyWaves,
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
import { pickProject } from "./lib/issues.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"
import { wireProjectPicker } from "./lib/nav.js"

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

function deriveBuckets() {
  buckets = buildBuckets(data, data.issues)
  bucketByKey = Object.fromEntries(buckets.map((b) => [b.key, b]))
  forecastByKey = Object.fromEntries(
    milestoneForecast(data, teamWeeklyThroughput(data)).milestones.map((m) => [m.key, m]),
  )
  bucketWeeks = {}
  data.milestones.forEach((m, idx) => {
    const start = idx === 0
      ? data.asOf
      : (new Date(data.asOf) > new Date(data.milestones[idx - 1].target) ? data.asOf : data.milestones[idx - 1].target)
    bucketWeeks[m.key] = Math.max(0.5, weeksBetween(start, m.target))
  })
  for (const b of buckets) if (b.kind === "cycle") bucketWeeks[b.key] = 1
  bucketWeeks.BACKLOG = Infinity
}

function enrich() {
  for (const i of data.issues) {
    i.blocks ||= []
    i.blockedBy ||= []
    i.related ||= []
    i._bucket = bucketOf(i)
    i._bucketEnd = (bucketByKey[i._bucket] || { end: "9999-12-31" }).end
    i._slop = slopScan(i.description)
    i._slopHash = slopHash(i.description)
    i._miss = missingData(i)
  }
  riskIds = new Set(orderingRisks(data.issues).flatMap((r) => [r.issue, r.blocker]))
  for (const i of data.issues) i._risk = riskIds.has(i.id) && (i.blockedBy.length > 0)
  byId = Object.fromEntries(data.issues.map((i) => [i.id, i]))
}

async function loadProjects() {
  const r = await fetch("/data/projects.json", { cache: "no-store" })
  return r.ok ? r.json() : []
}

let currentDataFile = "cpu.json"
// true when the project's own data file was missing and we fell back to the bundled sample
let isSampleData = false

async function loadData(dataFile = currentDataFile) {
  currentDataFile = dataFile
  const r = await fetch(`/data/${dataFile}`, { cache: "no-store" })
  isSampleData = !r.ok
  return (r.ok ? r : await fetch("/data-sample.json", { cache: "no-store" })).json()
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
  transpose: false,
  view: "board", // or "timeline"
}

const projects = await loadProjects()
const requestedSlug = new URLSearchParams(location.search).get("project")
const currentProject = pickProject(projects, requestedSlug)
const data = await loadData(currentProject?.dataFile)
deriveBuckets()
enrich()
state.bucketKeys = new Set(buckets.map((b) => b.key))
let loadedAt = new Date()

// header + controls
document.getElementById("title").textContent = data.project.name
function renderMeta() {
  document.getElementById("meta").innerHTML =
    `${data.issues.length} issues · ${data.project.start} → ${data.project.target} · ` +
    `<a href="${data.project.url}" target="_blank">Linear ↗</a>`
}
renderMeta()

wireProjectPicker(projects, currentProject)

// theme: applied from the shared appearance helper, so a choice made on Settings shows here too
applyTheme(loadTheme())

const search = document.getElementById("search")
search.oninput = () => {
  state.q = search.value.trim().toLowerCase()
  render()
}
const exp = document.getElementById("expand")
exp.onclick = () => {
  state.expanded = !state.expanded
  exp.setAttribute("aria-pressed", state.expanded)
  exp.textContent = state.expanded ? "Compact" : "Expand"
  render()
}
const orient = document.getElementById("orient")
orient.onclick = () => {
  state.transpose = !state.transpose
  orient.setAttribute("aria-pressed", state.transpose)
  orient.textContent = state.transpose ? "Rows: buckets" : "Rows: people"
  render()
}
const viewBtn = document.getElementById("view")
viewBtn.onclick = () => {
  state.view = state.view === "board" ? "timeline" : "board"
  viewBtn.setAttribute("aria-pressed", state.view === "timeline")
  const board = state.view === "board"
  exp.hidden = orient.hidden = !board
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
const bucketChipEls = new Map()
function syncChips() {
  for (const [k, b] of statusChipEls) {
    const pressed = state.statuses.has(k)
    b.setAttribute("aria-pressed", pressed)
    paintChip(b, b.dataset.chipColor, pressed)
  }
  for (const [k, b] of bucketChipEls) {
    const pressed = state.bucketKeys.has(k)
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

const bucketHost = document.getElementById("bucket-chips")
for (const b of cycleBuckets) {
  bucketChipEls.set(
    b.key,
    chipButton(
      bucketHost,
      b.label.replace("Cycle ", "C"),
      true,
      "",
      "",
      (on) => on ? state.bucketKeys.add(b.key) : state.bucketKeys.delete(b.key),
      () => {
        const solo = state.bucketKeys.size === 1 && state.bucketKeys.has(b.key)
        state.bucketKeys = new Set(solo ? buckets.map((x) => x.key) : [b.key])
      },
    ),
  )
}

// Milestone filter: a searchable multi-select instead of one chip per milestone. A milestone without
// the "M1: " naming convention has no short form, so a chip-per-milestone row either overflows or
// shows the full name — this scales to any name length and any milestone count.
function initMilestoneSelect() {
  const root = document.getElementById("milestone-select")
  const btn = document.getElementById("msel-btn")
  const panel = document.getElementById("msel-panel")
  const search = document.getElementById("msel-search")
  const list = document.getElementById("msel-list")
  const countEl = document.getElementById("msel-count")
  if (!milestoneBuckets.length) {
    root.hidden = true
    return
  }

  const displayName = (b) => b.name ?? b.label

  function syncButton() {
    const n = milestoneBuckets.filter((b) => state.bucketKeys.has(b.key)).length
    const total = milestoneBuckets.length
    countEl.hidden = n === total
    countEl.textContent = n === 0 ? "0" : `${n}/${total}`
    btn.setAttribute("aria-pressed", n !== total)
  }

  function renderList() {
    const q = search.value.trim().toLowerCase()
    const rows = milestoneBuckets.filter((b) => !q || displayName(b).toLowerCase().includes(q))
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

  function open() {
    panel.hidden = false
    btn.setAttribute("aria-expanded", "true")
    renderList()
    search.value = ""
    search.focus()
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
  search.oninput = renderList
  document.getElementById("msel-all").onclick = () => {
    for (const b of milestoneBuckets) state.bucketKeys.add(b.key)
    syncButton()
    renderList()
    render()
  }
  document.getElementById("msel-none").onclick = () => {
    for (const b of milestoneBuckets) state.bucketKeys.delete(b.key)
    syncButton()
    renderList()
    render()
  }
  syncButton()
}
initMilestoneSelect()
const flagHost = document.getElementById("flag-chips")
for (const [k, label] of Object.entries(FLAGS)) {
  chipButton(flagHost, label, false, `var(--${k})`, "flag", (on) => on ? state.flags.add(k) : state.flags.delete(k))
}

// Per-group bulk toggles so a wholesale change is one click, not one per chip.
function bulk(setState) {
  setState()
  syncChips()
  render()
}
document.getElementById("status-all").onclick = () => bulk(() => (state.statuses = new Set(Object.keys(STATUS))))
document.getElementById("status-none").onclick = () => bulk(() => (state.statuses = new Set()))
document.getElementById("bucket-all").onclick = () =>
  bulk(() => {
    for (const b of cycleBuckets) state.bucketKeys.add(b.key)
  })
document.getElementById("bucket-none").onclick = () =>
  bulk(() => {
    for (const b of cycleBuckets) state.bucketKeys.delete(b.key)
  })

// interactive hover card (holds the not-slop action, so it must stay reachable)
const tip = document.getElementById("tip")
let hoverIssue = null
let hideTimer = null
function relText(i) {
  const parts = []
  if (i.blockedBy.length) parts.push(`blocked by ${i.blockedBy.join(", ")}`)
  if (i.blocks.length) parts.push(`blocks ${i.blocks.join(", ")}`)
  if (i.related.length) parts.push(`related ${i.related.join(", ")}`)
  return parts.join(" · ")
}
function showTip(e, i) {
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
    `<a class="tip-act tip-link" href="${i.url}" target="_blank">Open in Linear ↗</a>`
  const btn = tip.querySelector('[data-act="slop"]')
  if (btn) {
    btn.onclick = () => {
      toggleReviewed(i)
      hideTip()
    }
  }
  tip.style.display = "block"
  const w = tip.offsetWidth || 300, h = tip.offsetHeight || 120
  tip.style.left = `${Math.max(8, Math.min(e.clientX + 14, innerWidth - w - 8))}px`
  tip.style.top = `${Math.max(8, Math.min(e.clientY + 16, innerHeight - h - 8))}px`
}
function hideTip() {
  tip.style.display = "none"
  if (hoverIssue) hoverDeps(hoverIssue, false)
  hoverIssue = null
}
tip.onmouseenter = () => clearTimeout(hideTimer)
tip.onmouseleave = () => hideTip()

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
  if (b.kind === "cycle") return personCycleCapacity(person, parseInt(b.key.slice(1), 10), data.capacity)
  const base = personCycleCapacity(person, null, data.capacity).base
  return { points: Math.round(base * bucketWeeks[b.key]), factors: [] }
}

function capFootHTML(factors, capacity, load) {
  const parts = factors.map((f) =>
    f.kind === "oncall"
      ? `<span class="cf oncall">📟 on-call</span>`
      : `<span class="cf out">🧳 ${escapeHtml(f.reason)} ${f.days}d</span>`
  )
  if (capacity != null && load > capacity) parts.push(`<span class="cf over">over +${load - capacity}</span>`)
  return parts.length ? `<div class="capfoot">${parts.join("")}</div>` : ""
}

let passesShown = new Set()
function cellHTML(person, b) {
  const items = data.issues.filter((i) => passesShown.has(i) && i.assignee === person && i._bucket === b.key)
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
  return `<td class="${cls}" data-load="${load}" data-cap="${capacity ?? ""}">${heat}<div class="cellbody">${foot}${
    renderItems(items)
  }</div></td>`
}

function render() {
  const wrap = document.querySelector(".wrap")
  const sx = wrap ? wrap.scrollLeft : 0, sy = wrap ? wrap.scrollTop : 0
  const visible = buckets.filter((b) => state.bucketKeys.has(b.key))
  const shown = data.issues.filter(passes)
  passesShown = new Set(shown)
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
  const timelineEl = document.getElementById("timeline")
  if (state.view === "timeline") {
    grid.hidden = true
    timelineEl.hidden = false
    timelineEl.innerHTML = buildTimeline()
    wireNodes(timelineEl)
  } else {
    timelineEl.hidden = true
    grid.hidden = false
    grid.className = state.transpose ? "transposed" : ""
    grid.innerHTML = state.transpose ? buildTransposed(people) : buildBoard(people, visible)
    wireNodes(grid)
  }
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

function buildTransposed(people) {
  const visible = buckets.filter((b) => state.bucketKeys.has(b.key))
  let h = "<thead><tr class='col'><th>Bucket</th>"
  for (const person of people) h += `<th>${escapeHtml(person)}${personPts(person)}</th>`
  h += "</tr></thead><tbody>"
  for (const b of visible) {
    const kindTag = b.kind === "cycle" ? "now" : b.kind === "milestone" ? "horizon" : "backlog"
    h += `<tr><th class="rowhead ${kindTag}" title="${escapeHtml(bucketDetail(b))}">${escapeHtml(b.label)}` +
      `<span class="s">${bucketSub(b)}</span>${forecastBadge(b)}</th>`
    for (const person of people) h += cellHTML(person, b)
    h += "</tr>"
  }
  return `${h}</tbody>`
}

function buildTimeline() {
  const waves = dependencyWaves(data.issues)
  let h = ""
  waves.forEach((ids, idx) => {
    const cards = ids.map((id) => byId[id]).filter((i) => passesShown.has(i))
    if (!cards.length) return
    h += `<div class="wave"><div class="wave-h">Wave ${idx + 1}<span class="s">${cards.length}</span></div>` +
      cards.map(timelineCard).join("") + "</div>"
  })
  return h || `<div class="empty">No blocking relations among the shown issues.</div>`
}

function timelineCard(i) {
  const bkt = bucketByKey[i._bucket]
  const label = bkt ? bkt.label.replace("Cycle ", "C") : i._bucket
  return `<div class="tcard ${warnClass(i)}" data-id="${i.id}" onclick="window.open('${i.url}','_blank')" ` +
    `style="border-left-color:${STATUS[i.statusType]?.color}">` +
    `<div class="top"><span class="id">${i.id.replace(/^[A-Z]+-/, "")}</span>` +
    `<span class="bkt">${escapeHtml(label)}</span></div>` +
    `<div class="t">${escapeHtml(i.title)}</div>` +
    `<div class="who">${escapeHtml(i.assignee)}</div></div>`
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
      clearTimeout(hideTimer)
      hoverIssue = i
      showTip(e, i)
      hoverDeps(i, true)
    })
    el.addEventListener("mouseleave", () => {
      hideTimer = setTimeout(hideTip, 160)
    })
    el.addEventListener("focus", () => {
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
    return `<th class="mile" title="${title}"><span class="mlabel">${escapeHtml(b.label)}</span>${
      forecastBadge(b)
    }</th>`
  }
  return `<th title="${title}">${b.label}<span class="s">${bucketSub(b)}</span></th>`
}

function flagBadges(i) {
  let s = ""
  if (i._risk) s += `<span class="badge risk">⛔</span>`
  if (isSlop(i)) s += `<span class="badge slop">⚠${i._slop.score}</span>`
  if (i._miss.blocking) s += `<span class="badge miss">◑</span>`
  return s
}

// Compact-pill label: a leading flag glyph (so a flag reads even without color), the ticket number,
// and the estimate as "·N" — the only room a pill this small has for a second data point.
function tickLabel(i) {
  const flag = i._risk ? "⛔" : isSlop(i) ? "⚠" : i._miss.blocking ? "◑" : ""
  const num = i.id.replace(/^[A-Z]+-/, "")
  const pts = i.estimate ? `·${i.estimate}` : ""
  return `${flag}${num}${pts}`
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

async function refresh() {
  refreshBtn.disabled = true
  refreshBtn.textContent = "Refreshing…"
  try {
    const fresh = await loadData()
    data.issues = fresh.issues
    data.milestones = fresh.milestones
    data.cycles = fresh.cycles
    data.asOf = fresh.asOf
    data.currentCycle = fresh.currentCycle
    data.project = fresh.project
    data.capacity = fresh.capacity
    deriveBuckets()
    enrich()
    for (const k of buckets.map((b) => b.key)) {
      if (!knownBucketKeys.has(k)) {
        state.bucketKeys.add(k)
        knownBucketKeys.add(k)
      }
    }
    loadedAt = new Date()
    renderMeta()
    render()
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
    await refresh()
  }
}, 300000)

updateSync()
render()
