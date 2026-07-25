import { assertEquals } from "jsr:@std/assert@1"
import { ROADMAP_GEOMETRY, roadmapLayout } from "../web/lib/roadmap.js"

const BASE = {
  asOf: "2026-07-23",
  currentCycle: 48,
  cycles: [
    { n: 48, start: "2026-07-20", end: "2026-07-27" },
    { n: 49, start: "2026-07-27", end: "2026-08-03" },
  ],
  milestones: [{ key: "M1", name: "M1: Matchmaking", target: "2026-08-31", progress: 10 }],
  capacity: { defaultVelocity: 20, people: {}, roster: { Ada: { email: "ada@x" } } },
}

// deno-lint-ignore no-explicit-any
function issue(id: string, over: Record<string, unknown> = {}): any {
  return {
    id,
    title: id,
    assignee: "Ada",
    blockedBy: [],
    blocks: [],
    cycle: 48,
    estimate: 1,
    milestone: "M1",
    statusType: "unstarted",
    ...over,
  }
}

// deno-lint-ignore no-explicit-any
function cardFor(layout: any, id: string) {
  return layout.cards.find((c: { id: string }) => c.id === id)
}

Deno.test("roadmapLayout puts y on dependency-wave depth and x on the issue's cycle", () => {
  const layout = roadmapLayout({
    ...BASE,
    issues: [
      issue("A", { blocks: ["B"] }),
      issue("B", { blockedBy: ["A"], blocks: ["C"], cycle: 49 }),
      issue("C", { blockedBy: ["B"], cycle: 49 }),
      issue("D"),
    ],
  })

  assertEquals(layout.cards.map((c: { id: string }) => c.id).sort(), ["A", "B", "C", "D"])
  assertEquals(cardFor(layout, "A").wave, 0)
  assertEquals(cardFor(layout, "B").wave, 1)
  assertEquals(cardFor(layout, "C").wave, 2)
  // An issue with no blocking relation at all is unblocked, so it belongs in wave 0 like A.
  assertEquals(cardFor(layout, "D").wave, 0)
  assertEquals(layout.rows.map((r: { depth: number }) => r.depth), [0, 1, 2])

  // Time runs left to right: cycle 48 sits left of cycle 49.
  assertEquals(cardFor(layout, "A").x < cardFor(layout, "B").x, true)
  assertEquals(cardFor(layout, "B").x, cardFor(layout, "C").x)
  // Deeper waves sit lower.
  assertEquals(cardFor(layout, "B").y > cardFor(layout, "A").y, true)
  assertEquals(cardFor(layout, "C").y > cardFor(layout, "B").y, true)
})

Deno.test("roadmapLayout packs colliding cards into lanes instead of stacking them", () => {
  const layout = roadmapLayout({ ...BASE, issues: [issue("A"), issue("B"), issue("C", { cycle: 49 })] })

  const a = cardFor(layout, "A")
  const b = cardFor(layout, "B")
  // Same cycle and same wave, so the cell packs them into two lanes: same x, no overlap in y.
  assertEquals(a.column, b.column)
  assertEquals(a.wave, b.wave)
  assertEquals(a.x, b.x)
  assertEquals([a.lane, b.lane].sort(), [0, 1])
  assertEquals(Math.abs(a.y - b.y) >= ROADMAP_GEOMETRY.height, true)

  // The row grows to the widest cell, and the lone card in the next column keeps lane 0.
  assertEquals(layout.rows[0].lanes, 2)
  assertEquals(cardFor(layout, "C").lane, 0)
})

Deno.test("roadmapLayout dates an issue with no cycle by its milestone, and drops one with neither into Backlog", () => {
  const layout = roadmapLayout({
    ...BASE,
    issues: [
      issue("A", { estimate: 40 }),
      issue("B", { cycle: null, estimate: 40 }),
      issue("C", { cycle: null, milestone: null }),
    ],
  })

  assertEquals(cardFor(layout, "B").column, "M1")
  assertEquals(cardFor(layout, "C").column, "BACKLOG")
  // Cycle 48 ends before M1's forecast landing, and Backlog is always last on the time axis.
  assertEquals(layout.columns.map((c: { key: string }) => c.key), ["C48", "M1", "BACKLOG"])
  assertEquals(cardFor(layout, "A").x < cardFor(layout, "B").x, true)
  assertEquals(cardFor(layout, "B").x < cardFor(layout, "C").x, true)
  assertEquals(layout.columns[1].label, "Matchmaking")
})

Deno.test("roadmapLayout returns an empty plane for a project with no issues", () => {
  const layout = roadmapLayout({ ...BASE, issues: [] })

  assertEquals(layout.cards, [])
  assertEquals(layout.columns, [])
  assertEquals(layout.edges, [])
  assertEquals(layout.rows, [])
  assertEquals(layout.width, ROADMAP_GEOMETRY.padX * 2)
  assertEquals(layout.height, ROADMAP_GEOMETRY.padY * 2)
  // A snapshot missing every optional field still lays out rather than throwing.
  assertEquals(roadmapLayout({}).cards, [])
})

Deno.test("roadmapLayout draws an edge per blocking relation and marks the ones that run backward", () => {
  const layout = roadmapLayout({
    ...BASE,
    issues: [
      issue("A", { blocks: ["B"], cycle: 49 }),
      issue("B", { blockedBy: ["A", "GONE"], cycle: 48 }),
    ],
  })

  // A blocker sitting in a later cycle than what it blocks draws backward on the time axis.
  assertEquals(layout.edges.length, 1)
  assertEquals(layout.edges[0].from, "A")
  assertEquals(layout.edges[0].to, "B")
  assertEquals(layout.edges[0].backward, true)

  // A blocker that is not on the plane (filtered out, or in another project) draws no dangling edge.
  assertEquals(roadmapLayout({ ...BASE, issues: [issue("B", { blockedBy: ["GONE"] })] }).edges, [])
})
