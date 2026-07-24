// Review queue over a snapshot diff. Pure. Filters the diff down to what a reviewer cares about since
// the last review (new issues, scope moves, status regressions, re-estimates) and layers in a slop
// scan of any added or edited description. Deterministic and sorted by id.

import type { Issue, Snapshot } from "@/seed.ts"
import { diffSnapshots } from "@/diff.ts"
import { slopScan } from "../web/lib/planning.js"

export type ReviewKind = "added" | "removed" | "moved" | "reestimated" | "status" | "slop"

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

const KIND_ORDER: ReviewKind[] = ["added", "removed", "moved", "reestimated", "status", "slop"]

function isRegression(from: Issue["statusType"], to: Issue["statusType"]): boolean {
  if (to === "canceled") return from !== "canceled"
  return PROGRESS[to] < PROGRESS[from]
}

export function reviewSince(before: Snapshot, after: Snapshot): ReviewQueue {
  const diff = diffSnapshots(before, after)
  const beforeById = new Map(before.issues.map((i) => [i.id, i]))
  const afterById = new Map(after.issues.map((i) => [i.id, i]))
  const items: ReviewItem[] = []

  for (const id of diff.issues.added) {
    const issue = afterById.get(id)!
    items.push({
      id,
      kind: "added",
      summary: `New issue ${id} in ${issue.milestone ?? "no milestone"}`,
      detail: { title: issue.title, milestone: issue.milestone, estimate: issue.estimate },
    })
  }

  for (const id of diff.issues.removed) {
    const issue = beforeById.get(id)!
    items.push({
      id,
      kind: "removed",
      summary: `Issue ${id} removed`,
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

  for (const now of after.issues) {
    const was = beforeById.get(now.id)
    if (!was) continue
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
    const was = beforeById.get(now.id)
    const isAdded = addedSet.has(now.id)
    const isEdited = was !== undefined && was.description !== now.description
    if (!isAdded && !isEdited) continue
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
