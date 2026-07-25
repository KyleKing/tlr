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

Deno.test("blocks and blockedBy stay symmetric, and one seeded chain misses its milestone", () => {
  const { a } = generateSnapshots()
  const byId = Object.fromEntries(a.issues.map((i) => [i.id, i]))
  for (const i of a.issues) {
    for (const b of i.blockedBy) assert(byId[b].blocks.includes(i.id))
    for (const b of i.blocks) assert(byId[b].blockedBy.includes(i.id))
  }
  assert(byId["SEED-102"].blockedBy.includes("SEED-120"))
  // The deliberate chain risk: three 13-point tickets on one owner, aimed at M1.
  assert(byId["SEED-126"].blockedBy.includes("SEED-125"))
  assert(byId["SEED-127"].blockedBy.includes("SEED-126"))
  for (const id of ["SEED-125", "SEED-126", "SEED-127"]) {
    assertEquals(byId[id].milestone, "M1")
    assertEquals(byId[id].estimate, 13)
    assertEquals(byId[id].assignee, byId["SEED-125"].assignee)
  }
})
