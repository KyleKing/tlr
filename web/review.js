// Review page: the UI for Phase 1's review queue plus in-flow fixes. Renders /api/review (a diff between
// a project's two most recent snapshots) grouped by ticket, so every change to one issue reads as a
// unit. A change-set can be marked reviewed; reviewed groups dim and sink to the bottom. Each ticket can
// also be fixed in place: edit its title, description, estimate, or priority, preview the change (a dry
// run, nothing leaves the process), then apply it to the current workspace. That write is the one path
// tlr has to Linear, and it only runs from here. Actor attribution (AI vs. me) is out of scope: a
// snapshot-diff cannot tell them apart.

import { escapeHtml, resolveProject } from "./lib/page.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"
import { editFormHTML, wireForm } from "./lib/editForm.js"

applyTheme(loadTheme())

const REVIEWED_KEY = "tlr.reviewed"
const project = await resolveProject()
const pageEl = document.getElementById("page")
const captureBtn = document.getElementById("capture")

let queue = { window: null, items: [] }
let mode = { demo: false, workspace: "live" }
let issuesById = new Map()
let boardData = { milestones: [], cycles: [], capacity: {} }
const editing = new Set()
const reviewed = JSON.parse(localStorage.getItem(REVIEWED_KEY) || "{}")

function windowKey() {
  return queue.window ? `${queue.window.from}_${queue.window.to}` : "none"
}
function isReviewed(id) {
  return Boolean(reviewed[windowKey()]?.[id])
}
function setReviewed(id, done) {
  const forWindow = (reviewed[windowKey()] ||= {})
  if (done) forWindow[id] = true
  else delete forWindow[id]
  localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewed))
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
  const canEdit = issuesById.has(g.id)
  const open = editing.has(g.id)
  const rows = g.changes.map((c) =>
    `<li><span class="kind k-${c.kind}">${KIND_LABEL[c.kind] ?? c.kind}</span> ${escapeHtml(c.summary)}</li>`
  ).join("")
  const editBtn = canEdit
    ? `<button class="chip mini" data-edit="${escapeHtml(g.id)}">${open ? "Close" : "Edit"}</button>`
    : ""
  return `<div class="rgroup${done ? " reviewed" : ""}">` +
    `<div class="rgroup-h"><span class="rid">${escapeHtml(g.id)}</span>` +
    `<span class="rgroup-btns">${editBtn}` +
    `<button class="chip mini" data-review="${escapeHtml(g.id)}">${done ? "Reviewed ✓" : "Mark reviewed"}</button>` +
    `</span></div>` +
    `<ul class="rchanges">${rows}</ul>` +
    (open ? editFormHTML(issuesById.get(g.id), boardData, mode) : "") +
    `</div>`
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
  wire()
}

function wire() {
  for (const btn of pageEl.querySelectorAll("button[data-review]")) {
    btn.onclick = () => {
      setReviewed(btn.dataset.review, !isReviewed(btn.dataset.review))
      render()
    }
  }
  for (const btn of pageEl.querySelectorAll("button[data-edit]")) {
    btn.onclick = () => {
      const id = btn.dataset.edit
      if (editing.has(id)) editing.delete(id)
      else editing.add(id)
      render()
    }
  }
  for (const form of pageEl.querySelectorAll("form.editf")) {
    const id = form.dataset.id
    wireForm(form, issuesById.get(id), project.dataFile, mode, {
      onApplied: async () => {
        await refreshData()
        setReviewed(id, true)
        editing.delete(id)
        render()
      },
      onCancel: () => {
        editing.delete(id)
        render()
      },
    })
  }
}

// The current issue values, so an edit form starts from live data and the diff is against truth.
async function refreshData() {
  const r = await fetch(`/data/${project.dataFile}`, { cache: "no-store" })
  const data = r.ok ? await r.json() : { issues: [] }
  boardData = { milestones: data.milestones ?? [], cycles: data.cycles ?? [], capacity: data.capacity ?? {} }
  issuesById = new Map((data.issues ?? []).map((i) => [i.id, i]))
}

async function load() {
  pageEl.innerHTML = `<p class="empty">Loading…</p>`
  const [reviewRes, modeRes] = await Promise.all([
    fetch(`/api/review?project=${encodeURIComponent(project.name)}`, { cache: "no-store" }),
    fetch("/api/mode", { cache: "no-store" }),
  ])
  queue = await reviewRes.json()
  mode = await modeRes.json()
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
