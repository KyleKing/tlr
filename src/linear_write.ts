// The only write surface in tlr: it turns validated ops into Linear issueUpdate mutations. Used by the
// server's edit endpoint when a person confirms a fix on the Review page, never by the CLI (edits go
// through the Linear MCP in Claude Code, so a CLI write path would only duplicate it).
//
// Two kinds of writable op. "Simple" ops (title, description, estimate, priority) map straight onto the
// issueUpdate input. "Resolved" ops (milestone, status, cycle, assignee) carry a name/key/number that
// must become a Linear UUID first, so those issues fetch their team/project context and resolve against
// it. Status resolves by workflow-state type and picks the first state of that type, which is
// unambiguous on teams with one state per category. `fetchImpl` is injectable so both the mapping and
// the resolution are unit-testable without a network.

import type { Op } from "@/ops.ts"
import type { Issue } from "@/seed.ts"
import { milestoneKey } from "../web/lib/issues.js"

const LINEAR_API_URL = "https://api.linear.app/graphql"

const UPDATE_MUTATION = `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }
`

const CONTEXT_QUERY = `
  query IssueContext($id: String!) {
    issue(id: $id) {
      team {
        states(first: 50) { nodes { id name type } }
        cycles(first: 50) { nodes { id number } }
        members(first: 100) { nodes { id name displayName } }
      }
      project { projectMilestones(first: 50) { nodes { id name } } }
    }
  }
`

const SIMPLE_KINDS = new Set(["rename", "set_description", "set_estimate", "set_priority"])
const RESOLVED_KINDS = new Set(["set_milestone", "set_status", "set_cycle", "set_assignee"])

export type EditResult = { id: string; ok: boolean; error?: string }

export type IssueContext = {
  states: { id: string; name: string; type: string }[]
  cycles: { id: string; number: number }[]
  members: { id: string; name: string; displayName: string }[]
  milestones: { id: string; name: string }[]
}

const EMPTY_CONTEXT: IssueContext = { states: [], cycles: [], members: [], milestones: [] }

type IssueUpdateInput = Record<string, unknown>

export function isWritableOp(op: Op): boolean {
  return SIMPLE_KINDS.has(op.kind) || RESOLVED_KINDS.has(op.kind)
}

function needsContext(ops: Op[]): boolean {
  return ops.some((op) => RESOLVED_KINDS.has(op.kind))
}

// Fold one issue's ops into a single issueUpdate input, resolving name/key/number fields to UUIDs
// against ctx. Unknown targets are collected as errors instead of guessing, so a bad op fails loudly
// rather than writing the wrong id. Pure — ctx is supplied by the caller.
export function buildInput(ops: Op[], ctx: IssueContext): { input: IssueUpdateInput; errors: string[] } {
  const input: IssueUpdateInput = {}
  const errors: string[] = []
  for (const op of ops) {
    switch (op.kind) {
      case "rename":
        input.title = op.title
        break
      case "set_description":
        input.description = op.description
        break
      case "set_estimate":
        input.estimate = op.estimate
        break
      case "set_priority":
        input.priority = op.priority
        break
      case "set_milestone": {
        if (op.milestone === null) {
          input.projectMilestoneId = null
          break
        }
        const pm = ctx.milestones.find((m) => milestoneKey(m.name) === op.milestone)
        if (pm) input.projectMilestoneId = pm.id
        else errors.push(`milestone ${op.milestone} not found in the project`)
        break
      }
      case "set_status": {
        const state = ctx.states.find((s) => s.type === op.status)
        if (state) input.stateId = state.id
        else errors.push(`no workflow state of type ${op.status} on the team`)
        break
      }
      case "set_cycle": {
        if (op.cycle === null) {
          input.cycleId = null
          break
        }
        const cy = ctx.cycles.find((c) => c.number === op.cycle)
        if (cy) input.cycleId = cy.id
        else errors.push(`cycle ${op.cycle} not found on the team`)
        break
      }
      case "set_assignee": {
        if (!op.assignee || op.assignee === "Unassigned") {
          input.assigneeId = null
          break
        }
        const m = ctx.members.find((x) => x.name === op.assignee || x.displayName === op.assignee)
        if (m) input.assigneeId = m.id
        else errors.push(`assignee ${op.assignee} not found in the workspace`)
        break
      }
    }
  }
  return { input, errors }
}

type Fetcher = typeof fetch

async function gql<T>(key: string, query: string, variables: Record<string, unknown>, fetchImpl: Fetcher): Promise<T> {
  const res = await fetchImpl(LINEAR_API_URL, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Linear → ${res.status} ${res.statusText}`)
  const json = await res.json() as { errors?: { message: string }[]; data: T }
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "))
  return json.data
}

async function fetchContext(key: string, linearId: string, fetchImpl: Fetcher): Promise<IssueContext> {
  type Resp = {
    issue: {
      team: {
        states: { nodes: { id: string; name: string; type: string }[] }
        cycles: { nodes: { id: string; number: number }[] }
        members: { nodes: { id: string; name: string; displayName: string }[] }
      }
      project: { projectMilestones: { nodes: { id: string; name: string }[] } } | null
    }
  }
  const data = await gql<Resp>(key, CONTEXT_QUERY, { id: linearId }, fetchImpl)
  return {
    states: data.issue.team.states.nodes,
    cycles: data.issue.team.cycles.nodes,
    members: data.issue.team.members.nodes,
    milestones: data.issue.project?.projectMilestones.nodes ?? [],
  }
}

async function mutateIssue(
  key: string,
  linearId: string,
  input: IssueUpdateInput,
  fetchImpl: Fetcher,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await gql<{ issueUpdate?: { success: boolean } }>(
      key,
      UPDATE_MUTATION,
      { id: linearId, input },
      fetchImpl,
    )
    if (!data.issueUpdate?.success) return { ok: false, error: "Linear reported the update did not succeed" }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Apply writable ops to Linear, one issueUpdate per issue. `issues` supplies the identifier→UUID
 * mapping captured at ingest. An issue with no UUID (e.g. offline seed data) fails with a clear reason
 * rather than silently doing nothing. Issues with milestone/status/cycle/assignee ops fetch their team
 * and project context to resolve those to ids. Returns one result per issue touched.
 */
export async function applyIssueEdits(
  key: string,
  ops: Op[],
  issues: Pick<Issue, "id" | "linearId">[],
  fetchImpl: Fetcher = fetch,
): Promise<EditResult[]> {
  const uuidById = new Map(issues.map((i) => [i.id, i.linearId]))
  const byIssue = new Map<string, Op[]>()
  for (const op of ops) {
    if (!isWritableOp(op)) continue
    const list = byIssue.get(op.id) ?? []
    list.push(op)
    byIssue.set(op.id, list)
  }

  const results: EditResult[] = []
  for (const [id, issueOps] of byIssue) {
    const linearId = uuidById.get(id)
    if (!linearId) {
      results.push({ id, ok: false, error: `no Linear UUID for ${id}; refresh from Linear before editing` })
      continue
    }
    let ctx = EMPTY_CONTEXT
    if (needsContext(issueOps)) {
      try {
        ctx = await fetchContext(key, linearId, fetchImpl)
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
        continue
      }
    }
    const { input, errors } = buildInput(issueOps, ctx)
    if (errors.length) {
      results.push({ id, ok: false, error: errors.join("; ") })
      continue
    }
    const outcome = await mutateIssue(key, linearId, input, fetchImpl)
    results.push({ id, ...outcome })
  }
  return results
}
