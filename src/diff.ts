// Plan-level diff between two snapshots. Pure, no I/O. Issues are matched by id, rolled up to the
// milestone level, with a flat list of field-level changes for the issues that survive both captures.

import type { Issue, Snapshot } from "@/seed.ts"

export type FieldChange = {
  id: string
  field: "status" | "estimate" | "milestone" | "cycle" | "priority" | "assignee" | "title"
  from: string | number | null
  to: string | number | null
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
    removed: string[]
    changes: FieldChange[]
  }
}

const DAY_MS = 24 * 3600 * 1000

const FIELDS: FieldChange["field"][] = [
  "status",
  "estimate",
  "milestone",
  "cycle",
  "priority",
  "assignee",
  "title",
]

function byId(issues: Issue[]): Map<string, Issue> {
  return new Map(issues.map((i) => [i.id, i]))
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

function fieldValue(issue: Issue, field: FieldChange["field"]): string | number | null {
  return issue[field] as string | number | null
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const beforeById = byId(before.issues)
  const afterById = byId(after.issues)

  const added = after.issues.filter((i) => !beforeById.has(i.id)).map((i) => i.id).sort()
  const removed = before.issues.filter((i) => !afterById.has(i.id)).map((i) => i.id).sort()
  const survivors = after.issues.filter((i) => beforeById.has(i.id))

  const changes: FieldChange[] = []
  for (const now of survivors) {
    const was = beforeById.get(now.id)!
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

  const addedSet = new Set(added)
  const removedSet = new Set(removed)

  const milestones: MilestoneDiff[] = keys.map((key) => {
    const tb = targetBefore.get(key) ?? null
    const ta = targetAfter.get(key) ?? null
    const issuesIn = survivors
      .filter((i) => i.milestone === key && beforeById.get(i.id)!.milestone !== key)
      .map((i) => i.id)
      .sort()
    const issuesOut = survivors
      .filter((i) => i.milestone !== key && beforeById.get(i.id)!.milestone === key)
      .map((i) => i.id)
      .sort()
    const addedHere = after.issues
      .filter((i) => addedSet.has(i.id) && i.milestone === key)
      .map((i) => i.id)
      .sort()
    const removedHere = before.issues
      .filter((i) => removedSet.has(i.id) && i.milestone === key)
      .map((i) => i.id)
      .sort()
    const completed = survivors
      .filter((i) =>
        i.milestone === key && i.statusType === "completed" &&
        beforeById.get(i.id)!.statusType !== "completed"
      )
      .map((i) => i.id)
      .sort()
    const pointsBefore = pointsInMilestone(before.issues, key)
    const pointsAfter = pointsInMilestone(after.issues, key)
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
      removed: removedHere,
      completed,
    }
  })

  const pointsBefore = totalPoints(before.issues)
  const pointsAfter = totalPoints(after.issues)

  return {
    project: {
      asOfBefore: before.asOf,
      asOfAfter: after.asOf,
      pointsBefore,
      pointsAfter,
      pointsDelta: pointsAfter - pointsBefore,
      issuesBefore: before.issues.length,
      issuesAfter: after.issues.length,
      issueCountDelta: after.issues.length - before.issues.length,
    },
    milestones,
    issues: { added, removed, changes },
  }
}
