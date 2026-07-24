// Review page: the UI for Phase 1's review queue. Renders /api/review (a diff between a project's two
// most recent snapshots) grouped by ticket, so every change to one issue reads as a unit. A change-set
// can be marked reviewed; reviewed groups dim and sink to the bottom, and are never merged with
// unreviewed ones. Actor attribution (AI vs. me) is out of scope here: snapshot-diff cannot tell them
// apart. Temporal 30-minute grouping applies to a future activity-feed source, not a two-point diff.

import { escapeHtml, resolveProject } from "./lib/page.js"

const REVIEWED_KEY = "tlr.reviewed"
const project = await resolveProject()
const pageEl = document.getElementById("page")
const captureBtn = document.getElementById("capture")

let queue = { window: null, items: [] }
const reviewed = JSON.parse(localStorage.getItem(REVIEWED_KEY) || "{}")

function windowKey() {
  return queue.window ? `${queue.window.from}_${queue.window.to}` : "none"
}
function isReviewed(id) {
  return Boolean(reviewed[windowKey()]?.[id])
}
function toggleReviewed(id) {
  const wk = windowKey()
  const forWindow = (reviewed[wk] ||= {})
  if (forWindow[id]) delete forWindow[id]
  else forWindow[id] = true
  localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewed))
  render()
}

const KIND_LABEL = {
  added: "added",
  removed: "removed",
  moved: "moved",
  reestimated: "re-estimated",
  status: "status",
  slop: "slop",
}

function groupByTicket(items) {
  const map = new Map()
  for (const it of items) {
    if (!map.has(it.id)) map.set(it.id, [])
    map.get(it.id).push(it)
  }
  return [...map.entries()].map(([id, changes]) => ({ id, changes }))
}

function groupHTML(g) {
  const done = isReviewed(g.id)
  const rows = g.changes.map((c) =>
    `<li><span class="kind k-${c.kind}">${KIND_LABEL[c.kind] ?? c.kind}</span> ${escapeHtml(c.summary)}</li>`
  ).join("")
  return `<div class="rgroup${done ? " reviewed" : ""}">` +
    `<div class="rgroup-h"><span class="rid">${escapeHtml(g.id)}</span>` +
    `<button class="chip mini" data-id="${escapeHtml(g.id)}">${done ? "Reviewed ✓" : "Mark reviewed"}</button></div>` +
    `<ul class="rchanges">${rows}</ul></div>`
}

function render() {
  if (!queue.items.length) {
    pageEl.innerHTML = `<p class="empty">Nothing to review between the two most recent snapshots. ` +
      `Capture another after some edits and changes will show here.</p>`
    return
  }
  const groups = groupByTicket(queue.items)
  groups.sort((a, b) => (Number(isReviewed(a.id)) - Number(isReviewed(b.id))) || a.id.localeCompare(b.id))
  const openCount = groups.filter((g) => !isReviewed(g.id)).length
  document.getElementById("meta").textContent =
    `${queue.window.from} → ${queue.window.to} · ${openCount} of ${groups.length} tickets to review`
  pageEl.innerHTML = groups.map(groupHTML).join("")
  for (const btn of pageEl.querySelectorAll("button[data-id]")) {
    btn.onclick = () => toggleReviewed(btn.dataset.id)
  }
}

async function load() {
  pageEl.innerHTML = `<p class="empty">Loading…</p>`
  const r = await fetch(`/api/review?project=${encodeURIComponent(project.name)}`, { cache: "no-store" })
  queue = await r.json()
  render()
}

// Entry point last, so the top-level await runs after every const/function above is initialized.
if (!project) {
  document.getElementById("meta").textContent = "No project configured yet."
  captureBtn.hidden = true
} else {
  document.getElementById("title").textContent = `Review · ${project.name}`
  captureBtn.onclick = async () => {
    captureBtn.disabled = true
    captureBtn.textContent = "Capturing…"
    try {
      await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataFile: project.dataFile, label: "manual" }),
      })
      await load()
    } finally {
      captureBtn.disabled = false
      captureBtn.textContent = "Capture snapshot"
    }
  }
  await load()
}
