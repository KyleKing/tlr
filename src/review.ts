// Review queue over a snapshot diff. Pure. Filters the diff down to what a reviewer cares about since
// the last review (new issues, returns, archives, removals, scope moves, status regressions,
// re-estimates) and layers in a slop scan of any added or edited description. A description byte-
// identical to one already reviewed is never re-scanned. Deterministic and sorted by id.

import type { Issue, Snapshot } from "@/seed.ts"
import { diffSnapshots, isArchived, matchIssues } from "@/diff.ts"
import { slopScan } from "../web/lib/planning.js"

export type ReviewKind =
  | "added"
  | "archived"
  | "removed"
  | "returning"
  | "moved"
  | "reestimated"
  | "status"
  | "slop"

export type ReviewItem = {
  id: string
  kind: ReviewKind
  summary: string
  detail: Record<string, unknown>
}

export type ReviewQueue = {
  window: { from: string; to: string }
  items: ReviewItem[]
}

const SLOP_THRESHOLD = 2

// Higher means closer to done. Canceled sits below everything, so any move to it reads as a regression.
const PROGRESS: Record<Issue["statusType"], number> = {
  canceled: -1,
  backlog: 0,
  triage: 1,
  unstarted: 1,
  started: 2,
  completed: 3,
}

const KIND_ORDER: ReviewKind[] = [
  "added",
  "returning",
  "removed",
  "archived",
  "moved",
  "reestimated",
  "status",
  "slop",
]

function isRegression(from: Issue["statusType"], to: Issue["statusType"]): boolean {
  if (to === "canceled") return from !== "canceled"
  return PROGRESS[to] < PROGRESS[from]
}

// `history` holds earlier captures of the same project, passed through to the diff so a ticket that
// left and came back reads as a return carrying its old estimate and milestone.
export function reviewSince(before: Snapshot, after: Snapshot, history: Snapshot[] = []): ReviewQueue {
  const diff = diffSnapshots(before, after, history)
  const beforeById = new Map(before.issues.map((i) => [i.id, i]))
  const afterById = new Map(after.issues.map((i) => [i.id, i]))
  const returningById = new Map(diff.issues.returning.map((r) => [r.id, r]))
  const items: ReviewItem[] = []

  for (const id of diff.issues.added) {
    const issue = afterById.get(id)!
    const back = returningById.get(id)
    if (back) {
      items.push({
        id,
        kind: "returning",
        summary: `${id} is back in the project, last seen ${back.lastSeenAsOf}`,
        detail: {
          title: issue.title,
          milestone: issue.milestone,
          estimate: issue.estimate,
          lastSeenAsOf: back.lastSeenAsOf,
          priorEstimate: back.estimate,
          priorMilestone: back.milestone,
        },
      })
      continue
    }
    items.push({
      id,
      kind: "added",
      summary: `New issue ${id} in ${issue.milestone ?? "no milestone"}`,
      detail: { title: issue.title, milestone: issue.milestone, estimate: issue.estimate },
    })
  }

  for (const id of diff.issues.archived) {
    const issue = afterById.get(id) ?? beforeById.get(id)!
    items.push({
      id,
      kind: "archived",
      summary: `Issue ${id} archived`,
      detail: { title: issue.title, milestone: issue.milestone, estimate: issue.estimate },
    })
  }

  for (const id of diff.issues.removed) {
    const issue = beforeById.get(id)!
    items.push({
      id,
      kind: "removed",
      summary: `Issue ${id} removed from the project`,
      detail: { title: issue.title, milestone: issue.milestone },
    })
  }

  for (const change of diff.issues.changes) {
    if (change.field === "milestone") {
      items.push({
        id: change.id,
        kind: "moved",
        summary: `${change.id} moved from ${change.from ?? "no milestone"} to ${change.to ?? "no milestone"}`,
        detail: { from: change.from, to: change.to },
      })
    } else if (change.field === "estimate") {
      items.push({
        id: change.id,
        kind: "reestimated",
        summary: `${change.id} re-estimated from ${change.from} to ${change.to}`,
        detail: { from: change.from, to: change.to },
      })
    }
  }

  const { pairs } = matchIssues(before.issues, after.issues)
  const survivors = pairs.filter(({ was, now }) => !isArchived(was) && !isArchived(now))
  const priorByCurrentId = new Map(survivors.map(({ was, now }) => [now.id, was]))

  for (const { was, now } of survivors) {
    if (isRegression(was.statusType, now.statusType)) {
      items.push({
        id: now.id,
        kind: "status",
        summary: `${now.id} status regressed from ${was.status} to ${now.status}`,
        detail: { from: was.status, to: now.status },
      })
    }
  }

  const addedSet = new Set(diff.issues.added)
  for (const now of after.issues) {
    if (isArchived(now)) continue
    const was = priorByCurrentId.get(now.id)
    const isAdded = addedSet.has(now.id)
    const isEdited = was !== undefined && was.description !== now.description
    if (!isAdded && !isEdited) continue
    if (returningById.get(now.id)?.descriptionUnchanged) continue
    const scan = slopScan(now.description)
    if (scan.score >= SLOP_THRESHOLD) {
      items.push({
        id: now.id,
        kind: "slop",
        summary: `${now.id} description scores as slop`,
        detail: { score: scan.score, flags: scan.flags },
      })
    }
  }

  items.sort((a, b) => a.id.localeCompare(b.id) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))

  return { window: { from: before.asOf, to: after.asOf }, items }
}
