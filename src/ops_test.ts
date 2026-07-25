import { assert, assertEquals } from "@std/assert"
import { generateSnapshots, type ProjectTeam, type Snapshot } from "@/seed.ts"
import { applyOps, type Op, validateOp } from "@/ops.ts"

Deno.test("validateOp rejects a move to a nonexistent milestone", () => {
  const { a } = generateSnapshots()
  const op: Op = { kind: "set_milestone", id: "SEED-105", milestone: "M99" }
  const result = validateOp(op, a)
  assertEquals(result.ok, false)
})

Deno.test("validateOp rejects a priority of 9", () => {
  const { a } = generateSnapshots()
  const op: Op = { kind: "set_priority", id: "SEED-102", priority: 9 }
  const result = validateOp(op, a)
  assertEquals(result.ok, false)
})

Deno.test("validateOp rejects a self-relation", () => {
  const { a } = generateSnapshots()
  const op: Op = { kind: "add_relation", id: "SEED-101", relation: "blocks", target: "SEED-101" }
  assertEquals(validateOp(op, a).ok, false)
})

Deno.test("applyOps moves SEED-105 to M2 without mutating the input", () => {
  const { a } = generateSnapshots()
  const before = a.issues.find((i) => i.id === "SEED-105")!.milestone
  const { after, applied, skipped } = applyOps(a, [{ kind: "set_milestone", id: "SEED-105", milestone: "M2" }])

  assertEquals(applied.length, 1)
  assertEquals(skipped.length, 0)
  assertEquals(after.issues.find((i) => i.id === "SEED-105")!.milestone, "M2")
  assertEquals(a.issues.find((i) => i.id === "SEED-105")!.milestone, before)
})

Deno.test("applyOps keeps blocks/blockedBy symmetric when adding a relation", () => {
  const { a } = generateSnapshots()
  const op: Op = { kind: "add_relation", id: "SEED-110", relation: "blocks", target: "SEED-111" }
  const { after } = applyOps(a, [op])

  const blocker = after.issues.find((i) => i.id === "SEED-110")!
  const blocked = after.issues.find((i) => i.id === "SEED-111")!
  assert(blocker.blocks.includes("SEED-111"))
  assert(blocked.blockedBy.includes("SEED-110"))
})

Deno.test("applyOps removes both sides of a relation and stays symmetric", () => {
  const { a } = generateSnapshots()
  const add: Op = { kind: "add_relation", id: "SEED-110", relation: "related", target: "SEED-111" }
  const remove: Op = { kind: "remove_relation", id: "SEED-110", relation: "related", target: "SEED-111" }
  const { after } = applyOps(a, [add, remove])

  const one = after.issues.find((i) => i.id === "SEED-110")!
  const two = after.issues.find((i) => i.id === "SEED-111")!
  assert(!one.related.includes("SEED-111"))
  assert(!two.related.includes("SEED-110"))
})

Deno.test("applyOps skips invalid ops and records the reason", () => {
  const { a } = generateSnapshots()
  const ops: Op[] = [
    { kind: "set_estimate", id: "SEED-107", estimate: 8 },
    { kind: "set_milestone", id: "SEED-107", milestone: "M99" },
  ]
  const { after, applied, skipped } = applyOps(a, ops)

  assertEquals(applied.length, 1)
  assertEquals(skipped.length, 1)
  assertEquals(skipped[0].op.kind, "set_milestone")
  assertEquals(after.issues.find((i) => i.id === "SEED-107")!.estimate, 8)
})

Deno.test("applyOps sets status type and display label together", () => {
  const { a } = generateSnapshots()
  const { after } = applyOps(a, [{ kind: "set_status", id: "SEED-111", status: "started" }])
  const issue = after.issues.find((i) => i.id === "SEED-111")!
  assertEquals(issue.statusType, "started")
  assertEquals(issue.status, "In Progress")
})

// A team with two "started" states: the op has to be able to name which one, or the second is
// unreachable and the ticket lands in whichever Linear returns first.
const TEAM_WITH_TWO_STARTED: ProjectTeam = {
  id: "t-seed",
  key: "SEED",
  name: "Seed",
  estimation: { type: "fibonacci", allowZero: true, extended: false },
  states: [
    { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "s-prog", name: "In Progress", type: "started", position: 2 },
    { id: "s-review", name: "In Review", type: "started", position: 3 },
  ],
}

function withTeams(): Snapshot {
  const { a } = generateSnapshots()
  return { ...a, teams: [TEAM_WITH_TWO_STARTED] }
}

Deno.test("applyOps writes the named state, not the first of its category", () => {
  const { after } = applyOps(withTeams(), [
    { kind: "set_status", id: "SEED-111", status: "started", statusName: "In Review" },
  ])
  const issue = after.issues.find((i) => i.id === "SEED-111")!
  assertEquals(issue.statusType, "started")
  assertEquals(issue.status, "In Review")
})

Deno.test("validateOp rejects a state name the issue's own team does not have", () => {
  const snapshot = withTeams()
  const op: Op = { kind: "set_status", id: "SEED-111", status: "started", statusName: "Shipping" }
  assertEquals(validateOp(op, snapshot).ok, false)
})

// Every snapshot captured before ingest fetched team states has no states to check a name against.
// Refusing those would break status edits on all of them, so the type alone still carries the change.
Deno.test("validateOp accepts a named state on a snapshot with no team data and keeps the label", () => {
  const { a } = generateSnapshots()
  const op: Op = { kind: "set_status", id: "SEED-111", status: "started", statusName: "In Review" }
  assertEquals(validateOp(op, a).ok, true)
  assertEquals(applyOps(a, [op]).after.issues.find((i) => i.id === "SEED-111")!.status, "In Review")
})
