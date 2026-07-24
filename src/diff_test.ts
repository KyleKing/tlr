import { assertEquals, assertExists } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { diffSnapshots, type FieldChange, type SnapshotDiff } from "@/diff.ts"

function change(diff: SnapshotDiff, id: string, field: FieldChange["field"]): FieldChange | undefined {
  return diff.issues.changes.find((c) => c.id === id && c.field === field)
}

Deno.test("diffSnapshots surfaces M2 target slip in days", () => {
  const { a, b } = generateSnapshots()
  const diff = diffSnapshots(a, b)
  const m2 = diff.milestones.find((m) => m.key === "M2")!
  assertEquals(m2.targetBefore, "2026-08-31")
  assertEquals(m2.targetAfter, "2026-09-15")
  assertEquals(m2.targetSlipDays, 15)
})

Deno.test("diffSnapshots reports scope moves as milestone changes and rollups", () => {
  const { a, b } = generateSnapshots()
  const diff = diffSnapshots(a, b)

  const move105 = change(diff, "SEED-105", "milestone")
  assertExists(move105)
  assertEquals(move105.from, "M1")
  assertEquals(move105.to, "M2")

  // The seed's intended SEED-112 slip is a no-op: its base milestone is already M3, so no change.
  assertEquals(change(diff, "SEED-112", "milestone"), undefined)

  const m2 = diff.milestones.find((m) => m.key === "M2")!
  const m1 = diff.milestones.find((m) => m.key === "M1")!
  assertEquals(m2.issuesIn.includes("SEED-105"), true)
  assertEquals(m1.issuesOut.includes("SEED-105"), true)
})

Deno.test("diffSnapshots records the cancellation", () => {
  const { a, b } = generateSnapshots()
  const diff = diffSnapshots(a, b)
  const cancel = change(diff, "SEED-115", "status")
  assertExists(cancel)
  assertEquals(cancel.to, "Canceled")
})

Deno.test("diffSnapshots lists the two added issues", () => {
  const { a, b } = generateSnapshots()
  const diff = diffSnapshots(a, b)
  assertEquals(diff.issues.added.includes("SEED-133"), true)
  assertEquals(diff.issues.added.includes("SEED-134"), true)
  assertEquals(diff.project.issueCountDelta, 2)
})

Deno.test("diffSnapshots captures the re-estimates", () => {
  const { a, b } = generateSnapshots()
  const diff = diffSnapshots(a, b)
  const est107 = change(diff, "SEED-107", "estimate")
  const est109 = change(diff, "SEED-109", "estimate")
  assertExists(est107)
  assertExists(est109)
  assertEquals(est107.to, 8)
  assertEquals(est109.to, 1)
})
