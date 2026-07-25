import { assertEquals, assertExists } from "@std/assert"
import { generateSnapshots, type Issue, type Snapshot } from "@/seed.ts"
import { diffSnapshots, type FieldChange, RETURN_LOOKBACK_DAYS, type SnapshotDiff } from "@/diff.ts"

function change(diff: SnapshotDiff, id: string, field: FieldChange["field"]): FieldChange | undefined {
  return diff.issues.changes.find((c) => c.id === id && c.field === field)
}

function issue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    title: `title ${overrides.id}`,
    url: `https://linear.app/seed/issue/${overrides.id}`,
    estimate: 3,
    assignee: "Ada Lovelace",
    status: "Todo",
    statusType: "unstarted",
    priority: null,
    priorityValue: 0,
    labels: [],
    parentId: null,
    milestone: "M1",
    cycle: null,
    description: "Score candidates on breed compatibility.",
    blocks: [],
    blockedBy: [],
    related: [],
    ...overrides,
  }
}

function snapshot(asOf: string, issues: Issue[]): Snapshot {
  return {
    project: { name: "Horse Tinder (seed)", start: "2026-07-01", target: "2026-11-30", url: "https://linear.app/seed" },
    cycles: [{ n: 48, start: "2026-07-20", end: "2026-07-27" }],
    asOf,
    currentCycle: 48,
    teamCapacityPerCycle: 80,
    teamVelocity: 72,
    milestones: [
      { key: "M1", name: "M1: Matchmaking engine", target: "2026-07-31", progress: 55 },
      { key: "M2", name: "M2: Stable profiles", target: "2026-08-31", progress: 20 },
    ],
    issues,
    capacity: {
      config: { workdaysPerCycle: 5, oncallPenalty: 0.45 },
      defaultVelocity: 20,
      roster: {},
      people: {},
    },
  }
}

function daysBefore(asOf: string, days: number): string {
  return new Date(new Date(asOf).getTime() - days * 24 * 3600 * 1000).toISOString().slice(0, 10)
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

Deno.test("a team move keeps the ticket, reported as an identifier change", () => {
  const before = snapshot("2026-07-23", [issue({ id: "DEV-8", linearId: "uuid-1", estimate: 5 })])
  const after = snapshot("2026-07-30", [issue({ id: "OPS-2", linearId: "uuid-1", estimate: 5 })])
  const diff = diffSnapshots(before, after)

  assertEquals(diff.issues.added, [])
  assertEquals(diff.issues.removed, [])
  assertEquals(diff.project.pointsDelta, 0)
  const renamed = change(diff, "OPS-2", "identifier")
  assertExists(renamed)
  assertEquals(renamed.from, "DEV-8")
  assertEquals(renamed.to, "OPS-2")
})

Deno.test("matching falls back to the identifier for snapshots captured before linearId existed", () => {
  const before = snapshot("2026-07-23", [issue({ id: "DEV-8", estimate: 5 })])
  const after = snapshot("2026-07-30", [issue({ id: "DEV-8", linearId: "uuid-1", estimate: 8 })])
  const diff = diffSnapshots(before, after)

  assertEquals(diff.issues.added, [])
  assertEquals(diff.issues.removed, [])
  const est = change(diff, "DEV-8", "estimate")
  assertExists(est)
  assertEquals(est.to, 8)
})

Deno.test("a recycled identifier with a different uuid stays an add plus a remove", () => {
  const before = snapshot("2026-07-23", [issue({ id: "DEV-8", linearId: "uuid-1" })])
  const after = snapshot("2026-07-30", [issue({ id: "DEV-8", linearId: "uuid-2" })])
  const diff = diffSnapshots(before, after)

  assertEquals(diff.issues.added, ["DEV-8"])
  assertEquals(diff.issues.removed, ["DEV-8"])
})

Deno.test("an archived issue reports as archived, not removed", () => {
  const before = snapshot("2026-07-23", [issue({ id: "DEV-8", linearId: "uuid-1", estimate: 5 })])
  const after = snapshot("2026-07-30", [
    { ...issue({ id: "DEV-8", linearId: "uuid-1", estimate: 5 }), archived: true } as Issue,
  ])
  const diff = diffSnapshots(before, after)

  assertEquals(diff.issues.archived, ["DEV-8"])
  assertEquals(diff.issues.removed, [])
  assertEquals(diff.issues.added, [])
  assertEquals(diff.project.issuesAfter, 0)
  assertEquals(diff.project.pointsAfter, 0)
  assertEquals(diff.milestones.find((m) => m.key === "M1")!.archived, ["DEV-8"])
})

Deno.test("a missing archived field means live, and dropping out of the project is still removed", () => {
  const before = snapshot("2026-07-23", [issue({ id: "DEV-8", linearId: "uuid-1" })])
  const after = snapshot("2026-07-30", [])
  const diff = diffSnapshots(before, after)

  assertEquals(diff.issues.removed, ["DEV-8"])
  assertEquals(diff.issues.archived, [])
})

Deno.test("an issue gone at B and back at C is labelled returning with its prior context", () => {
  const older = snapshot("2026-07-09", [issue({ id: "DEV-8", linearId: "uuid-1", estimate: 5, milestone: "M2" })])
  const before = snapshot("2026-07-16", [])
  const after = snapshot("2026-07-23", [issue({ id: "DEV-8", linearId: "uuid-1", estimate: 2, milestone: "M1" })])
  const diff = diffSnapshots(before, after, [older])

  assertEquals(diff.issues.added, ["DEV-8"])
  assertEquals(diff.issues.returning.length, 1)
  assertEquals(diff.issues.returning[0], {
    id: "DEV-8",
    lastSeenAsOf: "2026-07-09",
    estimate: 5,
    milestone: "M2",
    descriptionUnchanged: true,
  })
})

Deno.test("a return is not claimed beyond the lookback window", () => {
  const asOf = "2026-07-23"
  const stale = snapshot(daysBefore(asOf, RETURN_LOOKBACK_DAYS + 10), [issue({ id: "DEV-8", linearId: "uuid-1" })])
  const before = snapshot(daysBefore(asOf, 7), [])
  const after = snapshot(asOf, [issue({ id: "DEV-8", linearId: "uuid-1" })])

  assertEquals(diffSnapshots(before, after, [stale]).issues.returning, [])
})

Deno.test("an edited description marks the return as changed", () => {
  const older = snapshot("2026-07-09", [issue({ id: "DEV-8", linearId: "uuid-1", description: "old text" })])
  const before = snapshot("2026-07-16", [])
  const after = snapshot("2026-07-23", [issue({ id: "DEV-8", linearId: "uuid-1", description: "new text" })])
  const diff = diffSnapshots(before, after, [older])

  assertEquals(diff.issues.returning[0].descriptionUnchanged, false)
})
