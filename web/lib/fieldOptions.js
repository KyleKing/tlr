// The one place the editor asks "what may this field be set to for this ticket". Every allowed value
// the modal offers, and every value its validation accepts, comes from fieldOptions() and nothing else.
//
// The lists are derived from the project snapshot the page already loaded. `snapshot.estimateScale`
// (the union of every estimate the project's teams allow) is used whenever ingest has written it.
// Team-scoped workflow states are the remaining swap: once a status op can name a real Linear state
// instead of a category, read `snapshot.teams` for `issue.teamKey` here and every caller — the modal,
// its validation, the changed-field diff — follows without another edit.
//
// Every list is `[{ value, label }]`. `value` carries the field's real type — a string for status,
// assignee, and milestone, a number for cycle, estimate, and priority, and null for "no milestone" or
// "no cycle" — so a caller compares with === and never re-parses a form string.

export const DEFAULT_ESTIMATE_SCALE = [0, 1, 2, 3, 5, 8]

export const PRIORITY_OPTIONS = [
  { value: 0, label: "No priority" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
]

// Workflow order, not alphabetical: this is the order the select draws, and a ticket moves down it.
export const STATUS_OPTIONS = [
  { value: "triage", label: "Triage" },
  { value: "backlog", label: "Backlog" },
  { value: "unstarted", label: "Todo" },
  { value: "started", label: "In Progress" },
  { value: "completed", label: "Done" },
  { value: "canceled", label: "Canceled" },
]

export const NONE_LABEL = "— none —"

// A ticket can already hold a value the project's own lists no longer offer (a cycle that rolled off,
// an assignee who left the roster). Those stay selectable so the form shows what the ticket really is
// instead of silently reading back as an edit nobody made.
function withCurrent(options, current, label) {
  if (current == null || options.some((o) => o.value === current)) return options
  return [...options, { value: current, label: label(current) }]
}

function assigneeOptions(issue, snapshot) {
  const names = new Set(Object.keys(snapshot?.capacity?.roster ?? {}))
  if (issue?.assignee && issue.assignee !== "Unassigned") names.add(issue.assignee)
  return [
    { value: "Unassigned", label: "Unassigned" },
    ...[...names].sort().map((n) => ({ value: n, label: n })),
  ]
}

function cycleOptions(issue, snapshot) {
  const cycles = (snapshot?.cycles ?? []).map((c) => ({ value: c.n, label: `Cycle ${c.n}` }))
  return [{ value: null, label: NONE_LABEL }, ...withCurrent(cycles, issue?.cycle ?? null, (n) => `Cycle ${n}`)]
}

function milestoneOptions(issue, snapshot) {
  const milestones = (snapshot?.milestones ?? []).map((m) => ({ value: m.key, label: m.name ?? m.key }))
  return [{ value: null, label: NONE_LABEL }, ...withCurrent(milestones, issue?.milestone ?? null, (k) => k)]
}

function estimateOptions(issue, snapshot) {
  const ingested = snapshot?.estimateScale
  const scale = ingested?.length ? ingested : DEFAULT_ESTIMATE_SCALE
  const values = new Set(scale)
  if (typeof issue?.estimate === "number") values.add(issue.estimate)
  return [...values].sort((a, b) => a - b).map((n) => ({ value: n, label: String(n) }))
}

/** Every value each editable field of `issue` may be set to, given the project snapshot behind it. */
export function fieldOptions(issue, snapshot) {
  return {
    assignees: assigneeOptions(issue, snapshot),
    cycles: cycleOptions(issue, snapshot),
    estimates: estimateOptions(issue, snapshot),
    milestones: milestoneOptions(issue, snapshot),
    priorities: PRIORITY_OPTIONS,
    statuses: snapshot?.workflowStates ?? STATUS_OPTIONS,
  }
}

/** The label an options list gives `value`, falling back to the value itself for something off-list. */
export function labelFor(options, value) {
  const found = (options ?? []).find((o) => o.value === value)
  if (found) return found.label
  return value == null ? "none" : String(value)
}
