// The one place the editor asks "what may this field be set to for this ticket". Every allowed value
// the modal offers, and every value its validation accepts, comes from fieldOptions() and nothing else.
//
// The lists are derived from the project snapshot the page already loaded, narrowed to the issue's own
// team wherever ingest captured team data (web/lib/issues.js reads the team out of the snapshot): that
// team's workflow states, in the team's order, and that team's estimate scale. A status is offered by
// state name rather than by workflow-state category, because a name is the only way to reach one of
// several states in the same category; the category rides along as `type` so the op can carry both.
//
// Every list is `[{ value, label }]`. `value` carries the field's real type — a string for status,
// assignee, and milestone, a number for cycle, estimate, and priority, and null for "no milestone" or
// "no cycle" — so a caller compares with === and never re-parses a form string.

import { estimateOptions as teamEstimateOptions, teamForIssue, workflowStates } from "./issues.js"

export const DEFAULT_ESTIMATE_SCALE = [0, 1, 2, 3, 5, 8]

export const PRIORITY_OPTIONS = [
  { value: 0, label: "No priority" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
]

export const NONE_LABEL = "— none —"

// A ticket can already hold a value the project's own lists no longer offer (a cycle that rolled off,
// an assignee who left the roster, a workflow state the team retired or one the op model cannot store
// such as Linear's "duplicate" category). Those stay selectable so the form shows what the ticket
// really is instead of silently reading back as an edit nobody made.
function withCurrent(options, current, make) {
  if (current == null || options.some((o) => o.value === current)) return options
  return [...options, make(current)]
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
  const withStale = withCurrent(cycles, issue?.cycle ?? null, (n) => ({ value: n, label: `Cycle ${n}` }))
  return [{ value: null, label: NONE_LABEL }, ...withStale]
}

function milestoneOptions(issue, snapshot) {
  const milestones = (snapshot?.milestones ?? []).map((m) => ({ value: m.key, label: m.name ?? m.key }))
  const withStale = withCurrent(milestones, issue?.milestone ?? null, (k) => ({ value: k, label: k }))
  return [{ value: null, label: NONE_LABEL }, ...withStale]
}

// The team's own scale where the snapshot has one (it carries the t-shirt labels too), else the
// project-wide union ingest wrote, else a plain fibonacci-with-zero list.
function estimateScale(issue, snapshot) {
  const team = teamForIssue(snapshot?.teams, issue)
  const teamScale = teamEstimateOptions(team?.estimation)
  if (teamScale.length) return teamScale
  const ingested = snapshot?.estimateScale
  const scale = ingested?.length ? ingested : DEFAULT_ESTIMATE_SCALE
  return scale.map((n) => ({ value: n, label: String(n) }))
}

function estimateOptions(issue, snapshot) {
  const current = typeof issue?.estimate === "number" ? issue.estimate : null
  const options = withCurrent(estimateScale(issue, snapshot), current, (n) => ({ value: n, label: String(n) }))
  return [...options].sort((a, b) => a.value - b.value)
}

function statusOptions(issue, snapshot) {
  const states = workflowStates(snapshot?.teams, issue).map((s) => ({ value: s.name, label: s.name, type: s.type }))
  return withCurrent(states, issue?.status || null, (name) => ({
    value: name,
    label: name,
    type: issue?.statusType ?? null,
  }))
}

/** Every value each editable field of `issue` may be set to, given the project snapshot behind it. */
export function fieldOptions(issue, snapshot) {
  return {
    assignees: assigneeOptions(issue, snapshot),
    cycles: cycleOptions(issue, snapshot),
    estimates: estimateOptions(issue, snapshot),
    milestones: milestoneOptions(issue, snapshot),
    priorities: PRIORITY_OPTIONS,
    statuses: statusOptions(issue, snapshot),
    teamKey: teamForIssue(snapshot?.teams, issue)?.key ?? null,
  }
}

/** The label an options list gives `value`, falling back to the value itself for something off-list. */
export function labelFor(options, value) {
  const found = (options ?? []).find((o) => o.value === value)
  if (found) return found.label
  return value == null ? "none" : String(value)
}

/** The workflow-state category behind a status option's name, so an op can carry both. */
export function statusTypeFor(options, name) {
  return (options?.statuses ?? []).find((o) => o.value === name)?.type ?? null
}
