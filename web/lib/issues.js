// Pure transforms that turn Linear project/milestone/cycle/issue data into the shape the board
// reads (project, cycles, currentCycle, milestones, issues). No network or file I/O lives here so
// the logic stays unit-testable; scripts/issues.ts does the fetching and the data-file write.

const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"]

// Linear's issue.priority is 0-4 (0 = no priority). Returns the matching label, or null if unset.
export function priorityLabel(value) {
  return value == null ? null : (PRIORITY_LABELS[value] ?? null)
}

// Milestones are named "M1: Measure and page" by convention; the key is the part before the colon.
export function milestoneKey(name) {
  const colon = name.indexOf(":")
  return colon === -1 ? name : name.slice(0, colon).trim()
}

// Linear projectMilestone nodes → board milestone rows, sorted by target date.
export function buildMilestones(rawMilestones) {
  return rawMilestones
    .map((m) => ({ key: milestoneKey(m.name), name: m.name, target: m.targetDate, progress: m.progress ?? 0 }))
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
}

// Team cycle nodes → board cycle rows { n, start, end }, sorted by cycle number. Cycle numbers are
// only unique within a team, so when a project spans multiple teams (rawCycles pooled from all of
// them) a later team's cycle silently wins any number collision — the board has no per-team cycle
// identity to disambiguate further.
export function buildCycles(rawCycles) {
  const byNumber = new Map(rawCycles.map((c) => [c.number, c]))
  return [...byNumber.values()]
    .map((c) => ({ n: c.number, start: c.startsAt.slice(0, 10), end: c.endsAt.slice(0, 10) }))
    .sort((a, b) => a.n - b.n)
}

// The cycle whose window contains `nowISO`, else the most recent one that already started, else null.
export function currentCycleNumber(cycles, nowISO) {
  const containing = cycles.find((c) => c.start <= nowISO && nowISO < c.end)
  if (containing) return containing.n
  const started = cycles.filter((c) => c.start <= nowISO)
  return started.length ? started[started.length - 1].n : null
}

// Linear team nodes → the board's team rows. Each carries the team's own workflow states in the
// team's display order (Linear's `position`) and its issue-estimation settings, so the editor can
// offer the states and estimate values that team actually uses instead of one hardcoded list.
export function buildTeams(rawTeams) {
  return (rawTeams ?? [])
    .map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      estimation: {
        type: t.issueEstimationType ?? "notUsed",
        allowZero: Boolean(t.issueEstimationAllowZero),
        extended: Boolean(t.issueEstimationExtended),
      },
      states: (t.states?.nodes ?? [])
        .map((s) => ({ id: s.id, name: s.name, type: s.type, position: s.position ?? 0 }))
        .sort((a, b) => a.position - b.position),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

// Linear's four estimate scales, as published in its estimates documentation. `extended` adds two
// more steps to each; t-shirt sizes are stored as the fibonacci numbers and only labelled differently.
const ESTIMATE_SCALES = {
  exponential: { values: [1, 2, 4, 8, 16], extra: [32, 64] },
  fibonacci: { values: [1, 2, 3, 5, 8], extra: [13, 21] },
  linear: { values: [1, 2, 3, 4, 5], extra: [6, 7] },
  tShirt: { values: [1, 2, 3, 5, 8], extra: [13, 21], labels: ["XS", "S", "M", "L", "XL", "XXL", "XXXL"] },
}

// The estimate values a team allows, as { value, label } pairs. Empty when the team does not use
// estimates ("notUsed") or reports a scale this does not know, which is the caller's signal to keep a
// free-text number field rather than offer a closed list it cannot vouch for.
export function estimateOptions(estimation) {
  const scale = ESTIMATE_SCALES[estimation?.type]
  if (!scale) return []
  const values = estimation.extended ? [...scale.values, ...scale.extra] : scale.values
  const options = values.map((value, index) => ({ value, label: scale.labels?.[index] ?? String(value) }))
  return estimation.allowZero ? [{ value: 0, label: "0" }, ...options] : options
}

// Every estimate value any of the project's teams allows, sorted and deduped. A project-wide list is
// only exactly right when the project sits on one team or its teams share a scale; per-team precision
// comes from estimateOptions above, which web/lib/fieldOptions.js prefers when the snapshot carries
// team data. Null when no team uses estimates, so a caller can tell "this project does not estimate"
// from "this project estimates in 1, 2, 3, 5, 8".
export function projectEstimateScale(teams) {
  const values = new Set()
  for (const team of teams ?? []) {
    for (const option of estimateOptions(team.estimation)) values.add(option.value)
  }
  return values.size ? [...values].sort((a, b) => a - b) : null
}

// A Linear identifier is "<TEAM>-<number>", so a snapshot captured before ingest recorded teamKey can
// still name its team.
export function identifierTeamKey(id) {
  const dash = typeof id === "string" ? id.lastIndexOf("-") : -1
  return dash > 0 ? id.slice(0, dash) : null
}

// The team an issue belongs to, or null when the snapshot carries no team data. A project on one team
// resolves to that team even if the issue predates teamKey.
export function teamForIssue(teams, issue) {
  const list = teams ?? []
  if (!list.length) return null
  const key = issue?.teamKey ?? identifierTeamKey(issue?.id)
  return list.find((t) => t.key === key) ?? (list.length === 1 ? list[0] : null)
}

// The status types the op model and every board view understand. A team may define a state outside
// them (Linear's "duplicate" category); offering it would write a statusType the rest of the app has
// no rank, colour, or label for, so it is left out of the editor's choices.
const KNOWN_STATUS_TYPES = ["backlog", "canceled", "completed", "started", "triage", "unstarted"]

// The fallback status list for a snapshot ingested before team states were captured: one state per
// category, in workflow order, matching the labels src/ops.ts writes.
export const DEFAULT_STATUS_OPTIONS = [
  { name: "Backlog", type: "backlog" },
  { name: "Todo", type: "unstarted" },
  { name: "Triage", type: "triage" },
  { name: "In Progress", type: "started" },
  { name: "Done", type: "completed" },
  { name: "Canceled", type: "canceled" },
]

// The workflow states an issue may be moved to, as { name, type }: its own team's states in the team's
// order, else the generic one-per-category list when the snapshot has no team data yet. Two states of
// the same category (a DEV team's In Progress and In Review) both appear, which is the whole reason
// the editor picks a status by name. web/lib/fieldOptions.js turns this into the editor's option list.
export function workflowStates(teams, issue) {
  const team = teamForIssue(teams, issue)
  const states = (team?.states ?? []).filter((s) => KNOWN_STATUS_TYPES.includes(s.type))
  if (!states.length) return DEFAULT_STATUS_OPTIONS.map((s) => ({ ...s }))
  return states.map((s) => ({ name: s.name, type: s.type }))
}

// Raw Linear issue (see scripts/issues.ts's GraphQL query) → the board's issue shape.
export function transformIssue(raw, milestoneKeyById) {
  const blocks = []
  const blockedBy = []
  const related = []
  for (const rel of raw.relations?.nodes ?? []) {
    const identifier = rel.relatedIssue.identifier
    if (rel.type === "blocks") blocks.push(identifier)
    else if (rel.type === "blocked") blockedBy.push(identifier)
    else if (rel.type === "related") related.push(identifier)
  }
  return {
    id: raw.identifier,
    linearId: raw.id,
    // Linear hides archived issues unless the query asks for them, so an archived ticket and one
    // removed from the project look the same downstream. Ingest asks for both and flags which is which.
    archived: Boolean(raw.archivedAt),
    title: raw.title,
    url: raw.url,
    description: raw.description ?? "",
    estimate: raw.estimate ?? null,
    // "Unassigned" (not null) is the sentinel every consumer expects — board.js sorts/groups/compares
    // against the literal string, and a real null crashed that sort (a.localeCompare on null).
    assignee: raw.assignee?.name ?? "Unassigned",
    status: raw.state?.name ?? null,
    statusType: raw.state?.type ?? null,
    // Which team's workflow states and estimate scale apply to this ticket. A project can span teams,
    // and the two need not share either.
    teamKey: raw.team?.key ?? identifierTeamKey(raw.identifier),
    priority: priorityLabel(raw.priority),
    priorityValue: raw.priority ?? null,
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
    parentId: raw.parent?.identifier ?? null,
    milestone: raw.projectMilestone ? milestoneKeyById.get(raw.projectMilestone.id) ?? null : null,
    cycle: raw.cycle?.number ?? null,
    blocks,
    blockedBy,
    // Linear's own "related" link: hand-curated, and the only relationship channel a person sets
    // deliberately rather than as a side effect of sequencing work.
    related,
  }
}

// Make blocking edges symmetric across a fetched set. Linear reports a relation once, on the issue
// that owns it: A blocking B gives A `{type: "blocks", relatedIssue: B}` and gives B nothing, because
// the reverse lives in `inverseRelations`, which the project query does not ask for. Without this pass
// `blockedBy` is empty on every real ingest, so anything reading blockers (dependency waves, chain
// risk, the ordering check in the impact pane) sees a graph with no depth.
//
// This only pairs up edges where both endpoints are in the set, so a blocker in another project stays
// invisible. Fetching `inverseRelations` would catch those, at the cost of another nested connection
// in a query already sized against Linear's complexity budget.
export function linkRelations(issues) {
  const byId = new Map(issues.map((i) => [i.id, i]))
  for (const i of issues) {
    for (const target of i.blocks ?? []) {
      const other = byId.get(target)
      if (other && !(other.blockedBy ??= []).includes(i.id)) other.blockedBy.push(i.id)
    }
    for (const source of i.blockedBy ?? []) {
      const other = byId.get(source)
      if (other && !(other.blocks ??= []).includes(i.id)) other.blocks.push(i.id)
    }
    // "related" is undirected, but Linear still reports it once, on the issue that owns it.
    for (const target of i.related ?? []) {
      const other = byId.get(target)
      if (other && !(other.related ??= []).includes(i.id)) other.related.push(i.id)
    }
  }
  for (const i of issues) {
    i.blocks = [...new Set(i.blocks ?? [])].sort()
    i.blockedBy = [...new Set(i.blockedBy ?? [])].sort()
    i.related = [...new Set(i.related ?? [])].sort()
  }
  return issues
}

// Ingest fetches archived issues on purpose (see transformIssue), so every snapshot and data file
// carries them. Only the diff and the review queue want them: they exist to tell an archive apart
// from a removal. Everything that describes the plan as it stands — the board, the roadmap plane,
// capacity, the forecast, the slop scan, the timeline, the balancer, the SVG exports — counts live
// work only, and narrows its input through these before doing anything else.
export function isArchivedIssue(issue) {
  return issue?.archived === true
}

export function liveIssues(issues) {
  return (issues ?? []).filter((i) => !isArchivedIssue(i))
}

export function liveSnapshot(snapshot) {
  return { ...snapshot, issues: liveIssues(snapshot?.issues) }
}

// Add or update a project's entry in the projects.json manifest (keyed by slug), so the switcher can
// discover every project that's been ingested regardless of what data file it was written to.
export function upsertProjectManifest(manifest, entry) {
  const others = manifest.filter((p) => p.slug !== entry.slug)
  return [...others, entry].sort((a, b) => a.name.localeCompare(b.name))
}

// upsertProjectManifest keys on slug alone, so the same project ingested under two slugs (a
// hand-written entry, then Linear's own slugId) leaves two manifest rows pointing at one data file
// and the scheduled run tries to refresh it twice. The most recent row for a file wins.
export function dedupeByDataFile(entries) {
  const newestByFile = new Map(entries.map((entry) => [entry.dataFile, entry]))
  return entries.filter((entry) => newestByFile.get(entry.dataFile) === entry)
}

// Pick a project from the manifest (see scripts/issues.ts's projects.json upsert): the requested slug
// if it's in the list, else the first entry, else null if the manifest is empty.
export function pickProject(projects, requestedSlug) {
  if (!projects.length) return null
  return projects.find((p) => p.slug === requestedSlug) ?? projects[0]
}

// Replace the Linear-sourced blocks (project, cycles, currentCycle, milestones, issues, asOf) in an
// existing data file, keeping everything else (capacity, teamVelocity, teamCapacityPerCycle, ...)
// untouched — those are refreshed by their own scripts, not by ingest.
export function mergeIngest(existing, fresh) {
  return { ...existing, ...fresh }
}
