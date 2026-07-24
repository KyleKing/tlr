import { assert, assertEquals } from "@std/assert"
import { applyIssueEdits, buildInput, type IssueContext, isWritableOp } from "@/linear_write.ts"
import type { Op } from "@/ops.ts"

const ISSUES = [
  { id: "ENG-1", linearId: "uuid-1" },
  { id: "ENG-2", linearId: "uuid-2" },
  { id: "ENG-3", linearId: undefined },
]

const CTX: IssueContext = {
  states: [{ id: "st-todo", name: "Todo", type: "unstarted" }, { id: "st-prog", name: "In Progress", type: "started" }],
  cycles: [{ id: "cy-48", number: 48 }],
  members: [{ id: "u-ada", name: "Ada Lovelace", displayName: "ada" }],
  milestones: [{ id: "pm-1", name: "M1: Foundations" }, { id: "pm-2", name: "M2: Beta" }],
}

type Call = { query: string; variables: Record<string, unknown> }

// A fetch stub that records calls, returns context for the context query, and success for the mutation.
function stubFetch(
  calls: Call[],
  mutationResult: unknown = { data: { issueUpdate: { success: true } } },
): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push({ query: body.query, variables: body.variables })
    const isContext = body.query.includes("IssueContext")
    const payload = isContext
      ? {
        data: {
          issue: {
            team: {
              states: { nodes: CTX.states },
              cycles: { nodes: CTX.cycles },
              members: { nodes: CTX.members },
            },
            project: { projectMilestones: { nodes: CTX.milestones } },
          },
        },
      }
      : mutationResult
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
  }) as typeof fetch
}

Deno.test("isWritableOp allows all writable fields and rejects relations", () => {
  for (
    const op of [
      { kind: "rename", id: "E-1", title: "x" },
      { kind: "set_description", id: "E-1", description: "x" },
      { kind: "set_estimate", id: "E-1", estimate: 3 },
      { kind: "set_priority", id: "E-1", priority: 2 },
      { kind: "set_milestone", id: "E-1", milestone: "M2" },
      { kind: "set_status", id: "E-1", status: "started" },
      { kind: "set_cycle", id: "E-1", cycle: 48 },
      { kind: "set_assignee", id: "E-1", assignee: "Ada Lovelace" },
    ] as Op[]
  ) assert(isWritableOp(op))
  assert(!isWritableOp({ kind: "add_relation", id: "E-1", relation: "blocks", target: "E-2" }))
})

Deno.test("buildInput resolves milestone, status, cycle, and assignee to ids", () => {
  const ops: Op[] = [
    { kind: "set_milestone", id: "E-1", milestone: "M2" },
    { kind: "set_status", id: "E-1", status: "started" },
    { kind: "set_cycle", id: "E-1", cycle: 48 },
    { kind: "set_assignee", id: "E-1", assignee: "Ada Lovelace" },
  ]
  const { input, errors } = buildInput(ops, CTX)
  assertEquals(errors, [])
  assertEquals(input, { projectMilestoneId: "pm-2", stateId: "st-prog", cycleId: "cy-48", assigneeId: "u-ada" })
})

Deno.test("buildInput clears milestone/cycle on null and assignee on Unassigned", () => {
  const ops: Op[] = [
    { kind: "set_milestone", id: "E-1", milestone: null },
    { kind: "set_cycle", id: "E-1", cycle: null },
    { kind: "set_assignee", id: "E-1", assignee: "Unassigned" },
  ]
  const { input } = buildInput(ops, CTX)
  assertEquals(input, { projectMilestoneId: null, cycleId: null, assigneeId: null })
})

Deno.test("buildInput reports an unknown milestone or assignee instead of guessing", () => {
  const { errors } = buildInput(
    [{ kind: "set_milestone", id: "E-1", milestone: "M9" }, { kind: "set_assignee", id: "E-1", assignee: "Nobody" }],
    CTX,
  )
  assertEquals(errors.length, 2)
})

Deno.test("applyIssueEdits folds simple ops into one issueUpdate, no context fetch", async () => {
  const calls: Call[] = []
  const ops: Op[] = [
    { kind: "rename", id: "ENG-1", title: "Clearer title" },
    { kind: "set_description", id: "ENG-1", description: "Rewritten." },
    { kind: "set_estimate", id: "ENG-2", estimate: 5 },
  ]
  const results = await applyIssueEdits("key", ops, ISSUES, stubFetch(calls))

  assert(!calls.some((c) => c.query.includes("IssueContext")))
  assertEquals(calls.filter((c) => c.query.includes("UpdateIssue")).length, 2)
  assertEquals(results.every((r) => r.ok), true)
})

Deno.test("applyIssueEdits fetches context and resolves a milestone move", async () => {
  const calls: Call[] = []
  const results = await applyIssueEdits(
    "key",
    [{ kind: "set_milestone", id: "ENG-1", milestone: "M2" }],
    ISSUES,
    stubFetch(calls),
  )
  assert(calls.some((c) => c.query.includes("IssueContext")))
  const mutation = calls.find((c) => c.query.includes("UpdateIssue"))
  assert(mutation)
  assertEquals((mutation.variables.input as Record<string, unknown>).projectMilestoneId, "pm-2")
  assertEquals(results[0].ok, true)
})

Deno.test("applyIssueEdits fails an unresolved milestone without mutating", async () => {
  const calls: Call[] = []
  const results = await applyIssueEdits(
    "key",
    [{ kind: "set_milestone", id: "ENG-1", milestone: "M9" }],
    ISSUES,
    stubFetch(calls),
  )
  assert(!calls.some((c) => c.query.includes("UpdateIssue")))
  assertEquals(results[0].ok, false)
  assert(results[0].error?.includes("M9"))
})

Deno.test("applyIssueEdits fails an edit with no captured UUID rather than calling Linear", async () => {
  const calls: Call[] = []
  const results = await applyIssueEdits("key", [{ kind: "rename", id: "ENG-3", title: "x" }], ISSUES, stubFetch(calls))
  assertEquals(calls.length, 0)
  assertEquals(results[0].ok, false)
  assert(results[0].error?.includes("refresh from Linear"))
})

Deno.test("applyIssueEdits surfaces a GraphQL error as a failed result", async () => {
  const calls: Call[] = []
  const results = await applyIssueEdits(
    "key",
    [{ kind: "rename", id: "ENG-1", title: "x" }],
    ISSUES,
    stubFetch(calls, { errors: [{ message: "denied" }] }),
  )
  assertEquals(results[0].ok, false)
  assertEquals(results[0].error, "denied")
})
