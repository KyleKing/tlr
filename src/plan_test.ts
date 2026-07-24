import { assert, assertEquals } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { planFromText } from "@/plan.ts"
import type { Op } from "@/ops.ts"

Deno.test("planFromText parses a multi-line block into the right ops", () => {
  const { a } = generateSnapshots()
  const text = [
    "move SEED-105 to M2",
    "set SEED-107 estimate to 8",
    "set SEED-102 priority to urgent",
    "assign SEED-134 to Ada Lovelace",
    "SEED-104 blocks SEED-103",
    "SEED-103 blocked by SEED-104",
    "rename SEED-101 to Add p99 latency panel",
    "set SEED-111 status to in progress",
    "flibbertigibbet the whatsit",
  ].join("\n")

  // SEED-134 only exists in the drifted snapshot, so plan against `b` for the assignee line.
  const { b } = generateSnapshots()
  const { ops, unparsed } = planFromText(text, b)

  assertEquals(unparsed, ["flibbertigibbet the whatsit"])
  assertEquals(ops.length, 8)

  const byKind = (k: Op["kind"]) => ops.filter((o) => o.kind === k)
  assertEquals(byKind("set_milestone")[0], { kind: "set_milestone", id: "SEED-105", milestone: "M2" })
  assertEquals(byKind("set_estimate")[0], { kind: "set_estimate", id: "SEED-107", estimate: 8 })
  assertEquals(byKind("set_priority")[0], { kind: "set_priority", id: "SEED-102", priority: 1 })
  assertEquals(byKind("set_assignee")[0], { kind: "set_assignee", id: "SEED-134", assignee: "Ada Lovelace" })
  assertEquals(byKind("rename")[0], { kind: "rename", id: "SEED-101", title: "Add p99 latency panel" })
  assertEquals(byKind("set_status")[0], { kind: "set_status", id: "SEED-111", status: "started" })

  const relations = byKind("add_relation")
  assert(relations.some((o) => o.kind === "add_relation" && o.relation === "blocks" && o.target === "SEED-103"))
  assert(relations.some((o) => o.kind === "add_relation" && o.relation === "blockedBy" && o.target === "SEED-104"))

  assert(a.issues.some((i) => i.id === "SEED-105"))
})

Deno.test("planFromText maps priority words to values", () => {
  const { a } = generateSnapshots()
  const text = [
    "set SEED-101 priority to none",
    "set SEED-102 priority to high",
    "set SEED-103 priority to medium",
    "set SEED-104 priority to low",
  ].join("\n")
  const { ops } = planFromText(text, a)
  const values = ops.map((o) => (o.kind === "set_priority" ? o.priority : -1))
  assertEquals(values, [0, 2, 3, 4])
})

Deno.test("planFromText sends unknown ids and milestones to unparsed", () => {
  const { a } = generateSnapshots()
  const text = ["move SEED-999 to M2", "move SEED-105 to Nowhere"].join("\n")
  const { ops, unparsed } = planFromText(text, a)
  assertEquals(ops.length, 0)
  assertEquals(unparsed.length, 2)
})
