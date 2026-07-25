// Review page: the UI for Phase 1's review queue plus in-flow fixes. Renders /api/review (everything
// that changed between the last reviewed capture and the newest one) grouped by ticket, so every change
// to one issue reads as a unit. A change-set can be marked reviewed; reviewed groups dim and sink to the
// bottom, and clearing the last open one advances the server-side review pointer, which is what closes
// the window. Each ticket can also be fixed: its Edit button opens the shared editor modal
// (web/lib/editForm.js), where a change is previewed as a dry run and then applied to the current
// workspace. That write is the one path tlr has to Linear, and it only runs from here. Actor
// attribution (AI vs. me) is out of scope: a snapshot-diff cannot tell them apart.
//
// Per-ticket marks live in localStorage; the durable "reviewed up to here" fact is the server pointer.
// They are keyed by the window's starting snapshot id and by a fingerprint of the ticket's change-set,
// so a later, genuinely different change to the same ticket is never suppressed by an earlier mark.

import { escapeHtml, resolveProject } from "./lib/page.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"
import { openEditModal } from "./lib/editForm.js"
import { showError } from "./lib/errorBanner.js"

applyTheme(loadTheme())

const REVIEWED_KEY = "tlr.reviewed"
const project = await resolveProject()
const pageEl = document.getElementById("page")
const captureBtn = document.getElementById("capture")

let queue = { window: null, items: [] }
let mode = { demo: false, workspace: "live" }
let issuesById = new Map()
let snapshot = { milestones: [], cycles: [], capacity: {}, issues: [] }
let undoTo = null
const reviewed = JSON.parse(localStorage.getItem(REVIEWED_KEY) || "{}")

function fingerprint(changes) {
  const text = changes.map((c) => `${c.kind}:${c.summary}`).sort().join("|")
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = (hash * 33 ^ text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

function windowPrefix() {
  return `${project?.name ?? "?"}#`
}
function windowKey() {
  return `${windowPrefix()}${queue.window?.fromId ?? "none"}`
}

// Marks belong to one window. Once the pointer moves the window's start changes, so every other entry
// for this project is dead weight and is dropped rather than left to grow without bound.
function pruneWindows() {
  const keep = windowKey()
  for (const key of Object.keys(reviewed)) {
    if (key.startsWith(windowPrefix()) && key !== keep) delete reviewed[key]
  }
  localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewed))
}

function isReviewed(group) {
  return reviewed[windowKey()]?.[group.id] === fingerprint(group.changes)
}
function setReviewed(group, done) {
  const forWindow = (reviewed[windowKey()] ||= {})
  if (done) forWindow[group.id] = fingerprint(group.changes)
  else delete forWindow[group.id]
  localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewed))
}

const KIND_LABEL = {
  added: "added",
  archived: "archived",
  moved: "moved",
  reestimated: "re-estimated",
  removed: "removed",
  returning: "returning",
  slop: "slop",
  status: "status",
}

// The year is written only when it isn't the current one, so the common case stays short without
// making a capture from a previous year ambiguous.
function localDay(ms) {
  const d = new Date(ms)
  const withYear = d.getFullYear() !== new Date().getFullYear()
  return d.toLocaleDateString([], { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) })
}
function localClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

// Local time, with the date written once when both ends fall on the same day — at eight captures a day
// most windows are intra-day, and "Jul 24 → Jul 24" says nothing.
function windowLabel(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null
  if (localDay(fromMs) === localDay(toMs)) return `${localDay(fromMs)} ${localClock(fromMs)} → ${localClock(toMs)}`
  return `${localDay(fromMs)} ${localClock(fromMs)} → ${localDay(toMs)} ${localClock(toMs)}`
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
  const done = isReviewed(g)
  const canEdit = issuesById.has(g.id)
  const rows = g.changes.map((c) =>
    `<li><span class="kind k-${c.kind}">${KIND_LABEL[c.kind] ?? c.kind}</span> ${escapeHtml(c.summary)}</li>`
  ).join("")
  const editBtn = canEdit ? `<button class="chip mini" data-edit="${escapeHtml(g.id)}">Edit</button>` : ""
  return `<div class="rgroup${done ? " reviewed" : ""}">` +
    `<div class="rgroup-h"><span class="rid">${escapeHtml(g.id)}</span>` +
    `<span class="rgroup-btns">${editBtn}` +
    `<button class="chip mini" data-review="${escapeHtml(g.id)}">${done ? "Reviewed ✓" : "Mark reviewed"}</button>` +
    `</span></div>` +
    `<ul class="rchanges">${rows}</ul>` +
    `</div>`
}

function metaText(openCount, total) {
  const label = queue.window && windowLabel(queue.window.fromCapturedAt, queue.window.toCapturedAt)
  const heading = label ?? (queue.window ? `${queue.window.from} → ${queue.window.to}` : "no window yet")
  return `${heading} · ${openCount} of ${total} tickets to review`
}

function emptyHTML() {
  if (!queue.window) {
    return `<p class="empty">Need at least two snapshots to review. ` +
      `Capture one now, refresh the board later, and changes will show here.</p>`
  }
  const undo = undoTo === null ? "" : `<button class="chip mini" id="review-undo">Undo, reopen the last window</button>`
  return `<p class="empty">Reviewed up to ${escapeHtml(localClock(queue.window.toCapturedAt))} on ` +
    `${escapeHtml(localDay(queue.window.toCapturedAt))}. The next capture starts a new window.</p>${undo}`
}

function render() {
  const meta = document.getElementById("meta")
  if (!queue.items.length) {
    meta.textContent = queue.window ? "Caught up with every capture so far" : "Nothing to review yet"
    pageEl.innerHTML = emptyHTML()
    wire()
    return
  }
  const groups = groupByTicket(queue.items)
  groups.sort((a, b) => (Number(isReviewed(a)) - Number(isReviewed(b))) || a.id.localeCompare(b.id))
  const openCount = groups.filter((g) => !isReviewed(g)).length
  meta.textContent = metaText(openCount, groups.length)
  pageEl.innerHTML = groups.map(groupHTML).join("")
  wire(groups)
}

// The pointer is what actually closes a window, and it only moves once no ticket in the queue is still
// open. Reloading afterwards is what proves the move stuck rather than assuming it did.
async function advancePointer(snapshotId, previousId) {
  const r = await fetch("/api/review/pointer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: project.name, snapshotId }),
  })
  if (!r.ok) {
    showError(new Error(`pointer update failed (${r.status})`), "Review")
    return
  }
  undoTo = previousId
  await load()
}

function wire(groups = []) {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const undoBtn = document.getElementById("review-undo")
  if (undoBtn) {
    undoBtn.onclick = () => {
      const target = undoTo
      undoTo = null
      advancePointer(target, null)
    }
  }
  for (const btn of pageEl.querySelectorAll("button[data-review]")) {
    btn.onclick = () => {
      const group = byId.get(btn.dataset.review)
      setReviewed(group, !isReviewed(group))
      if (queue.window && groups.every(isReviewed)) {
        advancePointer(queue.window.toId, queue.window.fromId)
        return
      }
      render()
    }
  }
  for (const btn of pageEl.querySelectorAll("button[data-edit]")) {
    btn.onclick = () => {
      const id = btn.dataset.edit
      openEditModal({
        dataFile: project.dataFile,
        issue: issuesById.get(id),
        mode,
        onApplied: async () => {
          await refreshData()
          const group = byId.get(id)
          if (group) setReviewed(group, true)
          render()
        },
        returnFocus: () => pageEl.querySelector(`button[data-edit="${CSS.escape(id)}"]`),
        snapshot,
        source: "review",
      })
    }
  }
}

// The current issue values, so an edit form starts from live data and the diff is against truth.
async function refreshData() {
  const r = await fetch(`/data/${project.dataFile}`, { cache: "no-store" })
  const data = r.ok ? await r.json() : { issues: [] }
  snapshot = { ...data, milestones: data.milestones ?? [], cycles: data.cycles ?? [], issues: data.issues ?? [] }
  issuesById = new Map(snapshot.issues.map((i) => [i.id, i]))
}

async function load() {
  pageEl.innerHTML = `<p class="empty">Loading…</p>`
  const [reviewRes, modeRes] = await Promise.all([
    fetch(`/api/review?project=${encodeURIComponent(project.name)}`, { cache: "no-store" }),
    fetch("/api/mode", { cache: "no-store" }),
  ])
  queue = await reviewRes.json()
  mode = await modeRes.json()
  pruneWindows()
  await refreshData()
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
