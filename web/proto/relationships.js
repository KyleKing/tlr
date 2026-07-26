import { applyTheme, loadTheme } from "../lib/appearance.js"
import { buildProject } from "./data.js"
import {
  geodesicDistances,
  layerDag,
  mdsCoords,
  packGrid,
  relaxOverlaps,
  similarityMatrix,
  stressMajorize,
  topNeighbors,
  treemap,
} from "./layouts.js"

const CARD_W = 168
const CARD_MIN_H = 54
const CARD_MAX_H = 88
const GAP = 8

// The semantic tokens (--st-*, --risk, --slop) are written onto documentElement at runtime, not by
// style.css, so the prototype has to apply the theme the same way every real page does.
applyTheme(loadTheme())

const el = (id) => document.getElementById(id)
const plane = el("plane")
const viewport = el("viewport")
const svg = el("edges")
const tip = el("tip")

const project = buildProject(180)
const issues = project.issues
const byId = new Map(issues.map((it) => [it.id, it]))
const sim = similarityMatrix(issues)
const index = new Map(issues.map((it, i) => [it.id, i]))
const neighborsOf = new Map(topNeighbors(issues, sim, 6).map((r) => [r.id, r.neighbors]))
const geo = geodesicDistances(issues, sim)
const mds = stressMajorize(issues, geo, mdsCoords(issues, geo))

const state = {
  design: "a",
  mode: "similarity",
  groupBy: "milestone",
  lod: 2,
  autoLod: true,
  selected: null,
  view: { x: 60, y: 60, scale: 0.75 },
}

// Card geometry is independent of the detail level on purpose: the level changes what is drawn
// inside the box, never the box. Otherwise every level change forces a re-layout, and fit-to-content
// and auto-detail chase each other in a loop that never settles.
const cardHeight = (issue) => Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, CARD_MIN_H + (issue.estimate ?? 2) * 2.4))
const cardWidth = () => CARD_W

const statusVar = (t) =>
  ({
    started: "--st-started",
    unstarted: "--st-unstarted",
    triage: "--st-triage",
    backlog: "--st-backlog",
    completed: "--st-completed",
    canceled: "--st-canceled",
  })[t] ?? "--st-unstarted"

const groupKey = (issue) => {
  if (state.groupBy === "milestone") return issue.milestone ?? "No milestone"
  if (state.groupBy === "cycle") return issue.cycle == null ? "No cycle" : `Cycle ${issue.cycle}`
  if (state.groupBy === "assignee") return issue.assignee
  if (state.groupBy === "parent") return issue.parentId ?? "No parent"
  return issue.labels?.[0] ?? "No label"
}

// ------------------------------------------------------------------ layouts

const percentile = (sorted, f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(f * (sorted.length - 1))))]

// Size the plane to hold the cards at a chosen density rather than scaling off nearest-neighbour
// distance or raw extent. Coincident points make the former explode and disconnected outliers make
// the latter collapse; a robust percentile box plus a target area is stable against both.
function layoutSimilarity() {
  const xsSorted = mds.map((m) => m.x).sort((a, b) => a - b)
  const ysSorted = mds.map((m) => m.y).sort((a, b) => a - b)
  const spanX = Math.max(percentile(xsSorted, 0.98) - percentile(xsSorted, 0.02), 1e-6)
  const spanY = Math.max(percentile(ysSorted, 0.98) - percentile(ysSorted, 0.02), 1e-6)

  const avgH = issues.reduce((a, it) => a + cardHeight(it), 0) / issues.length
  const targetArea = issues.length * (cardWidth() + GAP) * (avgH + GAP) * 3.2
  const k = Math.sqrt(targetArea / (spanX * spanY))

  const nodes = issues.map((it) => {
    const m = mds[index.get(it.id)]
    return { id: it.id, issue: it, w: cardWidth(), h: cardHeight(it), x: m.x * k, y: m.y * k * 0.72 }
  })
  relaxOverlaps(nodes, GAP, GAP)
  return { nodes, regions: [], bands: [], edges: simEdges(nodes) }
}

function layoutSequence() {
  const { layers, isolated } = layerDag(issues)
  const nodes = []
  const bands = []
  let x = 0
  layers.forEach((layer, d) => {
    let y = 0
    for (const it of layer) {
      const h = cardHeight(it)
      nodes.push({ id: it.id, issue: it, x, y, w: cardWidth(), h })
      y += h + GAP
    }
    bands.push({ key: `Wave ${d}`, x, y: -34, w: cardWidth(), h: y })
    x += cardWidth() + 90
  })
  // Unblocked, unblocking work sits in its own field rather than polluting wave 0.
  const startY = Math.max(0, ...nodes.map((n) => n.y + n.h)) + 90
  const cols = Math.max(4, Math.round(Math.sqrt(isolated.length * 1.8)))
  const rowH = Math.max(0, ...isolated.map(cardHeight)) + GAP
  isolated.forEach((it, i) => {
    nodes.push({
      id: it.id,
      issue: it,
      x: (i % cols) * (cardWidth() + GAP),
      y: startY + Math.floor(i / cols) * rowH,
      w: cardWidth(),
      h: cardHeight(it),
    })
  })
  if (isolated.length) bands.push({ key: "No dependency", x: 0, y: startY - 34, w: cols * (cardWidth() + GAP), h: 0 })
  return { nodes, regions: [], bands, edges: blockEdges(nodes) }
}

function layoutGrouping() {
  const groups = new Map()
  for (const it of issues) {
    const k = groupKey(it)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(it)
  }
  const items = [...groups].map(([key, list]) => ({ key, value: list.length }))
  const total = issues.length
  const planeW = Math.max(1400, Math.sqrt(total) * 190)
  const planeH = planeW * 0.62

  const nodes = []
  const regions = []
  if (state.design === "c") {
    // Strata: one horizontal band per group, ordered by size.
    let y = 0
    for (const { key } of items) {
      const list = groups.get(key)
      const cols = Math.max(1, Math.floor(planeW / (cardWidth() + GAP)))
      const rows = Math.ceil(list.length / cols)
      const maxH = Math.max(...list.map(cardHeight))
      const h = rows * (maxH + GAP)
      regions.push({ key, x: 0, y, w: planeW, h })
      list.forEach((it, i) => {
        nodes.push({
          id: it.id,
          issue: it,
          x: (i % cols) * (cardWidth() + GAP),
          y: y + 22 + Math.floor(i / cols) * (maxH + GAP),
          w: cardWidth(),
          h: cardHeight(it),
        })
      })
      y += h + 56
    }
  } else {
    for (const rect of treemap(items, 0, 0, planeW, planeH)) {
      const list = groups.get(rect.key)
      const inner = { x: rect.x + 10, y: rect.y + 26, w: rect.w - 20, h: rect.h - 34 }
      const maxH = Math.max(...list.map(cardHeight))
      const offsets = packGrid(list.length, inner.w, cardWidth(), maxH, GAP)
      regions.push(rect)
      list.forEach((it, i) => {
        nodes.push({
          id: it.id,
          issue: it,
          x: inner.x + offsets[i].x,
          y: inner.y + offsets[i].y,
          w: cardWidth(),
          h: cardHeight(it),
        })
      })
    }
  }
  return { nodes, regions, bands: [], edges: [] }
}

function blockEdges(nodes) {
  const pos = new Map(nodes.map((n) => [n.id, n]))
  const out = []
  for (const it of issues) {
    for (const b of it.blockedBy ?? []) {
      const from = pos.get(b)
      const to = pos.get(it.id)
      if (!from || !to) continue
      out.push({ from: b, to: it.id, kind: "block" })
    }
  }
  return out
}

function simEdges() {
  const out = []
  const seen = new Set()
  for (const [id, list] of neighborsOf) {
    for (const n of list.slice(0, 3)) {
      const key = id < n.id ? `${id}|${n.id}` : `${n.id}|${id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ from: id, to: n.id, kind: "sim", score: n.score })
    }
  }
  return out
}

const LAYOUTS = { similarity: layoutSimilarity, sequence: layoutSequence, grouping: layoutGrouping }

// ------------------------------------------------------------------ render

let current = null

function render(animate = false) {
  const laid = LAYOUTS[state.mode]()
  const minX = Math.min(...laid.nodes.map((n) => n.x), 0)
  const minY = Math.min(...laid.nodes.map((n) => n.y), 0)
  for (const n of laid.nodes) {
    n.x -= minX - 40
    n.y -= minY - 40
  }
  for (const r of laid.regions) {
    r.x -= minX - 40
    r.y -= minY - 40
  }
  for (const b of laid.bands) {
    b.x -= minX - 40
    b.y -= minY - 40
  }
  current = laid

  const width = Math.max(...laid.nodes.map((n) => n.x + n.w)) + 60
  const height = Math.max(...laid.nodes.map((n) => n.y + n.h)) + 60
  plane.style.width = `${width}px`
  plane.style.height = `${height}px`
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
  svg.style.width = `${width}px`
  svg.style.height = `${height}px`

  document.body.className = `design-${state.design}`
  if (animate) {
    plane.classList.add("pr-moving")
    setTimeout(() => plane.classList.remove("pr-moving"), 360)
  }

  renderRegions(laid)
  renderCards(laid)
  renderEdges(laid)
  applyHighlight()
  el("count").textContent = `${laid.nodes.length} tickets · ${laid.edges.length} edges drawn`
}

let regionEls = []
function renderRegions(laid) {
  for (const e of regionEls) e.remove()
  regionEls = []
  const frag = document.createDocumentFragment()
  for (const r of [...laid.regions, ...laid.bands]) {
    if (r.w > 0 && r.h > 0) {
      const box = document.createElement("div")
      box.className = "pr-region"
      box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`
      frag.appendChild(box)
      regionEls.push(box)
    }
    const label = document.createElement("div")
    label.className = laid.bands.includes(r) ? "pr-axis-label" : "pr-region-label"
    label.style.cssText = `left:${r.x + 6}px;top:${r.y + 6}px`
    label.textContent = r.key
    frag.appendChild(label)
    regionEls.push(label)
  }
  plane.insertBefore(frag, plane.firstChild)
}

const cardEls = new Map()
function renderCards(laid) {
  const live = new Set()
  for (const n of laid.nodes) {
    live.add(n.id)
    let card = cardEls.get(n.id)
    if (!card) {
      card = document.createElement("div")
      card.className = "pr-card"
      card.tabIndex = -1
      card.dataset.id = n.id
      card.innerHTML =
        `<div><span class="pr-pts"></span><span class="pr-id"></span></div><div class="pr-title"></div><div class="pr-meta"></div>`
      plane.appendChild(card)
      cardEls.set(n.id, card)
    }
    const it = n.issue
    card.className = `pr-card lod${state.lod}`
    card.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;--tile:var(${
      statusVar(it.statusType)
    })`
    // Every level's content is written once; the level class decides what shows, so changing level
    // is a class swap rather than a re-render.
    card.querySelector(".pr-id").textContent = it.id
    card.querySelector(".pr-pts").textContent = it.estimate ?? "–"
    card.querySelector(".pr-title").textContent = it.title
    card.querySelector(".pr-meta").textContent = `${it.assignee} · ${it.milestone ?? "no milestone"}`
  }
  for (const [id, card] of cardEls) {
    if (!live.has(id)) {
      card.remove()
      cardEls.delete(id)
    }
  }
  cardEls.get(laid.nodes[0]?.id)?.setAttribute("tabindex", "0")
}

function renderEdges(laid) {
  const pos = new Map(laid.nodes.map((n) => [n.id, n]))
  const showAll = state.design === "a" || (state.design === "c" && state.mode === "sequence")
  const parts = []
  for (const e of laid.edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    const touches = state.selected === e.from || state.selected === e.to
    if (!showAll && !touches) continue
    const x1 = a.x + a.w
    const y1 = a.y + a.h / 2
    const x2 = b.x
    const y2 = b.y + b.h / 2
    const bend = Math.max(20, Math.abs(x2 - x1) / 2)
    const d = e.kind === "sim"
      ? `M ${a.x + a.w / 2} ${a.y + a.h / 2} L ${b.x + b.w / 2} ${b.y + b.h / 2}`
      : `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
    parts.push(
      `<path class="pr-edge ${e.kind === "sim" ? "sim" : ""} ${touches ? "lit" : ""}" d="${d}" ${
        e.kind === "block" ? 'marker-end="url(#arrow)"' : ""
      }/>`,
    )
  }
  svg.innerHTML =
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--surface1)"/></marker></defs>${
      parts.join("")
    }`
}

function applyHighlight() {
  const sel = state.selected
  const near = new Set()
  if (sel) {
    near.add(sel)
    const it = byId.get(sel)
    for (const id of [...(it.blocks ?? []), ...(it.blockedBy ?? []), ...(it.related ?? [])]) near.add(id)
    for (const n of neighborsOf.get(sel) ?? []) near.add(n.id)
  }
  const hardDim = state.design === "b"
  for (const [id, card] of cardEls) {
    card.classList.toggle("sel", id === sel)
    card.classList.toggle("lit", Boolean(sel) && near.has(id) && id !== sel)
    card.classList.toggle("dim", Boolean(sel) && !near.has(id) && hardDim)
  }
}

// ------------------------------------------------------------------ interaction

function fitView() {
  const w = parseFloat(plane.style.width) || 1
  const h = parseFloat(plane.style.height) || 1
  const rect = viewport.getBoundingClientRect()
  const scale = Math.max(0.08, Math.min(1.4, Math.min(rect.width / w, rect.height / h) * 0.94))
  state.view = { scale, x: (rect.width - w * scale) / 2, y: (rect.height - h * scale) / 2 }
  applyView()
}

// The detail level is a function of how wide a card actually lands on screen, which is the quantity
// that decides whether its text is readable at all.
function applyLod() {
  el("lod").textContent = ["Tiles", "Identity", "Detail"][state.lod]
  for (const card of cardEls.values()) {
    card.classList.remove("lod0", "lod1", "lod2")
    card.classList.add(`lod${state.lod}`)
  }
}

function applyView() {
  plane.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`
  if (!state.autoLod) return
  const onScreen = state.view.scale * CARD_W
  const next = onScreen < 58 ? 0 : onScreen < 112 ? 1 : 2
  if (next !== state.lod) {
    state.lod = next
    applyLod()
  }
}

viewport.addEventListener("wheel", (ev) => {
  ev.preventDefault()
  const rect = viewport.getBoundingClientRect()
  const cx = ev.clientX - rect.left
  const cy = ev.clientY - rect.top
  const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12
  const next = Math.max(0.25, Math.min(2.2, state.view.scale * factor))
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

plane.addEventListener("click", (ev) => {
  const card = ev.target.closest(".pr-card")
  if (!card) return
  state.selected = state.selected === card.dataset.id ? null : card.dataset.id
  applyHighlight()
  renderEdges(current)
})

plane.addEventListener("pointerover", (ev) => {
  const card = ev.target.closest(".pr-card")
  if (!card) return
  const it = byId.get(card.dataset.id)
  const near = (neighborsOf.get(it.id) ?? []).slice(0, 3)
  tip.innerHTML = `<h3>${it.id} · ${it.title}</h3><dl>
    <dt>status</dt><dd>${it.status}</dd>
    <dt>owner</dt><dd>${it.assignee}</dd>
    <dt>points</dt><dd>${it.estimate ?? "unestimated"}</dd>
    <dt>labels</dt><dd>${it.labels.join(", ") || "none"}</dd>
    <dt>blocks</dt><dd>${it.blocks.join(", ") || "nothing"}</dd>
    <dt>similar</dt><dd>${near.map((n) => `${n.id} ${(n.score * 100) | 0}%`).join(", ") || "none"}</dd></dl>`
  const r = card.getBoundingClientRect()
  tip.style.left = `${Math.min(r.right + 8, innerWidth - 340)}px`
  tip.style.top = `${Math.min(r.top, innerHeight - 200)}px`
  tip.hidden = false
})
plane.addEventListener("pointerout", (ev) => {
  if (!ev.relatedTarget?.closest?.(".pr-card")) tip.hidden = true
})

for (const btn of document.querySelectorAll("[data-set]")) {
  btn.addEventListener("click", () => {
    const [key, value] = btn.dataset.set.split(":")
    state[key] = value
    for (const sib of document.querySelectorAll(`[data-set^="${key}:"]`)) {
      sib.setAttribute("aria-pressed", String(sib === btn))
    }
    render(key === "mode")
    if (key === "mode") fitView()
  })
}

el("groupBy").addEventListener("change", (ev) => {
  state.groupBy = ev.target.value
  if (state.mode !== "grouping") {
    state.mode = "grouping"
    for (const sib of document.querySelectorAll('[data-set^="mode:"]')) {
      sib.setAttribute("aria-pressed", String(sib.dataset.set === "mode:grouping"))
    }
  }
  render(true)
  fitView()
})

el("lodToggle").addEventListener("click", () => {
  state.autoLod = !state.autoLod
  el("lodToggle").setAttribute("aria-pressed", String(!state.autoLod))
  el("lodToggle").textContent = state.autoLod ? "Detail: auto" : "Detail: pinned"
  if (!state.autoLod) return
  applyView()
})
el("lodStep").addEventListener("click", () => {
  state.autoLod = false
  el("lodToggle").setAttribute("aria-pressed", "true")
  el("lodToggle").textContent = "Detail: pinned"
  state.lod = (state.lod + 1) % 3
  applyLod()
})

el("reset").addEventListener("click", fitView)

render()
fitView()
