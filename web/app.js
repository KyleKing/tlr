import { bucketOf, buildBuckets, missingData, orderingRisks, slopHash, slopScan, statusRank, weeksBetween } from "./lib/planning.js"

const STATUS = {
  started: { label: "In progress", color: "var(--st-started)" },
  unstarted: { label: "Todo", color: "var(--st-unstarted)" },
  triage: { label: "Triage", color: "var(--st-triage)" },
  backlog: { label: "Backlog", color: "var(--st-backlog)" },
  completed: { label: "Done", color: "var(--st-completed)" },
  canceled: { label: "Canceled", color: "var(--st-canceled)" },
}
const FLAGS = { slop: "⚠ slop", risk: "⛔ ordering risk", miss: "◑ missing (in cycle)" }
const REVIEW_KEY = "tlr.notslop"

async function loadData() {
  const r = await fetch("/data/cpu.json")
  return (r.ok ? r : await fetch("/data-sample.json")).json()
}

const data = await loadData()
const buckets = buildBuckets(data)
const bucketByKey = Object.fromEntries(buckets.map((b) => [b.key, b]))

// weeks per bucket window (per-person capacity basis)
const bucketWeeks = {}
data.milestones.forEach((m, idx) => {
  const start = idx === 0
    ? data.asOf
    : (new Date(data.asOf) > new Date(data.milestones[idx - 1].target) ? data.asOf : data.milestones[idx - 1].target)
  bucketWeeks[m.key] = Math.max(0.5, weeksBetween(start, m.target))
})
for (const b of buckets) if (b.kind === "cycle") bucketWeeks[b.key] = 1
bucketWeeks.BACKLOG = Infinity

// enrich issues
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
const riskIds = new Set(orderingRisks(data.issues).flatMap((r) => [r.issue, r.blocker]))
for (const i of data.issues) i._risk = riskIds.has(i.id) && (i.blockedBy.length > 0)
const byId = Object.fromEntries(data.issues.map((i) => [i.id, i]))

// not-slop dismissals persist locally, keyed by content hash so an edit re-flags
const reviewed = JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}")
const isDismissed = (i) => reviewed[i.id] === i._slopHash
const isSlop = (i) => i._slop.flags.length > 0 && !isDismissed(i)
function toggleReviewed(i) {
  if (isDismissed(i)) delete reviewed[i.id]
  else reviewed[i.id] = i._slopHash
  localStorage.setItem(REVIEW_KEY, JSON.stringify(reviewed))
  render()
}

const DEFAULT_STATUSES = ["started", "unstarted", "triage", "backlog"]
const state = {
  q: "",
  statuses: new Set(DEFAULT_STATUSES),
  flags: new Set(),
  cap: 8,
  expanded: false,
  transpose: false,
}

// header
document.getElementById("title").textContent = data.project.name
document.getElementById("meta").innerHTML =
  `${data.issues.length} issues · ${data.project.start} → ${data.project.target} · as of ${data.asOf} · ` +
  `<a href="${data.project.url}" target="_blank">Linear ↗</a>`

// controls
const search = document.getElementById("search")
search.oninput = () => {
  state.q = search.value.trim().toLowerCase()
  render()
}
const cap = document.getElementById("cap"), capv = document.getElementById("capv")
cap.oninput = () => {
  state.cap = +cap.value
  capv.textContent = cap.value
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

const chips = document.getElementById("chips")
const statusChips = new Map()
function syncStatusChips() {
  for (const [k, b] of statusChips) b.setAttribute("aria-pressed", state.statuses.has(k))
}
function chip(label, on, color, cls, toggle, onSolo) {
  const b = document.createElement("button")
  b.className = "chip " + (cls || "")
  b.textContent = label
  b.setAttribute("aria-pressed", on)
  if (color) b.style.color = color
  if (onSolo) b.title = "double-click to show only this"
  b.onclick = () => {
    const now = b.getAttribute("aria-pressed") !== "true"
    b.setAttribute("aria-pressed", now)
    toggle(now)
    render()
  }
  if (onSolo) {
    b.ondblclick = () => {
      onSolo()
      syncStatusChips()
      render()
    }
  }
  chips.appendChild(b)
  return b
}
for (const [k, v] of Object.entries(STATUS)) {
  const b = chip(
    v.label,
    state.statuses.has(k),
    v.color,
    "",
    (on) => on ? state.statuses.add(k) : state.statuses.delete(k),
    () => {
      const solo = state.statuses.size === 1 && state.statuses.has(k)
      state.statuses = new Set(solo ? DEFAULT_STATUSES : [k])
    },
  )
  statusChips.set(k, b)
}
const sep = document.createElement("span")
sep.className = "chip-sep"
chips.appendChild(sep)
for (const [k, label] of Object.entries(FLAGS)) {
  chip(label, false, `var(--${k})`, "flag", (on) => on ? state.flags.add(k) : state.flags.delete(k))
}

// interactive hover card (holds the not-slop action, so it must stay reachable)
const tip = document.getElementById("tip")
let hoverIssue = null
let hideTimer = null
function relText(i) {
  const parts = []
  if (i.blockedBy.length) parts.push("blocked by " + i.blockedBy.join(", "))
  if (i.blocks.length) parts.push("blocks " + i.blocks.join(", "))
  if (i.related.length) parts.push("related " + i.related.join(", "))
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
    (i._slop.flags.length
      ? `<div class="tip-f slop">⚠ ${i._slop.flags.join(", ")}</div>` +
        `<button class="tip-act" data-act="slop">${isDismissed(i) ? "Re-flag as slop" : "Mark not slop"}</button>`
      : "")
  const btn = tip.querySelector(".tip-act")
  if (btn) {btn.onclick = () => {
    toggleReviewed(i)
    hideTip()
  }}
  tip.style.display = "block"
  const w = tip.offsetWidth || 300, h = tip.offsetHeight || 120
  tip.style.left = Math.max(8, Math.min(e.clientX + 14, innerWidth - w - 8)) + "px"
  tip.style.top = Math.max(8, Math.min(e.clientY + 16, innerHeight - h - 8)) + "px"
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

function cellHTML(person, b) {
  const items = data.issues.filter((i) => passesShown.has(i) && i.assignee === person && i._bucket === b.key)
    .sort((a, x) => statusRank(a.statusType) - statusRank(x.statusType) || x.estimate - a.estimate)
  const load = items.reduce((s, i) => s + i.estimate, 0)
  const cls = b.key === "C47" ? "past" : (b.kind === "cycle" ? "now" : "")
  const capacity = person === "Unassigned" ? null : state.cap * bucketWeeks[b.key]
  let heat = ""
  if (capacity && load > 0) {
    const ratio = load / capacity
    const zone = ratio <= 0.8 ? "ok" : ratio <= 1.05 ? "warn" : "over"
    heat = `<div class="heat" style="background:${
      zone === "over" ? "rgba(220,38,38,.16)" : zone === "warn" ? "rgba(217,119,6,.13)" : "rgba(22,163,74,.09)"
    }"></div>`
  }
  return `<td class="${cls}" data-cap="${capacity ?? ""}" data-load="${load}">${heat}<div class="cellbody">${
    renderItems(items)
  }</div></td>`
}

// filter cache so cellHTML does not re-run passes() per cell
let passesShown = new Set()

function render() {
  const shown = data.issues.filter(passes)
  passesShown = new Set(shown)
  const people = [...new Set(shown.map((i) => i.assignee))].sort((a, b) =>
    (a === "Unassigned") - (b === "Unassigned") || a.localeCompare(b)
  )
  nodeById.clear()

  // summary
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

  let h
  if (!state.transpose) {
    const nCyc = buckets.filter((b) => b.kind === "cycle").length
    const nMile = buckets.filter((b) => b.kind === "milestone").length
    h = "<thead><tr class='grp'><th></th>" +
      `<th colspan="${nCyc}">Now · cycles</th><th colspan="${nMile}">Horizon · milestones</th><th>Unscheduled</th></tr>`
    h += "<tr class='col'><th>Assignee</th>"
    for (const b of buckets) h += bucketTh(b)
    h += "</tr></thead><tbody>"
    for (const person of people) {
      h += `<tr><th>${escapeHtml(person)}${personPts(shown, person)}</th>`
      for (const b of buckets) h += cellHTML(person, b)
      h += "</tr>"
    }
    h += "</tbody>"
  } else {
    h = "<thead><tr class='col'><th>Bucket</th>"
    for (const person of people) h += `<th>${escapeHtml(person)}${personPts(shown, person)}</th>`
    h += "</tr></thead><tbody>"
    for (const b of buckets) {
      const kindTag = b.kind === "cycle" ? "now" : b.kind === "milestone" ? "horizon" : "backlog"
      h += `<tr><th class="rowhead ${kindTag}">${b.label}<span class="s">${bucketSub(b)}</span></th>`
      for (const person of people) h += cellHTML(person, b)
      h += "</tr>"
    }
    h += "</tbody>"
  }
  const grid = document.getElementById("grid")
  grid.className = state.transpose ? "transposed" : ""
  grid.innerHTML = h

  // wire nodes
  for (const el of grid.querySelectorAll("[data-id]")) {
    const i = byId[el.getAttribute("data-id")]
    nodeById.set(i.id, el)
    el.addEventListener("mouseenter", (e) => {
      clearTimeout(hideTimer)
      hoverIssue = i
      showTip(e, i)
      hoverDeps(i, true)
    })
    el.addEventListener("mouseleave", () => {
      hideTimer = setTimeout(hideTip, 160)
    })
    if (state.expanded && el.classList.contains("card")) {
      el.addEventListener("click", (e) => {
        if (e.target.tagName !== "A") {
          e.preventDefault()
          el.classList.toggle("open")
        }
      })
    }
  }
}

function personPts(shown, person) {
  const pts = shown.filter((i) => i.assignee === person).reduce((s, i) => s + i.estimate, 0)
  return `<span class="pl"> ${pts}pt</span>`
}
function bucketSub(b) {
  return `${b.name ? escapeHtml(b.name.replace(/^M\d: /, "")) + " · " : ""}${b.sub}${
    b.progress != null ? " · " + Math.round(b.progress) + "%" : ""
  }`
}
function bucketTh(b) {
  return `<th>${b.label}<span class="s">${bucketSub(b)}</span></th>`
}

function flagBadges(i) {
  let s = ""
  if (i._risk) s += `<span class="badge risk">⛔</span>`
  if (isSlop(i)) s += `<span class="badge slop">⚠${i._slop.score}</span>`
  if (i._miss.blocking) s += `<span class="badge miss">◑</span>`
  return s
}

function renderItems(items) {
  if (!state.expanded) {
    return `<div class="ticks">${
      items.map((i) => {
        const num = i.id.replace(/^[A-Z]+-/, "")
        return `<span class="tick ${warnClass(i)}" data-id="${i.id}" onclick="window.open('${i.url}','_blank')" ` +
          `style="min-width:${20 + i.estimate * 5}px;background:${STATUS[i.statusType]?.color}">${num}</span>`
      }).join("")
    }</div>`
  }
  return items.map((i) =>
    `<a class="card ${warnClass(i)}" data-id="${i.id}" href="${i.url}" style="border-left-color:${
      STATUS[i.statusType]?.color
    }">
    <span class="top"><a class="id" href="${i.url}" target="_blank">${i.id}</a><span class="badges">${
      flagBadges(i)
    }</span><span class="pts">${i.estimate || "–"}</span></span>
    <span class="t">${escapeHtml(i.title)}</span>
    <span class="rel">${escapeHtml(relText(i))}${
      isSlop(i) ? "<br>⚠ " + i._slop.flags.join(", ") : ""
    }</span>
  </a>`
  ).join("")
}

capv.textContent = cap.value
render()
