import { assertEquals } from "@std/assert"
import { generateSnapshots, type Issue, type Snapshot } from "@/seed.ts"
import { reviewSince } from "@/review.ts"

const SLOP =
  "This ticket will comprehensively leverage a robust, seamless approach to delight our equine users; it delves into the core.\n- [ ] step one\n- [ ] step two"

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
    milestones: [{ key: "M1", name: "M1: Matchmaking engine", target: "2026-07-31", progress: 55 }],
    issues,
    capacity: {
      config: { workdaysPerCycle: 5, oncallPenalty: 0.45 },
      defaultVelocity: 20,
      roster: {},
      people: {},
    },
  }
}

Deno.test("reviewSince windows the two snapshots", () => {
  const { a, b } = generateSnapshots()
  const queue = reviewSince(a, b)
  assertEquals(queue.window, { from: a.asOf, to: b.asOf })
})

Deno.test("reviewSince surfaces the added issues", () => {
  const { a, b } = generateSnapshots()
  const queue = reviewSince(a, b)
  const added = queue.items.filter((i) => i.kind === "added").map((i) => i.id)
  assertEquals(added.includes("SEED-133"), true)
  assertEquals(added.includes("SEED-134"), true)
})

Deno.test("reviewSince flags the slop ticket", () => {
  const { a, b } = generateSnapshots()
  const queue = reviewSince(a, b)
  const slop = queue.items.filter((i) => i.kind === "slop").map((i) => i.id)
  assertEquals(slop.includes("SEED-134"), true)
})

Deno.test("reviewSince stays sorted by id", () => {
  const { a, b } = generateSnapshots()
  const queue = reviewSince(a, b)
  const ids = queue.items.map((i) => i.id)
  assertEquals(ids, [...ids].sort())
})

Deno.test("an archived ticket is its own review outcome, separate from a removal", () => {
  const before = snapshot("2026-07-16", [
    issue({ id: "DEV-8", linearId: "uuid-1" }),
    issue({ id: "DEV-9", linearId: "uuid-2" }),
  ])
  const after = snapshot("2026-07-23", [
    { ...issue({ id: "DEV-8", linearId: "uuid-1" }), archived: true } as Issue,
  ])
  const queue = reviewSince(before, after)

  assertEquals(queue.items.filter((i) => i.kind === "archived").map((i) => i.id), ["DEV-8"])
  assertEquals(queue.items.filter((i) => i.kind === "removed").map((i) => i.id), ["DEV-9"])
})

Deno.test("a cancellation stays a status regression, not an archive", () => {
  const before = snapshot("2026-07-16", [issue({ id: "DEV-8", linearId: "uuid-1" })])
  const after = snapshot("2026-07-23", [
    issue({ id: "DEV-8", linearId: "uuid-1", status: "Canceled", statusType: "canceled" }),
  ])
  const queue = reviewSince(before, after)

  assertEquals(queue.items.map((i) => i.kind), ["status"])
  assertEquals(queue.items[0].detail.to, "Canceled")
})

Deno.test("a returning ticket carries its prior estimate and milestone", () => {
  const older = snapshot("2026-07-09", [issue({ id: "DEV-8", linearId: "uuid-1", estimate: 5, milestone: "M2" })])
  const before = snapshot("2026-07-16", [])
  const after = snapshot("2026-07-23", [issue({ id: "DEV-8", linearId: "uuid-1", estimate: 2 })])
  const queue = reviewSince(before, after, [older])

  assertEquals(queue.items.map((i) => i.kind), ["returning"])
  assertEquals(queue.items[0].detail.priorEstimate, 5)
  assertEquals(queue.items[0].detail.priorMilestone, "M2")
  assertEquals(queue.items[0].detail.lastSeenAsOf, "2026-07-09")
})

Deno.test("a return does not re-run the slop scan on an unchanged description", () => {
  const older = snapshot("2026-07-09", [issue({ id: "DEV-8", linearId: "uuid-1", description: SLOP })])
  const before = snapshot("2026-07-16", [])
  const after = snapshot("2026-07-23", [issue({ id: "DEV-8", linearId: "uuid-1", description: SLOP })])

  assertEquals(reviewSince(before, after, [older]).items.filter((i) => i.kind === "slop"), [])
  assertEquals(reviewSince(before, after).items.filter((i) => i.kind === "slop").length, 1)
})

Deno.test("a return with an edited description is scanned again", () => {
  const older = snapshot("2026-07-09", [issue({ id: "DEV-8", linearId: "uuid-1", description: "clean enough" })])
  const before = snapshot("2026-07-16", [])
  const after = snapshot("2026-07-23", [issue({ id: "DEV-8", linearId: "uuid-1", description: SLOP })])

  assertEquals(reviewSince(before, after, [older]).items.filter((i) => i.kind === "slop").length, 1)
})
