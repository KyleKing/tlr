import { assert, assertEquals } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { projectTimeline } from "@/commands/timeline.ts"

Deno.test("projectTimeline orders the seeded blocking chain into waves", () => {
  const { a } = generateSnapshots()
  const { waves } = projectTimeline(a)
  assert(waves.length >= 2)
  assertEquals(waves[0].wave, 0)
  const waveOf = (id: string) => waves.findIndex((w) => w.issues.some((i) => i.id === id))
  assert(waveOf("SEED-101") < waveOf("SEED-103"))
  assert(waveOf("SEED-103") < waveOf("SEED-104"))
})

Deno.test("projectTimeline flags the seeded chain that one owner cannot finish before M1", () => {
  const { a } = generateSnapshots()
  const { chains } = projectTimeline(a)
  const risky = chains.filter((c) => c.atRisk)
  assertEquals(risky.length, 1)
  assertEquals(risky[0].path, ["SEED-125", "SEED-126", "SEED-127"])
  assertEquals(risky[0].owners.map((o) => o.person), ["Ada Lovelace"])
  assert(risky[0].shortfall! > 0)
  assert(risky[0].detail.includes("cycles short"))
})

Deno.test("projectTimeline leaves a chain with room to spare unflagged", () => {
  const { a } = generateSnapshots()
  const { chains } = projectTimeline(a)
  const roomy = chains.find((c) => c.path.includes("SEED-101"))
  assert(roomy)
  assertEquals(roomy!.atRisk, false)
  assert(roomy!.detail.includes("slack"))
})
