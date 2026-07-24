import { assert, assertEquals } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { projectCapacity } from "@/commands/capacity.ts"

Deno.test("projectCapacity excludes Unassigned and covers both active cycles", () => {
  const { a } = generateSnapshots()
  const { rows } = projectCapacity(a)
  const people = [...new Set(rows.map((r) => r.person))]
  assert(!people.includes("Unassigned"))
  const cycles = [...new Set(rows.map((r) => r.cycle))].sort()
  assertEquals(cycles, [48, 49])
})

Deno.test("projectCapacity marks Grace Hopper's on-call cycle lower", () => {
  const { a } = generateSnapshots()
  const { rows } = projectCapacity(a)
  const grace48 = rows.find((r) => r.person === "Grace Hopper" && r.cycle === 48)!
  const grace49 = rows.find((r) => r.person === "Grace Hopper" && r.cycle === 49)!
  assert(grace48.capacity < grace49.capacity)
  assert(grace48.factors.some((f: { kind: string }) => f.kind === "oncall"))
})

Deno.test("projectCapacity totals sum the rows", () => {
  const { a } = generateSnapshots()
  const { rows, totals } = projectCapacity(a)
  assertEquals(totals.capacity, rows.reduce((acc, r) => acc + r.capacity, 0))
  assertEquals(totals.load, rows.reduce((acc, r) => acc + r.load, 0))
  assertEquals(totals.peopleOverCapacity, new Set(rows.filter((r) => r.over > 0).map((r) => r.person)).size)
})
