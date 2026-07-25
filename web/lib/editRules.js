// The editor's rules, with no DOM in sight: read a ticket's current values, normalize what a form
// holds, say whether that is allowed, say what actually changed, and turn those changes into the ops
// POST /api/edit takes. The modal renders these results; it never decides any of them itself.

import { labelFor } from "./fieldOptions.js"

export const TITLE_MAX = 255

const FIELD_LABELS = {
  assignee: "Assignee",
  cycle: "Cycle",
  description: "Description",
  estimate: "Estimate",
  milestone: "Milestone",
  priority: "Priority",
  status: "Status",
  title: "Title",
}

const OPTIONS_FOR = {
  assignee: "assignees",
  cycle: "cycles",
  estimate: "estimates",
  milestone: "milestones",
  priority: "priorities",
  status: "statuses",
}

function toNumberOrNull(raw) {
  if (raw == null || raw === "") return null
  return Number(raw)
}

/** The editable values a ticket currently holds, in the same shape a normalized form produces. */
export function issueValues(issue) {
  return {
    assignee: issue?.assignee || "Unassigned",
    cycle: issue?.cycle ?? null,
    description: issue?.description ?? "",
    estimate: typeof issue?.estimate === "number" ? issue.estimate : null,
    milestone: issue?.milestone ?? null,
    priority: issue?.priorityValue ?? 0,
    status: issue?.statusType ?? "",
    title: issue?.title ?? "",
  }
}

/** Form strings to real typed values. An empty estimate, cycle, or milestone reads as null. */
export function normalizeValues(raw) {
  return {
    assignee: raw?.assignee || "Unassigned",
    cycle: toNumberOrNull(raw?.cycle),
    description: raw?.description ?? "",
    estimate: toNumberOrNull(raw?.estimate),
    milestone: raw?.milestone === "" || raw?.milestone == null ? null : raw.milestone,
    priority: raw?.priority == null || raw.priority === "" ? 0 : Number(raw.priority),
    status: raw?.status ?? "",
    title: raw?.title ?? "",
  }
}

function offList(options, value) {
  return !(options ?? []).some((o) => o.value === value)
}

// Blank means "leave the estimate alone" rather than "clear it": there is no op that removes an
// estimate, so an empty field must not read as a change the preview would promise and the write drop.
function estimateError(value, options) {
  if (value === null) return null
  if (!Number.isFinite(value)) return "Estimate must be a number."
  if (offList(options, value)) {
    return `Estimate must be one of ${(options ?? []).map((o) => o.value).join(", ")}.`
  }
  return null
}

function titleError(value) {
  const title = value.trim()
  if (!title) return "Title cannot be empty."
  if (title.length > TITLE_MAX) return `Title is ${title.length} characters; the cap is ${TITLE_MAX}.`
  return null
}

/**
 * Whether a normalized set of values may be written, and why not per field.
 * Returns `{ ok, errors }` where errors maps a field name to one sentence for that field's input.
 */
export function validateEdit(values, options) {
  /** @type {Record<string, string>} */
  const errors = {}
  const title = titleError(values.title)
  if (title) errors.title = title
  const estimate = estimateError(values.estimate, options?.estimates)
  if (estimate) errors.estimate = estimate
  if (offList(options?.cycles, values.cycle)) errors.cycle = "That cycle is not one of this team's cycles."
  if (offList(options?.milestones, values.milestone)) errors.milestone = "That milestone is not in this project."
  if (offList(options?.statuses, values.status)) errors.status = "That status is not available for this team."
  if (offList(options?.assignees, values.assignee)) errors.assignee = "That assignee is not on the roster."
  if (offList(options?.priorities, values.priority)) errors.priority = "That priority is not a Linear priority."
  return { ok: Object.keys(errors).length === 0, errors }
}

function displayValue(field, value, options) {
  if (field === "description") return `${(value ?? "").length} chars`
  if (field === "title") return value
  return labelFor(options?.[OPTIONS_FOR[field]], value)
}

/**
 * The fields whose form value differs from the ticket's, each with the old and new value already
 * written for a reader. A blank estimate is never a change (see estimateError), and a title is
 * compared trimmed, so trailing whitespace alone does not count as an edit.
 */
export function changedFields(issue, values, options) {
  const current = issueValues(issue)
  const next = { ...values, title: values.title.trim() }
  const changed = []
  for (const field of Object.keys(FIELD_LABELS).sort()) {
    if (field === "estimate" && next.estimate === null) continue
    if (next[field] === current[field]) continue
    changed.push({
      field,
      label: FIELD_LABELS[field],
      from: displayValue(field, current[field], options),
      to: displayValue(field, next[field], options),
      fromValue: current[field],
      toValue: next[field],
    })
  }
  return changed
}

const OP_FOR = {
  assignee: (id, assignee) => ({ kind: "set_assignee", id, assignee }),
  cycle: (id, cycle) => ({ kind: "set_cycle", id, cycle }),
  description: (id, description) => ({ kind: "set_description", id, description }),
  estimate: (id, estimate) => ({ kind: "set_estimate", id, estimate }),
  milestone: (id, milestone) => ({ kind: "set_milestone", id, milestone }),
  priority: (id, priority) => ({ kind: "set_priority", id, priority }),
  status: (id, status) => ({ kind: "set_status", id, status }),
  title: (id, title) => ({ kind: "rename", id, title }),
}

/** The /api/edit ops for a changedFields() list. Only changed fields become ops. */
export function opsForChanges(id, changed) {
  return changed.map((c) => OP_FOR[c.field](id, c.toValue))
}

/** The pending edit as a plain field → new value map, for anything that wants it without the labels. */
export function pendingEdit(changed) {
  return Object.fromEntries(changed.map((c) => [c.field, c.toValue]))
}
