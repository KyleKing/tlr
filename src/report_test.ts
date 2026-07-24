import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { diffSnapshots } from "@/diff.ts"
import { renderReport, weeklyReport } from "@/report.ts"

Deno.test("weeklyReport carries the diff window and net scope", () => {
  const { a, b } = generateSnapshots()
  const diff = diffSnapshots(a, b)
  const report = weeklyReport(diff)
  assertEquals(report.window.from, "2026-07-23")
  assertEquals(report.window.to, "2026-07-30")
  assertEquals(report.totals.issueCountDelta, 2)
})

Deno.test("weeklyReport lists newly completed work as shipped", () => {
  const { a, b } = generateSnapshots()
  const report = weeklyReport(diffSnapshots(a, b))
  const ids = report.shipped.map((s) => s.id)
  // SEED-101 advances to completed in the drift.
  assert(ids.includes("SEED-101"))
})

Deno.test("weeklyReport flags M2 as moved and at-risk from its target slip", () => {
  const { a, b } = generateSnapshots()
  const report = weeklyReport(diffSnapshots(a, b))
  const movedM2 = report.moved.find((m) => m.key === "M2")!
  assert(movedM2)
  assertEquals(movedM2.targetSlipDays, 15)
  assert(report.atRisk.some((m) => m.key === "M2"))
})

Deno.test("renderReport produces the three narrative sections", () => {
  const { a, b } = generateSnapshots()
  const md = renderReport(weeklyReport(diffSnapshots(a, b)))
  assertStringIncludes(md, "## Shipped")
  assertStringIncludes(md, "## Moved")
  assertStringIncludes(md, "## At risk")
})
