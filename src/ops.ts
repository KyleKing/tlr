// The write-layer op model. Ops are a pure, in-memory description of a change to a snapshot. Nothing
// here touches Linear or any network. `validateOp` checks one op against live snapshot state, and
// `applyOps` returns a new snapshot with the valid ops applied and the rest recorded as skipped.

import type { Issue, Snapshot } from "@/seed.ts"
import { teamForIssue } from "../web/lib/issues.js"

export type RelationKind = "blocks" | "blockedBy" | "related"

export type Op =
  // `status` is the workflow-state category and always carries the change; `statusName` names the
  // specific state on the issue's own team, which is the only way to reach one of two states in the
  // same category. A snapshot with no team data, or a name that team does not have, falls back to the
  // category alone.
  | { kind: "set_status"; id: string; status: Issue["statusType"]; statusName?: string }
  | { kind: "set_priority"; id: string; priority: number }
  | { kind: "set_estimate"; id: string; estimate: number }
  | { kind: "set_assignee"; id: string; assignee: string }
  | { kind: "set_milestone"; id: string; milestone: string | null }
  | { kind: "set_cycle"; id: string; cycle: number | null }
  | { kind: "rename"; id: string; title: string }
  | { kind: "set_description"; id: string; description: string }
  | { kind: "add_relation"; id: string; relation: RelationKind; target: string }
  | { kind: "remove_relation"; id: string; relation: RelationKind; target: string }

export type ValidationResult = { ok: true } | { ok: false; reason: string }

export type ApplyResult = {
  after: Snapshot
  applied: Op[]
  skipped: { op: Op; reason: string }[]
}

const STATUS_TYPES: readonly Issue["statusType"][] = [
  "started",
  "unstarted",
  "triage",
  "backlog",
  "completed",
  "canceled",
]

const STATUS_LABELS: Record<Issue["statusType"], string> = {
  backlog: "Backlog",
  unstarted: "Todo",
  triage: "Triage",
  started: "In Progress",
  completed: "Done",
  canceled: "Canceled",
}

const PRIORITY_LABELS: Record<number, string | null> = {
  0: null,
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
}

function findIssue(snapshot: Snapshot, id: string): Issue | undefined {
  return snapshot.issues.find((i) => i.id === id)
}

/**
 * The workflow state on the issue's own team matching `name`, or null when the snapshot carries no
 * team data or the team has no such state. Callers treat null as "resolve by category instead", which
 * is what every snapshot taken before ingest captured team states needs.
 */
export function resolveStateByName(
  snapshot: Snapshot,
  issue: Issue,
  name: string | undefined,
): { id: string; name: string; type: string } | null {
  if (!name) return null
  const team = teamForIssue(snapshot.teams, issue)
  return team?.states.find((s: { name: string }) => s.name === name) ?? null
}

function hasTeamStates(snapshot: Snapshot, issue: Issue): boolean {
  return (teamForIssue(snapshot.teams, issue)?.states.length ?? 0) > 0
}

/** Check an op against live snapshot state. Returns a reason string when the op cannot apply. */
export function validateOp(op: Op, snapshot: Snapshot): ValidationResult {
  const issue = findIssue(snapshot, op.id)
  if (!issue) return { ok: false, reason: `issue ${op.id} not found` }

  switch (op.kind) {
    case "set_status": {
      if (!STATUS_TYPES.includes(op.status)) {
        return { ok: false, reason: `unknown status type ${op.status}` }
      }
      // A named state is only checked against a team whose states were captured. Rejecting a name a
      // pre-team-states snapshot cannot confirm would refuse a status change the type alone handles.
      if (op.statusName && hasTeamStates(snapshot, issue) && !resolveStateByName(snapshot, issue, op.statusName)) {
        return { ok: false, reason: `no workflow state named ${op.statusName} on ${issue.id}'s team` }
      }
      return { ok: true }
    }
    case "set_priority": {
      if (!Number.isInteger(op.priority) || op.priority < 0 || op.priority > 4) {
        return { ok: false, reason: `priority ${op.priority} out of range 0-4` }
      }
      return { ok: true }
    }
    case "set_estimate": {
      if (!Number.isFinite(op.estimate) || op.estimate < 0) {
        return { ok: false, reason: `estimate ${op.estimate} must be a non-negative number` }
      }
      return { ok: true }
    }
    case "set_assignee": {
      return { ok: true }
    }
    case "set_milestone": {
      if (op.milestone === null) return { ok: true }
      const found = snapshot.milestones.some((m) => m.key === op.milestone)
      if (!found) return { ok: false, reason: `milestone ${op.milestone} not found` }
      return { ok: true }
    }
    case "set_cycle": {
      if (op.cycle === null) return { ok: true }
      const found = snapshot.cycles.some((c) => c.n === op.cycle)
      if (!found) return { ok: false, reason: `cycle ${op.cycle} not found` }
      return { ok: true }
    }
    case "rename": {
      if (op.title.trim().length === 0) return { ok: false, reason: "title cannot be empty" }
      return { ok: true }
    }
    case "set_description": {
      return { ok: true }
    }
    case "add_relation":
    case "remove_relation": {
      if (op.target === op.id) return { ok: false, reason: "relation cannot point at itself" }
      if (!findIssue(snapshot, op.target)) return { ok: false, reason: `relation target ${op.target} not found` }
      return { ok: true }
    }
  }
}

function addEdge(list: string[], value: string) {
  if (!list.includes(value)) list.push(value)
}

function removeEdge(list: string[], value: string) {
  const idx = list.indexOf(value)
  if (idx >= 0) list.splice(idx, 1)
}

// blocks and blockedBy are mirror edges. Whichever side an op names, update both issues so the graph
// stays symmetric. related is its own mirror.
function applyRelation(a: Issue, b: Issue, relation: RelationKind, add: boolean) {
  const edit = add ? addEdge : removeEdge
  switch (relation) {
    case "blocks":
      edit(a.blocks, b.id)
      edit(b.blockedBy, a.id)
      return
    case "blockedBy":
      edit(a.blockedBy, b.id)
      edit(b.blocks, a.id)
      return
    case "related":
      edit(a.related, b.id)
      edit(b.related, a.id)
      return
  }
}

function mutate(op: Op, snapshot: Snapshot) {
  const issue = findIssue(snapshot, op.id)!
  switch (op.kind) {
    case "set_status": {
      const state = resolveStateByName(snapshot, issue, op.statusName)
      issue.statusType = op.status
      issue.status = state?.name ?? op.statusName ?? STATUS_LABELS[op.status]
      return
    }
    case "set_priority":
      issue.priorityValue = op.priority
      issue.priority = PRIORITY_LABELS[op.priority]
      return
    case "set_estimate":
      issue.estimate = op.estimate
      return
    case "set_assignee":
      issue.assignee = op.assignee
      return
    case "set_milestone":
      issue.milestone = op.milestone
      return
    case "set_cycle":
      issue.cycle = op.cycle
      return
    case "rename":
      issue.title = op.title
      return
    case "set_description":
      issue.description = op.description
      return
    case "add_relation":
      applyRelation(issue, findIssue(snapshot, op.target)!, op.relation, true)
      return
    case "remove_relation":
      applyRelation(issue, findIssue(snapshot, op.target)!, op.relation, false)
      return
  }
}

/**
 * Apply ops to a deep clone of the snapshot. Each op is validated against the working state as it is
 * applied, so a later op sees earlier ones. Invalid ops are skipped with a reason. Pure, no I/O.
 */
export function applyOps(snapshot: Snapshot, ops: Op[]): ApplyResult {
  const after = structuredClone(snapshot)
  const applied: Op[] = []
  const skipped: { op: Op; reason: string }[] = []

  for (const op of ops) {
    const result = validateOp(op, after)
    if (!result.ok) {
      skipped.push({ op, reason: result.reason })
      continue
    }
    mutate(op, after)
    applied.push(op)
  }

  return { after, applied, skipped }
}
