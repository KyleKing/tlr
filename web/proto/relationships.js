// Staging ground for the /relationships page. The layouts and scoring live in web/lib so they are
// testable in Deno; this file is only the browser half (render, pan/zoom, detail level, selection).
//
// The A/B/C direction comparison is finished: B's interaction model (edges and emphasis on demand)
// with C's bands for grouping. The rejected directions were deleted rather than left behind a flag.

import { applyTheme, loadTheme } from "../lib/appearance.js"
import { geodesicDistances, GEOMETRY, mdsCoords, relationshipsLayout, stressMajorize } from "../lib/relationships.js"
import { similarityMatrix, topNeighbors } from "../lib/similarity.js"
import { buildProject } from "./data.js"

applyTheme(loadTheme())

const el = (id) => document.getElementById(id)
const plane = el("plane")
const viewport = el("viewport")
const svg = el("edges")
const tip = el("tip")

const project = buildProject(180)
const issues = project.issues
const byId = new Map(issues.map((it) => [it.id, it]))

// Computed once per snapshot: the projection depends on the issue set, not on the filter or the mode.
const sim = similarityMatrix(issues)
const neighborsOf = new Map(topNeighbors(issues, sim, 6).map((r) => [r.id, r.neighbors]))
const geo = geodesicDistances(issues, sim)
const coords = stressMajorize(issues, geo, mdsCoords(issues, geo))

const LEVELS = ["Tiles", "Identity", "Detail"]
const state = {
  mode: "similarity",
  groupBy: "milestone",
  lod: 2,
  autoLod: true,
  selected: null,
  view: { x: 0, y: 0, scale: 1 },
}

const statusVar = (t) =>
  ({
    started: "--st-started",
    unstarted: "--st-unstarted",
    triage: "--st-triage",
    backlog: "--st-backlog",
    completed: "--st-completed",
    canceled: "--st-canceled",
  })[t] ?? "--st-unstarted"

let current = null

function layout() {
  return relationshipsLayout(state.mode, issues, {
    groupBy: state.groupBy,
    width: viewport.clientWidth * 1.6,
    coords,
    neighbors: [...neighborsOf].map(([id, neighbors]) => ({ id, neighbors })),
  })
}

function render({ animate = false } = {}) {
  current = layout()
  plane.style.width = `${current.width}px`
  plane.style.height = `${current.height}px`
  svg.setAttribute("viewBox", `0 0 ${current.width} ${current.height}`)
  svg.style.width = `${current.width}px`
  svg.style.height = `${current.height}px`

  if (animate) {
    plane.classList.add("pr-moving")
    setTimeout(() => plane.classList.remove("pr-moving"), 340)
  }
  renderRegions()
  renderCards()
  renderEdges()
  applyEmphasis()
  el("count").textContent = `${current.nodes.length} tickets`
}

let chromeEls = []
function renderRegions() {
  for (const node of chromeEls) node.remove()
  chromeEls = []
  const frag = document.createDocumentFragment()
  for (const region of current.regions) {
    const box = document.createElement("div")
    box.className = "pr-region"
    box.style.cssText = `left:${region.x}px;top:${region.y}px;width:${region.w}px;height:${region.h}px`
    frag.appendChild(box)
    chromeEls.push(box)
  }
  for (const item of [...current.regions, ...current.bands]) {
    const label = document.createElement("div")
    label.className = "pr-axis-label"
    label.style.cssText = `left:${item.x}px;top:${item.y}px`
    label.textContent = item.key
    frag.appendChild(label)
    chromeEls.push(label)
  }
  plane.insertBefore(frag, plane.firstChild)
}

const cardEls = new Map()
function renderCards() {
  const live = new Set()
  for (const node of current.nodes) {
    live.add(node.id)
    let card = cardEls.get(node.id)
    if (!card) {
      card = document.createElement("div")
      card.tabIndex = -1
      card.dataset.id = node.id
      card.innerHTML =
        `<div><span class="pr-pts"></span><span class="pr-id"></span></div><div class="pr-title"></div><div class="pr-meta"></div>`
      plane.appendChild(card)
      cardEls.set(node.id, card)
      const issue = node.issue
      card.querySelector(".pr-id").textContent = issue.id
      card.querySelector(".pr-pts").textContent = issue.estimate ?? "–"
      card.querySelector(".pr-title").textContent = issue.title
      card.querySelector(".pr-meta").textContent = `${issue.assignee} · ${issue.milestone ?? "no milestone"}`
    }
    card.className = `pr-card lod${state.lod}`
    card.style.cssText = `left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px;--tile:var(${
      statusVar(node.issue.statusType)
    })`
  }
  for (const [id, card] of cardEls) {
    if (!live.has(id)) {
      card.remove()
      cardEls.delete(id)
    }
  }
  cardEls.get(current.nodes[0]?.id)?.setAttribute("tabindex", "0")
}

// Edges are drawn only where direction is information position cannot carry, which is Sequence, plus
// the selected ticket's own neighbourhood. Drawing every similarity edge repeats the mistake the old
// plane made: two channels saying the same thing, and neither readable.
function renderEdges() {
  const pos = new Map(current.nodes.map((n) => [n.id, n]))
  const showAll = state.mode === "sequence"
  const paths = []
  for (const edge of current.edges) {
    const a = pos.get(edge.from)
    const b = pos.get(edge.to)
    if (!a || !b) continue
    const touches = state.selected === edge.from || state.selected === edge.to
    if (!showAll && !touches) continue
    let d
    if (edge.kind === "sim") {
      d = `M ${a.x + a.w / 2} ${a.y + a.h / 2} L ${b.x + b.w / 2} ${b.y + b.h / 2}`
    } else {
      const x1 = a.x + a.w
      const y1 = a.y + a.h / 2
      const x2 = b.x
      const y2 = b.y + b.h / 2
      const bend = Math.max(20, Math.abs(x2 - x1) / 2)
      d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
    }
    const classes = ["pr-edge", edge.kind === "sim" ? "sim" : "", touches ? "lit" : ""].filter(Boolean).join(" ")
    paths.push(`<path class="${classes}" d="${d}"${edge.kind === "block" ? ' marker-end="url(#arrow)"' : ""}/>`)
  }
  svg.innerHTML =
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--surface1)"/></marker></defs>${
      paths.join("")
    }`
}

function applyEmphasis() {
  const selected = state.selected
  const near = new Set()
  if (selected) {
    near.add(selected)
    const issue = byId.get(selected)
    for (const id of [...(issue.blocks ?? []), ...(issue.blockedBy ?? []), ...(issue.related ?? [])]) near.add(id)
    for (const n of neighborsOf.get(selected) ?? []) near.add(n.id)
  }
  for (const [id, card] of cardEls) {
    card.classList.toggle("sel", id === selected)
    card.classList.toggle("lit", Boolean(selected) && near.has(id) && id !== selected)
    card.classList.toggle("dim", Boolean(selected) && !near.has(id))
  }
}

// ------------------------------------------------------------------ view

function applyView() {
  plane.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`
  if (!state.autoLod) return
  const onScreen = state.view.scale * GEOMETRY.cardW
  const next = onScreen < 58 ? 0 : onScreen < 112 ? 1 : 2
  if (next !== state.lod) {
    state.lod = next
    applyLod()
  }
}

function applyLod() {
  el("lod").textContent = LEVELS[state.lod]
  for (const card of cardEls.values()) {
    card.classList.remove("lod0", "lod1", "lod2")
    card.classList.add(`lod${state.lod}`)
  }
}

function fitView() {
  const rect = viewport.getBoundingClientRect()
  const scale = Math.max(0.08, Math.min(1.4, Math.min(rect.width / current.width, rect.height / current.height) * 0.94))
  state.view = {
    scale,
    x: (rect.width - current.width * scale) / 2,
    y: (rect.height - current.height * scale) / 2,
  }
  applyView()
}

viewport.addEventListener("wheel", (ev) => {
  ev.preventDefault()
  const rect = viewport.getBoundingClientRect()
  const cx = ev.clientX - rect.left
  const cy = ev.clientY - rect.top
  const next = Math.max(0.2, Math.min(2.2, state.view.scale * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)))
  state.view.x = cx - ((cx - state.view.x) / state.view.scale) * next
  state.view.y = cy - ((cy - state.view.y) / state.view.scale) * next
  state.view.scale = next
  applyView()
}, { passive: false })

let drag = null
viewport.addEventListener("pointerdown", (ev) => {
  if (ev.target.closest(".pr-card")) return
  drag = { x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y }
  viewport.setPointerCapture(ev.pointerId)
})
viewport.addEventListener("pointermove", (ev) => {
  if (!drag) return
  state.view.x = drag.vx + (ev.clientX - drag.x)
  state.view.y = drag.vy + (ev.clientY - drag.y)
  applyView()
})
viewport.addEventListener("pointerup", () => {
  drag = null
})

// ------------------------------------------------------------------ interaction

plane.addEventListener("click", (ev) => {
  const card = ev.target.closest(".pr-card")
  if (!card) return
  state.selected = state.selected === card.dataset.id ? null : card.dataset.id
  applyEmphasis()
  renderEdges()
})

plane.addEventListener("pointerover", (ev) => {
  const card = ev.target.closest(".pr-card")
  if (!card) return
  const issue = byId.get(card.dataset.id)
  const near = (neighborsOf.get(issue.id) ?? []).slice(0, 3)
  tip.innerHTML = `<h3>${issue.id} · ${issue.title}</h3><dl>
    <dt>status</dt><dd>${issue.status}</dd>
    <dt>owner</dt><dd>${issue.assignee}</dd>
    <dt>points</dt><dd>${issue.estimate ?? "unestimated"}</dd>
    <dt>labels</dt><dd>${issue.labels.join(", ") || "none"}</dd>
    <dt>blocks</dt><dd>${issue.blocks.join(", ") || "nothing"}</dd>
    <dt>similar</dt><dd>${
    near.map((n) => `${n.id} ${(n.score * 100) | 0}%${n.why ? ` (${n.why})` : ""}`).join("<br>") || "nothing close"
  }</dd></dl>`
  const rect = card.getBoundingClientRect()
  tip.style.left = `${Math.min(rect.right + 8, innerWidth - 340)}px`
  tip.style.top = `${Math.min(rect.top, innerHeight - 220)}px`
  tip.hidden = false
})
plane.addEventListener("pointerout", (ev) => {
  if (!ev.relatedTarget?.closest?.(".pr-card")) tip.hidden = true
})

for (const btn of document.querySelectorAll("[data-mode]")) {
  btn.addEventListener("click", () => {
    state.mode = btn.dataset.mode
    for (const sib of document.querySelectorAll("[data-mode]")) {
      sib.setAttribute("aria-pressed", String(sib === btn))
    }
    render({ animate: true })
    fitView()
  })
}

el("groupBy").addEventListener("change", (ev) => {
  state.groupBy = ev.target.value
  state.mode = "grouping"
  for (const sib of document.querySelectorAll("[data-mode]")) {
    sib.setAttribute("aria-pressed", String(sib.dataset.mode === "grouping"))
  }
  render({ animate: true })
  fitView()
})

el("lodStep").addEventListener("click", () => {
  state.autoLod = false
  el("lodStep").textContent = "Detail: pinned"
  state.lod = (state.lod + 1) % 3
  applyLod()
})

el("reset").addEventListener("click", () => {
  state.autoLod = true
  el("lodStep").textContent = "Detail: auto"
  fitView()
})

render()
fitView()
