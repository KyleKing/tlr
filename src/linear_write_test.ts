import { assert, assertEquals } from "@std/assert"
import { applyIssueEdits, isWritableOp } from "@/linear_write.ts"
import type { Op } from "@/ops.ts"

const ISSUES = [
  { id: "ENG-1", linearId: "uuid-1" },
  { id: "ENG-2", linearId: "uuid-2" },
  { id: "ENG-3", linearId: undefined },
]

type Call = { id: string; input: Record<string, unknown> }

// A fetch stub that records the mutation variables and always reports success.
function recordingFetch(calls: Call[]): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push({ id: body.variables.id, input: body.variables.input })
    return Promise.resolve(
      new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 }),
    )
  }) as typeof fetch
}

Deno.test("isWritableOp allows the v1 fields and rejects the rest", () => {
  assert(isWritableOp({ kind: "rename", id: "ENG-1", title: "x" }))
  assert(isWritableOp({ kind: "set_description", id: "ENG-1", description: "x" }))
  assert(isWritableOp({ kind: "set_estimate", id: "ENG-1", estimate: 3 }))
  assert(isWritableOp({ kind: "set_priority", id: "ENG-1", priority: 2 }))
  assert(!isWritableOp({ kind: "set_milestone", id: "ENG-1", milestone: "M2" }))
  assert(!isWritableOp({ kind: "set_status", id: "ENG-1", status: "started" }))
})

Deno.test("applyIssueEdits folds an issue's ops into one issueUpdate by UUID", async () => {
  const calls: Call[] = []
  const ops: Op[] = [
    { kind: "rename", id: "ENG-1", title: "Clearer title" },
    { kind: "set_description", id: "ENG-1", description: "Rewritten." },
    { kind: "set_estimate", id: "ENG-2", estimate: 5 },
  ]
  const results = await applyIssueEdits("key", ops, ISSUES, recordingFetch(calls))

  assertEquals(calls.length, 2)
  assertEquals(calls.find((c) => c.id === "uuid-1")?.input, { title: "Clearer title", description: "Rewritten." })
  assertEquals(calls.find((c) => c.id === "uuid-2")?.input, { estimate: 5 })
  assertEquals(results.every((r) => r.ok), true)
})

Deno.test("applyIssueEdits skips non-writable ops without calling Linear", async () => {
  const calls: Call[] = []
  const ops: Op[] = [{ kind: "set_milestone", id: "ENG-1", milestone: "M2" }]
  const results = await applyIssueEdits("key", ops, ISSUES, recordingFetch(calls))

  assertEquals(calls.length, 0)
  assertEquals(results.length, 0)
})

Deno.test("applyIssueEdits fails an edit with no captured UUID rather than calling Linear", async () => {
  const calls: Call[] = []
  const ops: Op[] = [{ kind: "rename", id: "ENG-3", title: "x" }]
  const results = await applyIssueEdits("key", ops, ISSUES, recordingFetch(calls))

  assertEquals(calls.length, 0)
  assertEquals(results[0].ok, false)
  assert(results[0].error?.includes("refresh from Linear"))
})

Deno.test("applyIssueEdits surfaces a GraphQL error as a failed result", async () => {
  const failing = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ errors: [{ message: "denied" }] }), { status: 200 }),
    )) as typeof fetch
  const results = await applyIssueEdits("key", [{ kind: "rename", id: "ENG-1", title: "x" }], ISSUES, failing)

  assertEquals(results[0].ok, false)
  assertEquals(results[0].error, "denied")
})
