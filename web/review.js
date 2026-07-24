// Review page: the UI for Phase 1's review queue plus in-flow fixes. Renders /api/review (a diff between
// a project's two most recent snapshots) grouped by ticket, so every change to one issue reads as a
// unit. A change-set can be marked reviewed; reviewed groups dim and sink to the bottom. Each ticket can
// also be fixed in place: edit its title, description, estimate, or priority, preview the change (a dry
// run, nothing leaves the process), then apply it to the current workspace. That write is the one path
// tlr has to Linear, and it only runs from here. Actor attribution (AI vs. me) is out of scope: a
// snapshot-diff cannot tell them apart.

import { escapeHtml, resolveProject } from "./lib/page.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"

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

const PRIORITIES = [[0, "No priority"], [1, "Urgent"], [2, "High"], [3, "Medium"], [4, "Low"]]
const STATUSES = [
  ["unstarted", "Todo"],
  ["started", "In Progress"],
  ["triage", "Triage"],
  ["backlog", "Backlog"],
  ["completed", "Done"],
  ["canceled", "Canceled"],
]

function optionTags(pairs, selected) {
  return pairs
    .map(([value, label]) =>
      `<option value="${escapeHtml(String(value))}"${String(value) === String(selected) ? " selected" : ""}>${
        escapeHtml(label)
      }</option>`
    )
    .join("")
}

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

// The inline edit form for a ticket, pre-filled from its current values. Absent for a removed ticket
// (nothing left to edit) or one tlr never ingested from Linear (no UUID, so a write would fail).
function editFormHTML(id) {
  const cur = issuesById.get(id)
  if (!cur) return ""
  const opts = PRIORITIES
    .map(([v, label]) => `<option value="${v}"${(cur.priorityValue ?? 0) === v ? " selected" : ""}>${label}</option>`)
    .join("")
  const milestoneOpts = `<option value="">— none —</option>` +
    optionTags((boardData.milestones ?? []).map((m) => [m.key, m.name]), cur.milestone ?? "")
  const cycleOpts = `<option value="">— none —</option>` +
    optionTags((boardData.cycles ?? []).map((c) => [c.n, `Cycle ${c.n}`]), cur.cycle ?? "")
  // Roster names, plus the ticket's current assignee if it is not on the roster, so it stays selectable.
  const names = new Set(Object.keys(boardData.capacity?.roster ?? {}))
  if (cur.assignee && cur.assignee !== "Unassigned") names.add(cur.assignee)
  const assigneeOpts = optionTags(
    [["Unassigned", "Unassigned"], ...[...names].sort().map((n) => [n, n])],
    cur.assignee ?? "Unassigned",
  )
  const applyLabel = mode.demo ? "Apply to demo workspace" : "Apply to live workspace"
  return `<form class="editf" data-id="${escapeHtml(id)}"${cur.linearId ? "" : ' data-nouuid="1"'}>
    <label>Title<input name="title" type="text" value="${escapeHtml(cur.title)}" /></label>
    <label>Description<textarea name="description" rows="4">${escapeHtml(cur.description ?? "")}</textarea></label>
    <div class="editf-row">
      <label>Estimate<input name="estimate" type="number" min="0" step="1" value="${cur.estimate ?? ""}" /></label>
      <label>Priority<select name="priority">${opts}</select></label>
    </div>
    <div class="editf-row">
      <label>Milestone<select name="milestone">${milestoneOpts}</select></label>
      <label>Status<select name="status">${optionTags(STATUSES, cur.statusType)}</select></label>
    </div>
    <div class="editf-row">
      <label>Cycle<select name="cycle">${cycleOpts}</select></label>
      <label>Assignee<select name="assignee">${assigneeOpts}</select></label>
    </div>
    ${
    cur.linearId ? "" : `<p class="editf-warn">No Linear link for this ticket — refresh from Linear before editing.</p>`
  }
    <div class="editf-actions">
      <button type="button" class="chip" data-act="preview">Preview</button>
      <button type="button" class="chip ${mode.demo ? "" : "danger"}" data-act="apply" disabled>${applyLabel}</button>
      <button type="button" class="chip ghost" data-act="cancel">Cancel</button>
    </div>
    <pre class="editf-out" hidden></pre>
  </form>`
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
    (open ? editFormHTML(g.id) : "") +
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
  for (const form of pageEl.querySelectorAll("form.editf")) wireForm(form)
}

// Build the ops for a form by comparing each field to the ticket's current value. Only changed fields
// become ops, so an untouched form applies nothing.
function formOps(form) {
  const id = form.dataset.id
  const cur = issuesById.get(id)
  const ops = []
  const title = form.title.value.trim()
  if (title && title !== cur.title) ops.push({ kind: "rename", id, title })
  const description = form.description.value
  if (description !== (cur.description ?? "")) ops.push({ kind: "set_description", id, description })
  const estimate = form.estimate.value === "" ? null : Number(form.estimate.value)
  if (estimate != null && estimate !== cur.estimate) ops.push({ kind: "set_estimate", id, estimate })
  const priority = Number(form.priority.value)
  if (priority !== (cur.priorityValue ?? 0)) ops.push({ kind: "set_priority", id, priority })
  const milestone = form.milestone.value || null
  if (milestone !== (cur.milestone ?? null)) ops.push({ kind: "set_milestone", id, milestone })
  const status = form.status.value
  if (status !== cur.statusType) ops.push({ kind: "set_status", id, status })
  const cycle = form.cycle.value === "" ? null : Number(form.cycle.value)
  if (cycle !== (cur.cycle ?? null)) ops.push({ kind: "set_cycle", id, cycle })
  const assignee = form.assignee.value
  if (assignee !== (cur.assignee ?? "Unassigned")) ops.push({ kind: "set_assignee", id, assignee })
  return ops
}

async function postEdit(ops, confirm) {
  const r = await fetch("/api/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataFile: project.dataFile, ops, confirm }),
  })
  return await r.json()
}

function wireForm(form) {
  const out = form.querySelector(".editf-out")
  const applyBtn = form.querySelector('[data-act="apply"]')
  const previewBtn = form.querySelector('[data-act="preview"]')
  const noUuid = form.dataset.nouuid === "1"

  const show = (text) => {
    out.hidden = false
    out.textContent = text
  }

  previewBtn.onclick = async () => {
    const ops = formOps(form)
    if (!ops.length) return show("No changes to preview.")
    const res = await postEdit(ops, false)
    if (res.error) return show(`Error: ${res.details ?? res.error}`)
    const lines = (res.willApply ?? []).map((op) => `• ${describeOp(op)}`)
    for (const s of res.skipped ?? []) lines.push(`skip ${s.op.kind} on ${s.op.id} — ${s.reason}`)
    show(lines.join("\n"))
    applyBtn.disabled = noUuid || !(res.willApply ?? []).length
  }

  applyBtn.onclick = async () => {
    const ops = formOps(form)
    if (!ops.length) return
    applyBtn.disabled = true
    applyBtn.textContent = "Applying…"
    try {
      const res = await postEdit(ops, true)
      if (res.error) {
        show(`Error: ${res.details ?? res.error}`)
        applyBtn.disabled = false
        return
      }
      const lines = (res.results ?? []).map((r) => (r.ok ? `✓ ${r.id} updated` : `✗ ${r.id} — ${r.error}`))
      show(lines.join("\n") || "Nothing applied.")
      const allOk = (res.results ?? []).length > 0 && res.results.every((r) => r.ok)
      if (allOk) {
        await refreshData()
        setReviewed(form.dataset.id, true)
        editing.delete(form.dataset.id)
        render()
      }
    } finally {
      applyBtn.textContent = mode.demo ? "Apply to demo workspace" : "Apply to live workspace"
    }
  }

  form.querySelector('[data-act="cancel"]').onclick = () => {
    editing.delete(form.dataset.id)
    render()
  }
}

function describeOp(op) {
  switch (op.kind) {
    case "rename":
      return `title → "${op.title}"`
    case "set_description":
      return `description → ${op.description.length} chars`
    case "set_estimate":
      return `estimate → ${op.estimate}`
    case "set_priority":
      return `priority → ${PRIORITIES[op.priority][1]}`
    case "set_milestone":
      return `milestone → ${op.milestone ?? "none"}`
    case "set_status":
      return `status → ${op.status}`
    case "set_cycle":
      return `cycle → ${op.cycle ?? "none"}`
    case "set_assignee":
      return `assignee → ${op.assignee}`
    default:
      return op.kind
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
