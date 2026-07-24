// The only write surface in tlr: it turns validated ops into Linear issueUpdate mutations. Used by the
// server's edit endpoint when a person confirms a fix on the Review page, never by the CLI (edits go
// through the Linear MCP in Claude Code, so a CLI write path would only duplicate it).
//
// v1 covers the fields an issueUpdate keys by the issue UUID alone: title, description, estimate, and
// priority. Milestone, status, cycle, and assignee moves need a name-to-UUID lookup and are not here
// yet. `fetchImpl` is injectable so the mapping is unit-testable without a network.

import type { Op } from "@/ops.ts"
import type { Issue } from "@/seed.ts"

const LINEAR_API_URL = "https://api.linear.app/graphql"

const UPDATE_MUTATION = `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }
`

export type WritableOp = Extract<Op, { kind: "rename" | "set_description" | "set_estimate" | "set_priority" }>

export type EditResult = { id: string; ok: boolean; error?: string }

type IssueUpdateInput = { title?: string; description?: string; estimate?: number; priority?: number }

const WRITABLE_KINDS = new Set(["rename", "set_description", "set_estimate", "set_priority"])

export function isWritableOp(op: Op): op is WritableOp {
  return WRITABLE_KINDS.has(op.kind)
}

// Fold the ops for one issue into a single issueUpdate input. Later ops win over earlier ones.
function toInput(ops: WritableOp[]): IssueUpdateInput {
  const input: IssueUpdateInput = {}
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
    }
  }
  return input
}

type Fetcher = typeof fetch

async function mutateIssue(
  key: string,
  linearId: string,
  input: IssueUpdateInput,
  fetchImpl: Fetcher,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchImpl(LINEAR_API_URL, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: UPDATE_MUTATION, variables: { id: linearId, input } }),
  })
  if (!res.ok) return { ok: false, error: `Linear → ${res.status} ${res.statusText}` }
  const json = await res.json() as { errors?: { message: string }[]; data?: { issueUpdate?: { success: boolean } } }
  if (json.errors?.length) return { ok: false, error: json.errors.map((e) => e.message).join("; ") }
  if (!json.data?.issueUpdate?.success) return { ok: false, error: "Linear reported the update did not succeed" }
  return { ok: true }
}

/**
 * Apply writable ops to Linear, one issueUpdate per issue. `issues` supplies the identifier→UUID
 * mapping captured at ingest. Ops for an issue with no UUID (e.g. offline seed data) fail with a clear
 * reason rather than silently doing nothing. Returns one result per issue touched.
 */
export async function applyIssueEdits(
  key: string,
  ops: Op[],
  issues: Pick<Issue, "id" | "linearId">[],
  fetchImpl: Fetcher = fetch,
): Promise<EditResult[]> {
  const uuidById = new Map(issues.map((i) => [i.id, i.linearId]))
  const byIssue = new Map<string, WritableOp[]>()
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
    const outcome = await mutateIssue(key, linearId, toInput(issueOps), fetchImpl)
    results.push({ id, ...outcome })
  }
  return results
}
