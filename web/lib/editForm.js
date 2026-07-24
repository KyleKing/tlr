// Shared in-flow edit form: title/description/estimate/priority/milestone/status/cycle/assignee,
// preview (dry run) then apply to Linear. Used by the Review page and the Board's hover card — the
// same op-and-apply path (POST /api/edit), just triggered from two different places.

import { escapeHtml } from "./page.js"

export const PRIORITIES = [[0, "No priority"], [1, "Urgent"], [2, "High"], [3, "Medium"], [4, "Low"]]
export const STATUSES = [
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

// The inline edit form for a ticket, pre-filled from its current values (`cur`). Empty string if `cur`
// is missing (a removed ticket, or one tlr never ingested from Linear).
export function editFormHTML(cur, boardData, mode) {
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
  return `<form class="editf" data-id="${escapeHtml(cur.id)}"${cur.linearId ? "" : ' data-nouuid="1"'}>
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

// Build the ops for a form by comparing each field to the ticket's current value (`cur`). Only changed
// fields become ops, so an untouched form applies nothing.
function formOps(form, cur) {
  const id = form.dataset.id
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

async function postEdit(dataFile, ops, confirm) {
  const r = await fetch("/api/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataFile, ops, confirm }),
  })
  return await r.json()
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

// Wires a rendered editFormHTML()'s Preview/Apply/Cancel buttons. `cur` is the ticket's current value
// (same shape passed to editFormHTML); `mode.demo` picks the apply button's label. onApplied(results)
// fires after every op in a successful apply; the caller decides what to refresh/re-render.
export function wireForm(form, cur, dataFile, mode, { onApplied, onCancel } = {}) {
  const out = form.querySelector(".editf-out")
  const applyBtn = form.querySelector('[data-act="apply"]')
  const previewBtn = form.querySelector('[data-act="preview"]')
  const noUuid = form.dataset.nouuid === "1"

  const show = (text) => {
    out.hidden = false
    out.textContent = text
  }

  previewBtn.onclick = async () => {
    const ops = formOps(form, cur)
    if (!ops.length) return show("No changes to preview.")
    const res = await postEdit(dataFile, ops, false)
    if (res.error) return show(`Error: ${res.details ?? res.error}`)
    const lines = (res.willApply ?? []).map((op) => `• ${describeOp(op)}`)
    for (const s of res.skipped ?? []) lines.push(`skip ${s.op.kind} on ${s.op.id} — ${s.reason}`)
    show(lines.join("\n"))
    applyBtn.disabled = noUuid || !(res.willApply ?? []).length
  }

  applyBtn.onclick = async () => {
    const ops = formOps(form, cur)
    if (!ops.length) return
    applyBtn.disabled = true
    applyBtn.textContent = "Applying…"
    try {
      const res = await postEdit(dataFile, ops, true)
      if (res.error) {
        show(`Error: ${res.details ?? res.error}`)
        applyBtn.disabled = false
        return
      }
      const lines = (res.results ?? []).map((r) => (r.ok ? `✓ ${r.id} updated` : `✗ ${r.id} — ${r.error}`))
      show(lines.join("\n") || "Nothing applied.")
      const allOk = (res.results ?? []).length > 0 && res.results.every((r) => r.ok)
      if (allOk) await onApplied?.(res.results)
    } finally {
      applyBtn.textContent = mode.demo ? "Apply to demo workspace" : "Apply to live workspace"
    }
  }

  form.querySelector('[data-act="cancel"]').onclick = () => onCancel?.()
}
