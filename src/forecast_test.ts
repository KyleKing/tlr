import { assert, assertEquals } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { milestoneForecast } from "@/forecast.ts"

Deno.test("milestoneForecast sums base velocity across the roster", () => {
  const { a } = generateSnapshots()
  const f = milestoneForecast(a)
  // Ada 20, Grace 20, Alan 20 (defaultVelocity), Katherine 15 (per-person) = 75
  assertEquals(f.teamWeeklyPoints, 75)
})

Deno.test("milestoneForecast orders milestones by target and lands each sequentially", () => {
  const { a } = generateSnapshots()
  const f = milestoneForecast(a)
  const keys = f.milestones.map((m) => m.key)
  assertEquals(keys, ["M1", "M2", "M3", "M4"])
  for (let i = 1; i < f.milestones.length; i++) {
    assert(f.milestones[i].landing >= f.milestones[i - 1].landing)
  }
})

Deno.test("milestoneForecast excludes completed and canceled work from remaining", () => {
  const { b } = generateSnapshots()
  const f = milestoneForecast(b)
  for (const m of f.milestones) {
    assert(m.remainingPoints >= 0)
    assert(m.completedPoints >= 0)
  }
  // SEED-115 is canceled in b, so it counts toward neither remaining nor completed.
  const total = f.milestones.reduce((s, m) => s + m.remainingPoints + m.completedPoints, 0)
  const openOrDone = b.issues
    .filter((i) => i.milestone && i.statusType !== "canceled")
    .reduce((s, i) => s + (i.estimate || 0), 0)
  assertEquals(total, openOrDone)
})

Deno.test("milestoneForecast classifies slip against the target", () => {
  const { a } = generateSnapshots()
  const f = milestoneForecast(a)
  for (const m of f.milestones) {
    if (m.slipDays > 3) assertEquals(m.status, "at-risk")
    else if (m.slipDays < -3) assertEquals(m.status, "ahead")
    else assertEquals(m.status, "on-track")
  }
})
