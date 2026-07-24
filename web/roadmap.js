// Roadmap page: every ticket on one pannable, zoomable 2D plane, replacing the removed Timeline view.
// The layout itself is pure and lives in lib/roadmap.js — x is time, y is dependency-wave depth, and
// cards that would collide in a cell pack into lanes. This file owns the browser half: the Board's
// filters, the hover card, pan/zoom, and keyboard access.
//
// Detail deliberately stays out of the card. A card carries the ticket number, its estimate, and a
// flag glyph; status, assignee, milestone, relations, and the reason for a flag live in the hover card
// (also shown on focus), the same trade the Board already makes.

import { bucketOf, buildBuckets, missingData, orderingRisks, slopHash, slopScan } from "./lib/planning.js"
import { roadmapLayout } from "./lib/roadmap.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"
import { escapeHtml, resolveProject } from "./lib/page.js"
import { showError } from "./lib/errorBanner.js"

const STATUS = {
  started: { label: "In progress", color: "var(--st-started)" },
  unstarted: { label: "Todo", color: "var(--st-unstarted)" },
  triage: { label: "Triage", color: "var(--st-triage)" },
  backlog: { label: "Backlog", color: "var(--st-backlog)" },
  completed: { label: "Done", color: "var(--st-completed)" },
  canceled: { label: "Canceled", color: "var(--st-canceled)" },
}
const FLAGS = { slop: "⚠ slop", risk: "⛔ ordering risk", miss: "◑ missing (in cycle)" }
const DEFAULT_STATUSES = ["started", "unstarted", "triage", "backlog"]
const REVIEW_KEY = "tlr.notslop"
const STORE_KEY = "tlr.roadmap"
const MIN_SCALE = 0.35
const MAX_SCALE = 2.5
const PAN_STEP = 80

applyTheme(loadTheme())

const viewport = document.getElementById("rm-viewport")
const plane = document.getElementById("rm-plane")
const tip = document.getElementById("tip")
const summaryEl = document.getElementById("summary")
const zoomLevelEl = document.getElementById("zoom-level")

const reviewed = JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}")
const state = {
  bucketKeys: null,
  flags: new Set(),
  q: "",
  statuses: new Set(DEFAULT_STATUSES),
  view: { scale: 1, x: 0, y: 0 },
}

let buckets = []
let data = null
let layout = null
let hoverIssue = null
let hideTimer = null
const elById = new Map()

async function loadData(dataFile) {
  const r = await fetch(`/data/${dataFile ?? "cpu.json"}`, { cache: "no-store" })
  return (r.ok ? r : await fetch("/data-sample.json", { cache: "no-store" })).json()
}

function enrich() {
  for (const i of data.issues) {
    i.assignee ||= "Unassigned"
    i.blocks ||= []
    i.blockedBy ||= []
    i.related ||= []
    i._bucket = bucketOf(i)
    i._bucketEnd = (buckets.find((b) => b.key === i._bucket) ?? { end: "9999-12-31" }).end
    i._slop = slopScan(i.description)
    i._slopHash = slopHash(i.description)
    i._miss = missingData(i)
  }
  const riskIds = new Set(orderingRisks(data.issues).flatMap((r) => [r.issue, r.blocker]))
  for (const i of data.issues) i._risk = riskIds.has(i.id) && i.blockedBy.length > 0
}

const isDismissed = (i) => reviewed[i.id] === i._slopHash
const isSlop = (i) => i._slop.score >= 2 && !isDismissed(i)

// Filters, then pan/zoom, round-trip through the URL and localStorage: the URL wins so a shared link
// lands on exactly what the sender saw, and localStorage carries the last view across a plain visit
// to /roadmap. Only non-default values are ever written back, so an untouched page keeps a plain URL.
function hydrateState() {
  const stored = readStore()
  const p = new URLSearchParams(location.search)
  const read = (key) => p.get(key) ?? stored[key] ?? null
  const q = read("q")
  if (q) state.q = q
  const statuses = read("status")
  if (statuses) state.statuses = new Set(statuses.split(",").filter(Boolean))
  const flags = read("flags")
  if (flags) state.flags = new Set(flags.split(",").filter(Boolean))
  const wanted = read("buckets")
  state.bucketKeys = new Set(
    wanted ? buckets.map((b) => b.key).filter((k) => wanted.split(",").includes(k)) : buckets.map((b) => b.key),
  )
  const zoom = Number(read("zoom"))
  if (zoom > 0) state.view.scale = clampScale(zoom)
  const pan = (read("pan") ?? "").split(",").map(Number)
  if (pan.length === 2 && pan.every(Number.isFinite)) {
    state.view.x = pan[0]
    state.view.y = pan[1]
  }
}

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}")
  } catch (err) {
    showError(err, "Reading the saved roadmap view failed")
    return {}
  }
}

function currentParams() {
  const params = {}
  if (state.q) params.q = state.q
  const statuses = [...state.statuses].sort().join(",")
  if (statuses !== [...DEFAULT_STATUSES].sort().join(",")) params.status = statuses
  const selected = [...state.bucketKeys].sort().join(",")
  if (selected !== buckets.map((b) => b.key).sort().join(",")) params.buckets = selected
  if (state.flags.size) params.flags = [...state.flags].join(",")
  if (state.view.scale !== 1) params.zoom = String(Math.round(state.view.scale * 100) / 100)
  if (state.view.x || state.view.y) params.pan = `${Math.round(state.view.x)},${Math.round(state.view.y)}`
  return params
}

function persist() {
  const params = currentParams()
  const url = new URL(location.href)
  for (const key of ["buckets", "flags", "pan", "q", "status", "zoom"]) {
    if (params[key] == null) url.searchParams.delete(key)
    else url.searchParams.set(key, params[key])
  }
  history.replaceState(null, "", url)
  localStorage.setItem(STORE_KEY, JSON.stringify(params))
}

function passes(i) {
  if (!state.statuses.has(i.statusType)) return false
  if (!state.bucketKeys.has(i._bucket)) return false
  if (state.q && !`${i.id} ${i.title} ${i.description}`.toLowerCase().includes(state.q)) return false
  for (const f of state.flags) {
    if (f === "slop" && !isSlop(i)) return false
    if (f === "risk" && !i._risk) return false
    if (f === "miss" && !i._miss.blocking) return false
  }
  return true
}

function paintChip(el, color, pressed) {
  const tint = color || "var(--accent)"
  el.style.color = pressed ? "var(--text)" : "var(--subtext0)"
  el.style.borderColor = pressed ? tint : ""
  el.style.background = pressed ? `color-mix(in srgb, ${tint} 22%, var(--mantle))` : ""
}

function initStatusChips() {
  const host = document.getElementById("status-chips")
  const chips = new Map()
  for (const [key, meta] of Object.entries(STATUS)) {
    const el = document.createElement("button")
    el.className = "chip"
    el.type = "button"
    el.textContent = meta.label
    el.setAttribute("aria-pressed", state.statuses.has(key))
    paintChip(el, meta.color, state.statuses.has(key))
    el.onclick = () => {
      const pressed = el.getAttribute("aria-pressed") !== "true"
      if (pressed) state.statuses.add(key)
      else state.statuses.delete(key)
      el.setAttribute("aria-pressed", pressed)
      paintChip(el, meta.color, pressed)
      render()
    }
    host.appendChild(el)
    chips.set(key, el)
  }
  const sync = () => {
    for (const [key, el] of chips) {
      const pressed = state.statuses.has(key)
      el.setAttribute("aria-pressed", pressed)
      paintChip(el, STATUS[key].color, pressed)
    }
    render()
  }
  document.getElementById("status-all").onclick = () => {
    state.statuses = new Set(Object.keys(STATUS))
    sync()
  }
  document.getElementById("status-none").onclick = () => {
    state.statuses = new Set()
    sync()
  }
}

// Checklist popover shared by the Buckets and Flags filters, the same shape the Board uses so the two
// pages read and behave alike. `badge` returns the count to show on the button, or null when the
// filter is at its default and the button should read as untouched — "every bucket" and "no flag" are
// both defaults, so one rule cannot cover them.
function initChecklist({ badge, btnId, countId, items, listId, panelId, rootId, selected }) {
  const root = document.getElementById(rootId)
  const btn = document.getElementById(btnId)
  const panel = document.getElementById(panelId)
  const countEl = document.getElementById(countId)
  const list = document.getElementById(listId)

  function syncButton() {
    const label = badge(items.filter((it) => selected().has(it.key)).length, items.length)
    countEl.hidden = label == null
    countEl.textContent = label ?? ""
    btn.setAttribute("aria-pressed", label != null)
  }

  function renderList() {
    list.innerHTML = items.map((it) => {
      const checked = selected().has(it.key)
      const label = escapeHtml(it.label)
      return `<li role="option" aria-selected="${checked}">` +
        `<label><input type="checkbox" data-key="${escapeHtml(it.key)}"${checked ? " checked" : ""} /> ` +
        `<span title="${label}">${label}</span></label></li>`
    }).join("")
    for (const cb of list.querySelectorAll("input[type=checkbox]")) {
      cb.onchange = () => {
        if (cb.checked) selected().add(cb.dataset.key)
        else selected().delete(cb.dataset.key)
        syncButton()
        render()
      }
    }
  }

  btn.onclick = () => {
    panel.hidden = !panel.hidden
    btn.setAttribute("aria-expanded", String(!panel.hidden))
    if (!panel.hidden) renderList()
  }
  document.addEventListener("click", (ev) => {
    if (!panel.hidden && !root.contains(ev.target)) {
      panel.hidden = true
      btn.setAttribute("aria-expanded", "false")
    }
  })
  syncButton()
}

function initFilters() {
  initStatusChips()
  initChecklist({
    badge: (n, total) => (n === total ? null : `${n}/${total}`),
    btnId: "bsel-btn",
    countId: "bsel-count",
    items: buckets.map((b) => ({ key: b.key, label: b.name ?? b.label })),
    listId: "bucket-list",
    panelId: "bsel-panel",
    rootId: "bucket-select",
    selected: () => state.bucketKeys,
  })
  initChecklist({
    badge: (n) => (n === 0 ? null : String(n)),
    btnId: "fsel-btn",
    countId: "fsel-count",
    items: Object.entries(FLAGS).map(([key, label]) => ({ key, label })),
    listId: "flag-list",
    panelId: "fsel-panel",
    rootId: "flag-select",
    selected: () => state.flags,
  })
  const search = document.getElementById("search")
  search.value = state.q
  search.oninput = () => {
    state.q = search.value.trim().toLowerCase()
    render()
  }
}

function flagGlyph(i) {
  if (i._risk) return "⛔"
  if (isSlop(i)) return "⚠"
  if (i._miss.blocking) return "◑"
  return ""
}

function warnClass(i) {
  if (i._risk) return "w-risk"
  if (isSlop(i)) return "w-slop"
  if (i._miss.blocking) return "w-miss"
  return ""
}

function cardLabel(i) {
  const st = STATUS[i.statusType]?.label ?? i.statusType
  const flags = [i._risk && "ordering risk", isSlop(i) && "slop", i._miss.blocking && "missing data"].filter(Boolean)
  const wave = layout.cards.find((c) => c.id === i.id)?.wave ?? 0
  const suffix = flags.length ? `. Flags: ${flags.join(", ")}` : ""
  return `${i.id}: ${i.title}. ${st}, ${i.assignee}, ${i.estimate || "no"} points, wave ${wave}${suffix}`
}

function cardHTML(card) {
  const i = card.issue
  const glyph = flagGlyph(i)
  return `<div class="rm-card ${warnClass(i)}" data-id="${escapeHtml(i.id)}" ` +
    `style="left:${card.x}px;top:${card.y}px;width:${card.width}px;height:${card.height}px;` +
    `border-left-color:${STATUS[i.statusType]?.color ?? "var(--surface1)"}">` +
    `<span class="rm-card-top">` +
    `<span class="rm-id">${escapeHtml(i.id)}</span>` +
    (glyph ? `<span class="rm-flag">${glyph}</span>` : "") +
    `<span class="rm-pts">${i.estimate || "–"}</span></span>` +
    `<span class="rm-t">${escapeHtml(i.title)}</span></div>`
}

function edgePath(edge) {
  const bend = Math.max(24, Math.abs(edge.x2 - edge.x1) / 2)
  return `M ${edge.x1} ${edge.y1} C ${edge.x1 + bend} ${edge.y1}, ${edge.x2 - bend} ${edge.y2}, ${edge.x2} ${edge.y2}`
}

function edgesHTML() {
  const marker = (id, color) =>
    `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">` +
    `<path d="M 0 0 L 8 4 L 0 8 z" fill="${color}" /></marker>`
  const paths = layout.edges.map((e) =>
    `<path class="rm-edge${e.backward ? " backward" : ""}" data-from="${escapeHtml(e.from)}" ` +
    `data-to="${escapeHtml(e.to)}" d="${edgePath(e)}" ` +
    `marker-end="url(#${e.backward ? "rm-arrow-backward" : "rm-arrow"})" />`
  ).join("")
  return `<svg class="rm-edges" width="${layout.width}" height="${layout.height}" aria-hidden="true">` +
    `<defs>${marker("rm-arrow", "var(--surface1)")}${marker("rm-arrow-backward", "var(--risk)")}</defs>` +
    paths + `</svg>`
}

function axesHTML() {
  const cols = layout.columns.map((c) =>
    `<div class="rm-col-rule" style="left:${c.x - 15}px;top:0;height:${layout.height}px"></div>` +
    `<div class="rm-col-label" style="left:${c.x}px;width:${c.width}px" title="${escapeHtml(c.date)}">` +
    `${escapeHtml(c.label)}<span class="rm-col-date">${escapeHtml(c.kind === "backlog" ? "unscheduled" : c.date)}` +
    `</span></div>`
  ).join("")
  const rows = layout.rows.map((r) =>
    `<div class="rm-row-rule" style="top:${r.y - 17}px;width:${layout.width}px"></div>` +
    `<div class="rm-row-label" style="top:${r.y}px">${escapeHtml(r.label)}</div>`
  ).join("")
  return cols + rows
}

function render() {
  const shown = data.issues.filter(passes)
  layout = roadmapLayout({ ...data, issues: shown })
  elById.clear()
  plane.style.width = `${layout.width}px`
  plane.style.height = `${layout.height}px`
  plane.innerHTML = layout.cards.length
    ? edgesHTML() + axesHTML() + layout.cards.map(cardHTML).join("")
    : `<p class="rm-empty">Nothing matches these filters.</p>`
  wireCards()
  renderSummary(shown)
  applyView()
  persist()
}

function renderSummary(shown) {
  const active = shown.filter((i) => i.statusType !== "completed" && i.statusType !== "canceled")
  summaryEl.innerHTML = [
    `<span><b>${shown.length}</b> shown</span>`,
    `<span><b>${active.reduce((s, i) => s + (i.estimate || 0), 0)}</b> pts active</span>`,
    `<span><b>${layout.rows.length}</b> dependency waves</span>`,
    `<span><b>${layout.edges.length}</b> blocking edges</span>`,
    `<span style="color:var(--risk)"><b>${layout.edges.filter((e) => e.backward).length}</b> run backward</span>`,
  ].join("")
}

function relText(i) {
  const parts = []
  if (i.blockedBy.length) parts.push(`blocked by ${i.blockedBy.join(", ")}`)
  if (i.blocks.length) parts.push(`blocks ${i.blocks.join(", ")}`)
  if (i.related.length) parts.push(`related ${i.related.join(", ")}`)
  return parts.join(" · ")
}

function showTip(clientX, clientY, i) {
  const rel = relText(i)
  const mile = i.milestone || (i._bucket === "BACKLOG" ? "backlog" : i._bucket)
  const card = layout.cards.find((c) => c.id === i.id)
  tip.innerHTML =
    `<div class="tip-h"><b>${escapeHtml(i.id)}</b><span class="tip-pt">${i.estimate || "–"}pt</span></div>` +
    `<div class="tip-t">${escapeHtml(i.title)}</div>` +
    `<dl class="tip-meta">` +
    `<div><dt>Status</dt><dd>${escapeHtml(STATUS[i.statusType]?.label ?? i.statusType)}</dd></div>` +
    `<div><dt>Assignee</dt><dd>${escapeHtml(i.assignee)}</dd></div>` +
    `<div><dt>Milestone</dt><dd>${escapeHtml(mile)}</dd></div>` +
    (i.cycle ? `<div><dt>Cycle</dt><dd>${i.cycle}</dd></div>` : "") +
    `<div><dt>Wave</dt><dd>${card?.wave ?? 0}</dd></div>` +
    `</dl>` +
    (rel ? `<div class="tip-rel">${escapeHtml(rel)}</div>` : "") +
    (i._risk ? `<div class="tip-f risk">⛔ ordering risk: blocker finishes later</div>` : "") +
    (i._miss.blocking
      ? `<div class="tip-f miss">◑ in cycle, missing: ${escapeHtml(i._miss.flags.join(", "))}</div>`
      : "") +
    (isSlop(i) ? `<div class="tip-f slop">⚠ ${escapeHtml(i._slop.flags.join(", "))}</div>` : "") +
    `<a class="tip-act tip-link" href="${escapeHtml(i.url)}" target="_blank">Open in Linear ↗</a>`
  tip.style.display = "block"
  const w = tip.offsetWidth || 300
  const h = tip.offsetHeight || 140
  tip.style.left = `${Math.max(8, Math.min(clientX + 14, innerWidth - w - 8))}px`
  tip.style.top = `${Math.max(8, Math.min(clientY + 16, innerHeight - h - 8))}px`
}

function hideTip() {
  tip.style.display = "none"
  if (hoverIssue) highlight(hoverIssue, false)
  hoverIssue = null
}

function highlight(i, on) {
  const related = new Set([...i.blockedBy, ...i.blocks])
  for (const [id, el] of elById) {
    el.classList.toggle("hl", on && related.has(id))
    el.classList.toggle("dim", on && !related.has(id) && id !== i.id)
  }
  for (const path of plane.querySelectorAll(".rm-edge")) {
    const touches = path.dataset.from === i.id || path.dataset.to === i.id
    path.classList.toggle("hl", on && touches)
  }
}

function openTipFor(el, i, atPointer) {
  clearTimeout(hideTimer)
  hoverIssue = i
  if (atPointer) showTip(atPointer.clientX, atPointer.clientY, i)
  else {
    const r = el.getBoundingClientRect()
    showTip(r.left, r.bottom - 8, i)
  }
  highlight(i, true)
}

function neighbor(card, key) {
  const horizontal = key === "ArrowLeft" || key === "ArrowRight"
  const dir = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1
  let best = null
  let bestScore = Infinity
  for (const other of layout.cards) {
    if (other === card) continue
    const primary = (horizontal ? other.x - card.x : other.y - card.y) * dir
    if (primary <= 0) continue
    const cross = horizontal ? Math.abs(other.y - card.y) : Math.abs(other.x - card.x)
    const score = primary + cross * 2
    if (score < bestScore) {
      bestScore = score
      best = other
    }
  }
  return best
}

// Only one card is tab-reachable at a time (a roving tabindex, as the Board does); the arrow keys move
// focus between them, and Tab leaves the plane instead of walking hundreds of cards.
function focusCard(card) {
  const el = elById.get(card.id)
  if (!el) return
  for (const other of elById.values()) other.tabIndex = -1
  el.tabIndex = 0
  el.focus()
  panIntoView(card)
}

function wireCards() {
  layout.cards.forEach((card, idx) => {
    const el = plane.querySelector(`.rm-card[data-id="${CSS.escape(card.id)}"]`)
    if (!el) return
    const i = card.issue
    elById.set(card.id, el)
    el.tabIndex = idx === 0 ? 0 : -1
    el.setAttribute("role", "button")
    el.setAttribute("aria-label", cardLabel(i))
    el.addEventListener("mouseenter", (ev) => openTipFor(el, i, ev))
    el.addEventListener("mouseleave", () => {
      hideTimer = setTimeout(hideTip, 160)
    })
    el.addEventListener("focus", () => openTipFor(el, i, null))
    el.addEventListener("blur", () => {
      hideTimer = setTimeout(hideTip, 160)
    })
    el.addEventListener("click", () => {
      if (!dragMoved) globalThis.open(i.url, "_blank")
    })
  })
}

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

function applyView() {
  plane.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`
  zoomLevelEl.textContent = `${Math.round(state.view.scale * 100)}%`
}

function pan(dx, dy) {
  state.view.x += dx
  state.view.y += dy
  applyView()
  persist()
}

function zoomAt(factor, clientX, clientY) {
  const rect = viewport.getBoundingClientRect()
  const px = clientX - rect.left
  const py = clientY - rect.top
  const next = clampScale(state.view.scale * factor)
  const ratio = next / state.view.scale
  state.view.x = px - (px - state.view.x) * ratio
  state.view.y = py - (py - state.view.y) * ratio
  state.view.scale = next
  applyView()
  persist()
}

function zoomCentered(factor) {
  const rect = viewport.getBoundingClientRect()
  zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function resetView() {
  state.view.scale = 1
  state.view.x = 0
  state.view.y = 0
  applyView()
  persist()
}

// Keeps a keyboard-focused card on screen: the plane moves under the viewport rather than the browser
// scrolling it, since the plane is positioned by a transform and has nothing to scroll.
function panIntoView(card) {
  const rect = viewport.getBoundingClientRect()
  const margin = 40
  const left = state.view.x + card.x * state.view.scale
  const top = state.view.y + card.y * state.view.scale
  const right = left + card.width * state.view.scale
  const bottom = top + card.height * state.view.scale
  let dx = 0
  let dy = 0
  if (left < margin) dx = margin - left
  else if (right > rect.width - margin) dx = rect.width - margin - right
  if (top < margin) dy = margin - top
  else if (bottom > rect.height - margin) dy = rect.height - margin - bottom
  if (dx || dy) pan(dx, dy)
}

let dragMoved = false
let drag = null

function initPanZoom() {
  viewport.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return
    dragMoved = false
    drag = { originX: state.view.x, originY: state.view.y, pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY }
    viewport.setPointerCapture(ev.pointerId)
  })
  viewport.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.pointerId) return
    const dx = ev.clientX - drag.x
    const dy = ev.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true
    if (!dragMoved) return
    viewport.classList.add("panning")
    state.view.x = drag.originX + dx
    state.view.y = drag.originY + dy
    applyView()
  })
  const endDrag = (ev) => {
    if (!drag || ev.pointerId !== drag.pointerId) return
    drag = null
    viewport.classList.remove("panning")
    if (dragMoved) persist()
    setTimeout(() => (dragMoved = false), 0)
  }
  viewport.addEventListener("pointerup", endDrag)
  viewport.addEventListener("pointercancel", endDrag)
  viewport.addEventListener("wheel", (ev) => {
    ev.preventDefault()
    zoomAt(ev.deltaY < 0 ? 1.12 : 1 / 1.12, ev.clientX, ev.clientY)
  }, { passive: false })

  document.getElementById("zoom-in").onclick = () => zoomCentered(1.2)
  document.getElementById("zoom-out").onclick = () => zoomCentered(1 / 1.2)
  document.getElementById("zoom-reset").onclick = resetView
}

const PAN_KEYS = {
  ArrowDown: [0, -PAN_STEP],
  ArrowLeft: [PAN_STEP, 0],
  ArrowRight: [-PAN_STEP, 0],
  ArrowUp: [0, PAN_STEP],
}

function onCardKey(ev, el) {
  const card = layout.cards.find((c) => c.id === el.getAttribute("data-id"))
  if (!card) return
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault()
    globalThis.open(card.issue.url, "_blank")
    return
  }
  if (ev.key === "Escape") {
    hideTip()
    el.blur()
    return
  }
  const target = PAN_KEYS[ev.key] ? neighbor(card, ev.key) : null
  if (target) {
    ev.preventDefault()
    focusCard(target)
  }
}

function initKeyboard() {
  viewport.addEventListener("keydown", (ev) => {
    const card = ev.target.closest?.(".rm-card")
    if (card) {
      onCardKey(ev, card)
      return
    }
    if (PAN_KEYS[ev.key]) {
      ev.preventDefault()
      const [dx, dy] = PAN_KEYS[ev.key]
      pan(ev.shiftKey ? dx * 3 : dx, ev.shiftKey ? dy * 3 : dy)
      return
    }
    if (ev.key === "+" || ev.key === "=") {
      ev.preventDefault()
      zoomCentered(1.2)
    } else if (ev.key === "-" || ev.key === "_") {
      ev.preventDefault()
      zoomCentered(1 / 1.2)
    } else if (ev.key === "0") {
      ev.preventDefault()
      resetView()
    }
  })
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideTip()
  })
  tip.onmouseenter = () => clearTimeout(hideTimer)
  tip.onmouseleave = () => hideTip()
}

try {
  const project = await resolveProject()
  data = await loadData(project?.dataFile)
  buckets = buildBuckets(data, data.issues)
  enrich()
  hydrateState()
  document.getElementById("title").textContent = `Roadmap · ${data.project?.name ?? "unknown project"}`
  document.getElementById("meta").textContent =
    `${data.issues.length} issues · time across, dependency depth down · data as of ${data.asOf}`
  initFilters()
  initPanZoom()
  initKeyboard()
  render()
} catch (err) {
  showError(err, "Loading the roadmap failed")
}
