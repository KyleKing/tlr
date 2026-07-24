// Turn short natural-language guidance into structured ops, one instruction per line, with no LLM
// call. Parsing is deterministic and case-insensitive. Ids, milestones, and people are resolved
// against the snapshot, so a line that names something the snapshot does not know goes to `unparsed`
// alongside anything the grammar cannot match.
//
// Grammar (one per line, case-insensitive):
//   move <id> to <milestone>            -> set_milestone   (milestone by key or name)
//   set <id> estimate to <number>       -> set_estimate
//   set <id> priority to <word>         -> set_priority    (urgent|high|medium|low|none -> 1|2|3|4|0)
//   set <id> status to <words>          -> set_status      (in progress|todo|backlog|done|canceled...)
//   assign <id> to <name>               -> set_assignee    (person by roster/display name)
//   rename <id> to <new title>          -> rename
//   <id> blocks <id>                    -> add_relation blocks
//   <id> blocked by <id>                -> add_relation blockedBy

import type { Issue, Snapshot } from "@/seed.ts"
import type { Op } from "@/ops.ts"

export type PlanResult = { ops: Op[]; unparsed: string[] }

const PRIORITY_WORDS: Record<string, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
  none: 0,
}

const STATUS_WORDS: Record<string, Issue["statusType"]> = {
  "in progress": "started",
  "in-progress": "started",
  started: "started",
  todo: "unstarted",
  "to do": "unstarted",
  unstarted: "unstarted",
  backlog: "backlog",
  done: "completed",
  complete: "completed",
  completed: "completed",
  canceled: "canceled",
  cancelled: "canceled",
  triage: "triage",
}

function resolveIssueId(raw: string, snapshot: Snapshot): string | null {
  const id = raw.toUpperCase()
  return snapshot.issues.some((i) => i.id === id) ? id : null
}

function resolveMilestone(raw: string, snapshot: Snapshot): string | null {
  const needle = raw.trim().toLowerCase()
  const byKey = snapshot.milestones.find((m) => m.key.toLowerCase() === needle)
  if (byKey) return byKey.key
  const byName = snapshot.milestones.find((m) => m.name.toLowerCase().includes(needle))
  return byName ? byName.key : null
}

function resolveAssignee(raw: string, snapshot: Snapshot): string | null {
  const needle = raw.trim().toLowerCase()
  if (needle === "unassigned") return "Unassigned"
  const names = new Set<string>()
  for (const name of Object.keys(snapshot.capacity.roster)) names.add(name)
  for (const name of Object.keys(snapshot.capacity.people)) names.add(name)
  for (const i of snapshot.issues) names.add(i.assignee)
  const match = [...names].find((n) => n.toLowerCase() === needle)
  return match ?? null
}

function parseLine(line: string, snapshot: Snapshot): Op | null {
  let m: RegExpExecArray | null

  if ((m = /^move\s+(\S+)\s+to\s+(.+)$/i.exec(line))) {
    const id = resolveIssueId(m[1], snapshot)
    const milestone = resolveMilestone(m[2], snapshot)
    if (id && milestone) return { kind: "set_milestone", id, milestone }
    return null
  }

  if ((m = /^set\s+(\S+)\s+estimate\s+to\s+(.+)$/i.exec(line))) {
    const id = resolveIssueId(m[1], snapshot)
    const estimate = Number(m[2].trim())
    if (id && Number.isFinite(estimate)) return { kind: "set_estimate", id, estimate }
    return null
  }

  if ((m = /^set\s+(\S+)\s+priority\s+to\s+(.+)$/i.exec(line))) {
    const id = resolveIssueId(m[1], snapshot)
    const priority = PRIORITY_WORDS[m[2].trim().toLowerCase()]
    if (id && priority !== undefined) return { kind: "set_priority", id, priority }
    return null
  }

  if ((m = /^set\s+(\S+)\s+status\s+to\s+(.+)$/i.exec(line))) {
    const id = resolveIssueId(m[1], snapshot)
    const status = STATUS_WORDS[m[2].trim().toLowerCase()]
    if (id && status) return { kind: "set_status", id, status }
    return null
  }

  if ((m = /^assign\s+(\S+)\s+to\s+(.+)$/i.exec(line))) {
    const id = resolveIssueId(m[1], snapshot)
    const assignee = resolveAssignee(m[2], snapshot)
    if (id && assignee) return { kind: "set_assignee", id, assignee }
    return null
  }

  if ((m = /^rename\s+(\S+)\s+to\s+(.+)$/i.exec(line))) {
    const id = resolveIssueId(m[1], snapshot)
    const title = m[2].trim()
    if (id && title) return { kind: "rename", id, title }
    return null
  }

  if ((m = /^(\S+)\s+blocked\s+by\s+(\S+)$/i.exec(line))) {
    const id = resolveIssueId(m[1], snapshot)
    const target = resolveIssueId(m[2], snapshot)
    if (id && target) return { kind: "add_relation", id, relation: "blockedBy", target }
    return null
  }

  if ((m = /^(\S+)\s+blocks\s+(\S+)$/i.exec(line))) {
    const id = resolveIssueId(m[1], snapshot)
    const target = resolveIssueId(m[2], snapshot)
    if (id && target) return { kind: "add_relation", id, relation: "blocks", target }
    return null
  }

  return null
}

export function planFromText(text: string, snapshot: Snapshot): PlanResult {
  const ops: Op[] = []
  const unparsed: string[] = []

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const op = parseLine(line, snapshot)
    if (op) ops.push(op)
    else unparsed.push(line)
  }

  return { ops, unparsed }
}
