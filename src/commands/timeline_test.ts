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

Deno.test("projectTimeline surfaces the seeded ordering risk SEED-102/SEED-120", () => {
  const { a } = generateSnapshots()
  const { risks } = projectTimeline(a)
  const risk = risks.find((r) => r.issue === "SEED-102" && r.blocker === "SEED-120")
  assert(risk)
  assertEquals(risk!.detail, "SEED-102 is blocked by SEED-120, which finishes later")
})
