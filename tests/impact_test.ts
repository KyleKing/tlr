import { assert, assertEquals } from "jsr:@std/assert@1"
import { impactKey, impactOf, reviewImpact, scopeImpact, scopePatch, textImpact } from "../web/lib/impact.js"

// Two rostered people at 20 points a cycle, two milestones, and arithmetic that makes every landing
// date below checkable by hand: 40 points a week of team throughput against the open work listed.
const issue = (id: string, over: Record<string, unknown>) => ({
  id,
  title: `Ticket ${id}`,
  description: "",
  status: "Todo",
  statusType: "unstarted",
  assignee: "Unassigned",
  cycle: null,
  estimate: 0,
  milestone: null,
  blocks: [],
  blockedBy: [],
  ...over,
})

const SNAPSHOT = {
  asOf: "2026-07-23",
  currentCycle: 48,
  cycles: [
    { n: 48, start: "2026-07-20", end: "2026-07-27" },
    { n: 49, start: "2026-07-27", end: "2026-08-03" },
  ],
  milestones: [
    { key: "M1", name: "M1: Engine", target: "2026-07-31", progress: 40 },
    { key: "M2", name: "M2: Profiles", target: "2026-08-31", progress: 10 },
  ],
  issues: [
    issue("FC-1", { estimate: 20, assignee: "Ada Lovelace", milestone: "M1", cycle: 48, blocks: ["FC-2"] }),
    issue("FC-2", { estimate: 20, assignee: "Bob Kahn", milestone: "M1", cycle: 49, blockedBy: ["FC-1"] }),
    issue("FC-3", { estimate: 40, assignee: "Ada Lovelace", milestone: "M2", cycle: null }),
  ],
  capacity: {
    config: { workdaysPerCycle: 5, oncallPenalty: 0.45 },
    defaultVelocity: 20,
    roster: { "Ada Lovelace": {}, "Bob Kahn": {} },
    people: {},
  },
}

const EDITED = SNAPSHOT.issues[0]

function ctxFor(over: Record<string, unknown> = {}, issueOver: Record<string, unknown> = {}) {
  const target = { ...EDITED, ...issueOver }
  return {
    changed: [],
    issue: target,
    snapshot: SNAPSHOT,
    source: "board",
    values: {
      assignee: target.assignee,
      cycle: target.cycle,
      description: target.description,
      estimate: target.estimate,
      milestone: target.milestone,
      priority: 0,
      status: target.status,
      title: target.title,
      ...over,
    },
  }
}

const patchFor = (over: Record<string, unknown> = {}) => scopePatch(EDITED, ctxFor(over).values)

Deno.test("only the fields that move the plan become a scope patch", () => {
  assertEquals(patchFor(), {})
  assertEquals(patchFor({ title: "Renamed", priority: 3 }), {})
  assertEquals(patchFor({ assignee: "Bob Kahn", cycle: 49 }), { assignee: "Bob Kahn", cycle: 49 })
})

// A blank estimate means "leave it alone" everywhere else in the editor, so it must not read here as a
// move to zero points.
Deno.test("a blank estimate never becomes a patch", () => {
  assertEquals(patchFor({ estimate: null }), {})
})

Deno.test("the memo key changes only when the plan-moving fields change", () => {
  const base = impactKey(ctxFor())
  assertEquals(impactKey(ctxFor({ description: "rewritten", title: "Renamed" })), base)
  assert(impactKey(ctxFor({ cycle: 49 })) !== base)
})

Deno.test("re-estimating shows the owner's load in the cycle before and after", () => {
  const { cells } = scopeImpact(ctxFor({ estimate: 8 }))
  assertEquals(cells, [{
    person: "Ada Lovelace",
    cycle: 48,
    before: 20,
    after: 8,
    capacity: 20,
    over: false,
  }])
})

Deno.test("moving the ticket reports the cell it lands in and the one it leaves", () => {
  const { cells } = scopeImpact(ctxFor({ assignee: "Bob Kahn", cycle: 49 }))
  assertEquals(cells.map((c: { person: string; cycle: number }) => [c.person, c.cycle]), [
    ["Bob Kahn", 49],
    ["Ada Lovelace", 48],
  ])
  assertEquals(cells[0].before, 20)
  assertEquals(cells[0].after, 40)
  assertEquals(cells[0].over, true)
  assertEquals(cells[1].after, 0)
})

Deno.test("an untouched form moves no load and no landing date", () => {
  const { cells, forecast } = scopeImpact(ctxFor())
  assertEquals(cells, [])
  assertEquals(forecast, [])
})

// Cutting 20 points out of M1 pulls its landing in, and M2 rides behind it, so both move.
Deno.test("dropping points pulls the milestone landings in", () => {
  const { forecast } = scopeImpact(ctxFor({ estimate: 0 }))
  assertEquals(forecast.map((m: { key: string }) => m.key), ["M1", "M2"])
  assert(forecast[0].shiftDays < 0)
  assert(forecast[0].landing < forecast[0].baselineLanding)
})

Deno.test("the blockers and the work waiting on the ticket are listed with their landing bucket", () => {
  const { dependencies } = scopeImpact(ctxFor())
  assertEquals(dependencies.blockedBy, [])
  assertEquals(dependencies.blocks.map((r: { id: string; lands: string }) => [r.id, r.lands]), [["FC-2", "2026-08-03"]])
  assertEquals(dependencies.risks, [])
})

// FC-2 waits on FC-1. Taking FC-1 out of its cycle and into the later milestone lands it after the
// work that depends on it.
Deno.test("a move that lands the ticket after the work waiting on it is an ordering risk", () => {
  const { dependencies } = scopeImpact(ctxFor({ cycle: null, milestone: "M2" }))
  assertEquals(dependencies.risks, [{ issue: "FC-2", blocker: "FC-1" }])
  assert(dependencies.blocks[0].risk)
})

Deno.test("the slop scan is silent until the description is rewritten", () => {
  assertEquals(textImpact(ctxFor()), null)
})

Deno.test("a rewrite is scored against the text it replaced", () => {
  const dirty = "This will comprehensively leverage a robust, seamless approach; it delves in."
  const worse = textImpact(ctxFor({ description: dirty }, { description: "Plain and short." }))!
  assertEquals(worse.verdict, "worse")
  assert(worse.now.score > worse.was.score)
  const better = textImpact(ctxFor({ description: "Plain and short." }, { description: dirty }))!
  assertEquals(better.verdict, "cleaner")
  assertEquals(better.now.flags, [])
})

Deno.test("the review window's rows only reach the pane from Review", () => {
  const items = [{ id: "FC-1", kind: "reestimated", summary: "FC-1 re-estimated", detail: { from: 3, to: 20 } }]
  assertEquals(reviewImpact({ ...ctxFor(), reviewItems: items }), [])
  assertEquals(reviewImpact({ ...ctxFor(), source: "review", reviewItems: items }), [{
    kind: "reestimated",
    summary: "FC-1 re-estimated",
    from: 3,
    to: 20,
  }])
})

Deno.test("every consequence worth acting on is repeated as a plain warning", () => {
  const { warnings } = impactOf(ctxFor({ assignee: "Bob Kahn", cycle: 49 }))
  assert(warnings.some((w: string) => w.includes("over capacity")))
})

Deno.test("a snapshot missing its plan blocks degrades instead of throwing", () => {
  const result = impactOf({ issue: { id: "X-1" }, snapshot: {}, values: {}, changed: [] })
  assertEquals(result.scope.cells, [])
  assertEquals(result.scope.forecast, [])
  assertEquals(result.warnings, [])
})
