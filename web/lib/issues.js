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

// Raw Linear issue (see scripts/issues.ts's GraphQL query) → the board's issue shape.
export function transformIssue(raw, milestoneKeyById) {
  const blocks = []
  const blockedBy = []
  for (const rel of raw.relations?.nodes ?? []) {
    const identifier = rel.relatedIssue.identifier
    if (rel.type === "blocks") blocks.push(identifier)
    else if (rel.type === "blocked") blockedBy.push(identifier)
  }
  return {
    id: raw.identifier,
    linearId: raw.id,
    title: raw.title,
    url: raw.url,
    description: raw.description ?? "",
    estimate: raw.estimate ?? null,
    // "Unassigned" (not null) is the sentinel every consumer expects — board.js sorts/groups/compares
    // against the literal string, and a real null crashed that sort (a.localeCompare on null).
    assignee: raw.assignee?.name ?? "Unassigned",
    status: raw.state?.name ?? null,
    statusType: raw.state?.type ?? null,
    priority: priorityLabel(raw.priority),
    priorityValue: raw.priority ?? null,
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
    parentId: raw.parent?.identifier ?? null,
    milestone: raw.projectMilestone ? milestoneKeyById.get(raw.projectMilestone.id) ?? null : null,
    cycle: raw.cycle?.number ?? null,
    blocks,
    blockedBy,
  }
}

// Add or update a project's entry in the projects.json manifest (keyed by slug), so the switcher can
// discover every project that's been ingested regardless of what data file it was written to.
export function upsertProjectManifest(manifest, entry) {
  const others = manifest.filter((p) => p.slug !== entry.slug)
  return [...others, entry].sort((a, b) => a.name.localeCompare(b.name))
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
