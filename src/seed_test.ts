import { generateSnapshots } from "@/seed.ts"
import { assert, assertEquals } from "@std/assert"

Deno.test("generateSnapshots is deterministic", () => {
  const one = generateSnapshots()
  const two = generateSnapshots()
  assertEquals(JSON.stringify(one), JSON.stringify(two))
})

Deno.test("the b snapshot carries a week of drift over a", () => {
  const { a, b } = generateSnapshots()
  assertEquals(a.asOf, "2026-07-23")
  assertEquals(b.asOf, "2026-07-30")

  const find = (snap: typeof a, id: string) => snap.issues.find((i) => i.id === id)

  // scope slips
  assertEquals(find(a, "SEED-105")!.milestone, "M1")
  assertEquals(find(b, "SEED-105")!.milestone, "M2")
  assertEquals(find(b, "SEED-112")!.milestone, "M3")

  // milestone target slip
  assertEquals(a.milestones.find((m) => m.key === "M2")!.target, "2026-08-31")
  assertEquals(b.milestones.find((m) => m.key === "M2")!.target, "2026-09-15")

  // a cancellation and two additions
  assertEquals(find(b, "SEED-115")!.statusType, "canceled")
  assert(!find(a, "SEED-133"))
  assert(find(b, "SEED-133"))
  assert(find(b, "SEED-134"))
})

Deno.test("blocks and blockedBy stay symmetric and seed an ordering risk", () => {
  const { a } = generateSnapshots()
  const byId = Object.fromEntries(a.issues.map((i) => [i.id, i]))
  for (const i of a.issues) {
    for (const b of i.blockedBy) assert(byId[b].blocks.includes(i.id))
    for (const b of i.blocks) assert(byId[b].blockedBy.includes(i.id))
  }
  // SEED-102 is blocked by SEED-120, which sits in a later milestone
  assert(byId["SEED-102"].blockedBy.includes("SEED-120"))
})
