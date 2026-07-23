import { bucketOf, buildBuckets, missingData, orderingRisks, slopScan, weeksBetween } from "./lib/planning.js"

const STATUS = {
  started: { label: "In progress", color: "var(--st-started)" },
  unstarted: { label: "Todo", color: "var(--st-unstarted)" },
  triage: { label: "Triage", color: "var(--st-triage)" },
  backlog: { label: "Backlog", color: "var(--st-backlog)" },
  completed: { label: "Done", color: "var(--st-completed)" },
  canceled: { label: "Canceled", color: "var(--st-canceled)" },
}
const FLAGS = { slop: "⚠ slop", risk: "⛔ ordering risk", miss: "◑ missing (in cycle)" }

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
  i._miss = missingData(i)
}
const riskIds = new Set(orderingRisks(data.issues).flatMap((r) => [r.issue, r.blocker]))
for (const i of data.issues) i._risk = riskIds.has(i.id) && (i.blockedBy.length > 0)
const byId = Object.fromEntries(data.issues.map((i) => [i.id, i]))

// state
const state = {
  q: "",
  statuses: new Set(["started", "unstarted", "triage", "backlog"]),
  flags: new Set(),
  cap: 8,
  expanded: false,
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

const chips = document.getElementById("chips")
function chip(label, on, color, cls, toggle) {
  const b = document.createElement("button")
  b.className = "chip " + (cls || "")
  b.textContent = label
  b.setAttribute("aria-pressed", on)
  if (color) b.style.color = color
  b.onclick = () => {
    const now = b.getAttribute("aria-pressed") !== "true"
    b.setAttribute("aria-pressed", now)
    toggle(now)
    render()
  }
  chips.appendChild(b)
}
for (const [k, v] of Object.entries(STATUS)) {
  chip(v.label, state.statuses.has(k), v.color, "", (on) => on ? state.statuses.add(k) : state.statuses.delete(k))
}
const sep = document.createElement("span")
sep.style.width = "1px"
sep.style.background = "var(--line)"
sep.style.alignSelf = "stretch"
chips.appendChild(sep)
for (const [k, label] of Object.entries(FLAGS)) {
  chip(label, false, `var(--${k})`, "flag", (on) => on ? state.flags.add(k) : state.flags.delete(k))
}

const tip = document.getElementById("tip")
function showTip(e, i) {
  tip.innerHTML =
    `<b>${i.id}</b> · ${i.estimate || "–"}pt · ${STATUS[i.statusType]?.label ?? i.statusType} · ${
      i.priority ?? ""
    }<br>${escapeHtml(i.title)}` +
    (i._slop.flags.length ? `<span class="f">⚠ ${i._slop.flags.join(", ")}</span>` : "") +
    (i._risk ? `<span class="f">⛔ blocked by ${i.blockedBy.join(", ")} (later)</span>` : "")
  tip.style.display = "block"
  tip.style.left = Math.min(e.clientX + 14, innerWidth - 340) + "px"
  tip.style.top = (e.clientY + 16) + "px"
}
function hideTip() {
  tip.style.display = "none"
}

function passes(i) {
  if (!state.statuses.has(i.statusType)) return false
  if (state.q && !(`${i.id} ${i.title} ${i.description}`.toLowerCase().includes(state.q))) return false
  for (const f of state.flags) {
    if (f === "slop" && i._slop.flags.length === 0) return false
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
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}

function render() {
  const shown = data.issues.filter(passes)
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
    `<span style="color:var(--slop)"><b>${shown.filter((i) => i._slop.flags.length).length}</b> slop</span>`,
    `<span style="color:var(--risk)"><b>${shown.filter((i) => i._risk).length}</b> ordering risk</span>`,
    `<span style="color:var(--miss)"><b>${shown.filter((i) => i._miss.blocking).length}</b> missing-in-cycle</span>`,
  ].join("")

  const nCyc = buckets.filter((b) => b.kind === "cycle").length
  const nMile = buckets.filter((b) => b.kind === "milestone").length
  let h = "<thead><tr class='grp'><th></th>"
  h +=
    `<th colspan="${nCyc}">Now · cycles</th><th colspan="${nMile}">Horizon · milestones</th><th>Unscheduled</th></tr>`
  h += "<tr class='col'><th>Assignee</th>"
  for (const b of buckets) {
    h += `<th>${b.label}<span class="s">${b.name ? escapeHtml(b.name.replace(/^M\d: /, "")) + " · " : ""}${b.sub}${
      b.progress != null ? " · " + Math.round(b.progress) + "%" : ""
    }</span></th>`
  }
  h += "</tr></thead><tbody>"

  for (const person of people) {
    const pts = shown.filter((i) => i.assignee === person).reduce((s, i) => s + i.estimate, 0)
    h += `<tr><th>${escapeHtml(person)}<span class="pl"> ${pts}pt</span></th>`
    for (const b of buckets) {
      const items = shown.filter((i) => i.assignee === person && i._bucket === b.key)
        .sort((a, x) => a.priorityValue - x.priorityValue || x.estimate - a.estimate)
      const load = items.reduce((s, i) => s + i.estimate, 0)
      const cls = b.key === "C47" ? "past" : (b.kind === "cycle" ? "now" : "")
      const cap = person === "Unassigned" ? null : state.cap * bucketWeeks[b.key]
      let fill = "", heat = ""
      if (cap && load > 0) {
        const ratio = load / cap
        const zone = ratio <= 0.8 ? "ok" : ratio <= 1.05 ? "warn" : "over"
        fill = `<div class="fill ${zone}" style="height:${Math.min(100, ratio * 100)}%"></div>`
        heat = `<div class="heat" style="background:${
          zone === "over" ? "rgba(220,38,38,.10)" : zone === "warn" ? "rgba(217,119,6,.08)" : "rgba(22,163,74,.06)"
        }"></div>`
      }
      h += `<td class="${cls}" data-cap="${cap ?? ""}" data-load="${load}">${heat}${fill}<div class="cellbody">${
        renderItems(items)
      }</div></td>`
    }
    h += "</tr>"
  }
  h += "</tbody>"
  const grid = document.getElementById("grid")
  grid.innerHTML = h

  // wire nodes
  for (const el of grid.querySelectorAll("[data-id]")) {
    const i = byId[el.getAttribute("data-id")]
    nodeById.set(i.id, el)
    el.addEventListener("mouseenter", (e) => {
      showTip(e, i)
      hoverDeps(i, true)
    })
    el.addEventListener("mousemove", (e) => showTip(e, i))
    el.addEventListener("mouseleave", () => {
      hideTip()
      hoverDeps(i, false)
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

function flagBadges(i) {
  let s = ""
  if (i._risk) s += `<span class="badge risk">⛔</span>`
  if (i._slop.flags.length) s += `<span class="badge slop">⚠${i._slop.score}</span>`
  if (i._miss.blocking) s += `<span class="badge miss">◑</span>`
  return s
}

function renderItems(items) {
  if (!state.expanded) {
    return `<div class="ticks">${
      items.map((i) => {
        const flag = i._risk
          ? "var(--risk)"
          : i._slop.flags.length
          ? "var(--slop)"
          : i._miss.blocking
          ? "var(--miss)"
          : ""
        return `<span class="tick" data-id="${i.id}" onclick="window.open('${i.url}','_blank')" style="width:${
          6 + i.estimate * 4
        }px;background:${STATUS[i.statusType]?.color};${flag ? `border-bottom:2px solid ${flag}` : ""}"></span>`
      }).join("")
    }</div>`
  }
  return items.map((i) =>
    `<a class="card" data-id="${i.id}" href="${i.url}" style="border-left-color:${STATUS[i.statusType]?.color}">
    <span class="top"><a class="id" href="${i.url}" target="_blank">${i.id}</a><span class="badges">${
      flagBadges(i)
    }</span><span class="pts">${i.estimate || "–"}</span></span>
    <span class="t">${escapeHtml(i.title)}</span>
    <span class="rel">${i.blockedBy.length ? "blocked by " + i.blockedBy.join(", ") : ""}${
      i.blocks.length ? " · blocks " + i.blocks.join(", ") : ""
    }${i._slop.flags.length ? "<br>⚠ " + i._slop.flags.join(", ") : ""}</span>
  </a>`
  ).join("")
}

capv.textContent = cap.value
render()
