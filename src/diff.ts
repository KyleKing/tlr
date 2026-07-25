// Plan-level diff between two snapshots. Pure, no I/O. Issues are matched by Linear's stable UUID
// (`linearId`) so a ticket that moves to another team reads as a rename rather than a delete plus an
// add, rolled up to the milestone level, with a flat list of field-level changes for the issues that
// survive both captures.

import type { Issue, Snapshot } from "@/seed.ts"

export type FieldChange = {
  id: string
  field: "status" | "estimate" | "milestone" | "cycle" | "priority" | "assignee" | "title" | "identifier"
  from: string | number | null
  to: string | number | null
}

// An issue absent from `before` that a bounded window of earlier snapshots has seen. `estimate` and
// `milestone` are what it carried when it was last present, so a reader sees what it used to be.
export type ReturningIssue = {
  id: string
  lastSeenAsOf: string
  estimate: number | null
  milestone: string | null
  descriptionUnchanged: boolean
}

export type MilestoneDiff = {
  key: string
  name: string
  targetBefore: string | null
  targetAfter: string | null
  targetSlipDays: number | null
  pointsBefore: number
  pointsAfter: number
  pointsDelta: number
  issuesIn: string[]
  issuesOut: string[]
  added: string[]
  archived: string[]
  removed: string[]
  completed: string[]
}

export type SnapshotDiff = {
  project: {
    asOfBefore: string
    asOfAfter: string
    pointsBefore: number
    pointsAfter: number
    pointsDelta: number
    issuesBefore: number
    issuesAfter: number
    issueCountDelta: number
  }
  milestones: MilestoneDiff[]
  issues: {
    added: string[]
    archived: string[]
    removed: string[]
    returning: ReturningIssue[]
    changes: FieldChange[]
  }
}

const DAY_MS = 24 * 3600 * 1000

// How far back a return is recognised. Both bounds apply, whichever bites first: at eight captures a
// day the count keeps the scan cheap, and the day window keeps a ticket that vanished a quarter ago
// from resurfacing as "returning" when it is really new work under an old identifier.
export const RETURN_LOOKBACK_SNAPSHOTS = 24
export const RETURN_LOOKBACK_DAYS = 45

type ComparedField = Exclude<FieldChange["field"], "identifier">

const FIELDS: ComparedField[] = [
  "status",
  "estimate",
  "milestone",
  "cycle",
  "priority",
  "assignee",
  "title",
]

// Set at the ingest boundary. Snapshots captured before the field existed have no `archived` key at
// all, and a missing flag means the issue is live.
type IngestedIssue = Issue & { archived?: boolean }

export function isArchived(issue: Issue): boolean {
  return (issue as IngestedIssue).archived === true
}

function isLive(issue: Issue): boolean {
  return !isArchived(issue)
}

export type IssuePair = { was: Issue; now: Issue }

export type IssueMatch = { pairs: IssuePair[]; addedOnly: Issue[]; removedOnly: Issue[] }

function sameTicket(was: Issue, now: Issue): boolean {
  if (was.linearId && now.linearId) return was.linearId === now.linearId
  return true
}

// Match on `linearId`, falling back to the human identifier for snapshots captured before ingest
// recorded the UUID. The fallback never pairs two issues whose UUIDs are both known and disagree,
// so a recycled identifier stays an add plus a remove.
export function matchIssues(before: Issue[], after: Issue[]): IssueMatch {
  const byLinearId = new Map<string, Issue>()
  const byIdentifier = new Map<string, Issue>()
  for (const issue of before) {
    if (issue.linearId) byLinearId.set(issue.linearId, issue)
    byIdentifier.set(issue.id, issue)
  }

  const taken = new Set<Issue>()
  const pairs: IssuePair[] = []
  const addedOnly: Issue[] = []
  for (const now of after) {
    const byUuid = now.linearId ? byLinearId.get(now.linearId) : undefined
    const fallback = byIdentifier.get(now.id)
    const was = byUuid ?? (fallback && sameTicket(fallback, now) ? fallback : undefined)
    if (!was || taken.has(was)) {
      addedOnly.push(now)
      continue
    }
    taken.add(was)
    pairs.push({ was, now })
  }

  return { pairs, addedOnly, removedOnly: before.filter((issue) => !taken.has(issue)) }
}

function totalPoints(issues: Issue[]): number {
  return issues.reduce((sum, i) => sum + (i.estimate || 0), 0)
}

function pointsInMilestone(issues: Issue[], key: string): number {
  return issues.filter((i) => i.milestone === key).reduce((sum, i) => sum + (i.estimate || 0), 0)
}

function slipDays(before: string | null, after: string | null): number | null {
  if (!before || !after) return null
  return Math.round((new Date(after).getTime() - new Date(before).getTime()) / DAY_MS)
}

function fieldValue(issue: Issue, field: ComparedField): string | number | null {
  return issue[field] as string | number | null
}

function lookbackCutoff(asOf: string): string {
  return new Date(new Date(asOf).getTime() - RETURN_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10)
}

function boundedHistory(history: Snapshot[], asOf: string): Snapshot[] {
  const cutoff = lookbackCutoff(asOf)
  return history
    .filter((s) => s.asOf < asOf && s.asOf >= cutoff)
    .sort((a, b) => b.asOf.localeCompare(a.asOf))
    .slice(0, RETURN_LOOKBACK_SNAPSHOTS)
}

function findCounterpart(issues: Issue[], issue: Issue): Issue | undefined {
  const byUuid = issue.linearId ? issues.find((i) => i.linearId === issue.linearId) : undefined
  if (byUuid) return byUuid
  const fallback = issues.find((i) => i.id === issue.id)
  return fallback && sameTicket(fallback, issue) ? fallback : undefined
}

function priorSighting(history: Snapshot[], issue: Issue): ReturningIssue | null {
  for (const snapshot of history) {
    const was = findCounterpart(snapshot.issues.filter(isLive), issue)
    if (!was) continue
    return {
      id: issue.id,
      lastSeenAsOf: snapshot.asOf,
      estimate: was.estimate ?? null,
      milestone: was.milestone,
      descriptionUnchanged: was.description === issue.description,
    }
  }
  return null
}

// `history` holds earlier captures of the same project, oldest or newest first; only the bounded
// window nearest `before` is read, and only to recognise an added issue as a return.
export function diffSnapshots(before: Snapshot, after: Snapshot, history: Snapshot[] = []): SnapshotDiff {
  const beforeLive = before.issues.filter(isLive)
  const afterLive = after.issues.filter(isLive)
  const { pairs, addedOnly, removedOnly } = matchIssues(before.issues, after.issues)

  const survivors: IssuePair[] = []
  const archivedIssues: Issue[] = []
  const restored: Issue[] = []
  for (const pair of pairs) {
    if (isArchived(pair.now)) {
      if (isLive(pair.was)) archivedIssues.push(pair.now)
      continue
    }
    if (isArchived(pair.was)) restored.push(pair.now)
    else survivors.push(pair)
  }

  const addedIssues = [...addedOnly.filter(isLive), ...restored]
  const added = addedIssues.map((i) => i.id).sort()
  const archived = archivedIssues.map((i) => i.id).sort()
  const removed = removedOnly.filter(isLive).map((i) => i.id).sort()

  const window = boundedHistory(history, before.asOf)
  const returning: ReturningIssue[] = []
  for (const issue of addedIssues) {
    const sighting = priorSighting(window, issue)
    if (sighting) returning.push(sighting)
  }
  returning.sort((a, b) => a.id.localeCompare(b.id))

  const changes: FieldChange[] = []
  for (const { was, now } of survivors) {
    if (was.id !== now.id) changes.push({ id: now.id, field: "identifier", from: was.id, to: now.id })
    for (const field of FIELDS) {
      const from = fieldValue(was, field)
      const to = fieldValue(now, field)
      if (from !== to) changes.push({ id: now.id, field, from, to })
    }
  }
  changes.sort((a, b) => a.id.localeCompare(b.id) || a.field.localeCompare(b.field))

  const targetBefore = new Map(before.milestones.map((m) => [m.key, m.target]))
  const targetAfter = new Map(after.milestones.map((m) => [m.key, m.target]))
  const names = new Map<string, string>()
  for (const m of before.milestones) names.set(m.key, m.name)
  for (const m of after.milestones) names.set(m.key, m.name)

  const keys: string[] = []
  for (const m of after.milestones) keys.push(m.key)
  for (const m of before.milestones) if (!keys.includes(m.key)) keys.push(m.key)

  const milestones: MilestoneDiff[] = keys.map((key) => {
    const tb = targetBefore.get(key) ?? null
    const ta = targetAfter.get(key) ?? null
    const issuesIn = survivors
      .filter(({ was, now }) => now.milestone === key && was.milestone !== key)
      .map(({ now }) => now.id)
      .sort()
    const issuesOut = survivors
      .filter(({ was, now }) => now.milestone !== key && was.milestone === key)
      .map(({ now }) => now.id)
      .sort()
    const addedHere = addedIssues.filter((i) => i.milestone === key).map((i) => i.id).sort()
    const archivedHere = archivedIssues.filter((i) => i.milestone === key).map((i) => i.id).sort()
    const removedHere = removedOnly
      .filter((i) => isLive(i) && i.milestone === key)
      .map((i) => i.id)
      .sort()
    const completed = survivors
      .filter(({ was, now }) =>
        now.milestone === key && now.statusType === "completed" && was.statusType !== "completed"
      )
      .map(({ now }) => now.id)
      .sort()
    const pointsBefore = pointsInMilestone(beforeLive, key)
    const pointsAfter = pointsInMilestone(afterLive, key)
    return {
      key,
      name: names.get(key) ?? key,
      targetBefore: tb,
      targetAfter: ta,
      targetSlipDays: slipDays(tb, ta),
      pointsBefore,
      pointsAfter,
      pointsDelta: pointsAfter - pointsBefore,
      issuesIn,
      issuesOut,
      added: addedHere,
      archived: archivedHere,
      removed: removedHere,
      completed,
    }
  })

  const pointsBefore = totalPoints(beforeLive)
  const pointsAfter = totalPoints(afterLive)

  return {
    project: {
      asOfBefore: before.asOf,
      asOfAfter: after.asOf,
      pointsBefore,
      pointsAfter,
      pointsDelta: pointsAfter - pointsBefore,
      issuesBefore: beforeLive.length,
      issuesAfter: afterLive.length,
      issueCountDelta: afterLive.length - beforeLive.length,
    },
    milestones,
    issues: { added, archived, removed, returning, changes },
  }
}
