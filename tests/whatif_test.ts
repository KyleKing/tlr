import { assertEquals, assertThrows } from "jsr:@std/assert@1"
import { applyOverlays, whatIfPlan } from "../web/lib/whatif.js"

const DATA = {
  asOf: "2026-07-23",
  currentCycle: 48,
  cycles: [
    { n: 47, start: "2026-07-13", end: "2026-07-20" },
    { n: 48, start: "2026-07-20", end: "2026-07-27" },
    { n: 49, start: "2026-07-27", end: "2026-08-03" },
  ],
  milestones: [
    { key: "M1", name: "M1: Engine", target: "2026-07-31", progress: 40 },
    { key: "M2", name: "M2: Profiles", target: "2026-08-31", progress: 10 },
  ],
  capacity: {
    config: { workdaysPerCycle: 5, oncallPenalty: 0.45 },
    defaultVelocity: 20,
    roster: { Ada: { email: "ada@x" }, Bob: { email: "bob@x" } },
    people: {},
  },
  issues: [
    { id: "T-1", milestone: "M1", cycle: 48, assignee: "Ada", statusType: "unstarted", estimate: 20 },
    { id: "T-2", milestone: "M1", cycle: 49, assignee: "Bob", statusType: "unstarted", estimate: 20 },
    { id: "T-3", milestone: "M2", cycle: null, assignee: "Ada", statusType: "unstarted", estimate: 40 },
  ],
}

const PTO = { kind: "capacity", person: "Ada", cycle: 48, patch: { outDays: 5, reason: "PTO" } }
const MOVE = { kind: "scope", id: "T-2", patch: { milestone: "M2" } }

Deno.test("applyOverlays leaves the stored snapshot alone", () => {
  const out = applyOverlays(DATA, [PTO, MOVE])
  assertEquals(out.capacity.people.Ada.cycles["48"].outDays, 5)
  assertEquals(out.issues[1].milestone, "M2")
  assertEquals(DATA.capacity.people, {})
  assertEquals(DATA.issues[1].milestone, "M1")
})

Deno.test("applyOverlays rejects an overlay kind it does not know", () => {
  assertThrows(() => applyOverlays(DATA, [{ kind: "rename", id: "T-1" }]), Error, "unknown what-if overlay")
})

Deno.test("a PTO overlay drops team throughput and pushes a milestone later", () => {
  const plan = whatIfPlan(DATA, [PTO])
  // Both people deliver 20/cycle, so the baseline averages 40 across cycles 48 and 49. Ada out all
  // five workdays of 48 takes that cycle to 20, and the average to 30.
  assertEquals(plan.baseline.teamWeeklyPoints, 40)
  assertEquals(plan.forecast.teamWeeklyPoints, 30)
  const m1 = plan.milestones[0]
  assertEquals(m1.key, "M1")
  assertEquals(m1.baselineLanding, "2026-07-30")
  assertEquals(m1.landing, "2026-08-01")
  assertEquals(m1.shiftDays, 2)
  assertEquals(plan.milestones[1].shiftDays > 0, true)
})

Deno.test("a scope move out of a milestone pulls it earlier", () => {
  const plan = whatIfPlan(DATA, [MOVE])
  const m1 = plan.milestones[0]
  assertEquals(m1.remainingPoints, 20)
  assertEquals(m1.baselineLanding, "2026-07-30")
  assertEquals(m1.landing, "2026-07-26")
  assertEquals(m1.shiftDays, -4)
  // The work did not vanish, it moved: M2 carries it instead.
  assertEquals(plan.milestones[1].remainingPoints, 60)
})

Deno.test("an overlay that changes nothing leaves every landing where it was", () => {
  const noop = { kind: "scope", id: "T-1", patch: { milestone: "M1", assignee: "Ada" } }
  const plan = whatIfPlan(DATA, [noop])
  assertEquals(plan.milestones.map((m) => m.shiftDays), [0, 0])
  assertEquals(plan.milestones.map((m) => m.landing), plan.baseline.milestones.map((m) => m.landing))
})

Deno.test("clearing an entry that was never set is also a no-op", () => {
  const clear = { kind: "capacity", person: "Bob", cycle: 49, patch: { oncall: null, outDays: null, reason: null } }
  const plan = whatIfPlan(DATA, [clear])
  assertEquals(plan.forecast.teamWeeklyPoints, 40)
  assertEquals(plan.milestones.map((m) => m.shiftDays), [0, 0])
})

Deno.test("stacked overlays compose: the PTO slowdown and the scope move both land", () => {
  const plan = whatIfPlan(DATA, [PTO, MOVE])
  assertEquals(plan.forecast.teamWeeklyPoints, 30)
  assertEquals(plan.snapshot.issues[1].milestone, "M2")
  const m1 = plan.milestones[0]
  // 20 points at 30/week from asOf, against 40 points at 40/week in the baseline.
  assertEquals(m1.remainingPoints, 20)
  assertEquals(m1.landing, "2026-07-27")
  assertEquals(m1.shiftDays, -3)
  // Stacking is order-independent here: the two overlays touch different things.
  assertEquals(whatIfPlan(DATA, [MOVE, PTO]).milestones, plan.milestones)
})

Deno.test("a later overlay wins over an earlier one on the same target", () => {
  const clear = { kind: "capacity", person: "Ada", cycle: 48, patch: { outDays: null, reason: null } }
  const plan = whatIfPlan(DATA, [PTO, clear])
  assertEquals(plan.forecast.teamWeeklyPoints, 40)
  assertEquals(plan.milestones.map((m) => m.shiftDays), [0, 0])
})
