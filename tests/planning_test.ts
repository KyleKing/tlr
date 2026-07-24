import { assertEquals } from "jsr:@std/assert@1"
import {
  bucketOf,
  buildBuckets,
  dependencyWaves,
  milestoneCapacity,
  milestoneDisplayName,
  milestoneForecast,
  missingData,
  orderingRisks,
  personCycleCapacity,
  slopHash,
  slopScan,
  statusRank,
  teamWeeklyThroughput,
  weeksBetween,
} from "../web/lib/planning.js"

const DATA = {
  asOf: "2026-07-23",
  currentCycle: 48,
  cycles: [
    { n: 47, start: "2026-07-13", end: "2026-07-20" },
    { n: 48, start: "2026-07-20", end: "2026-07-27" },
    { n: 49, start: "2026-07-27", end: "2026-08-03" },
  ],
  milestones: [
    { key: "M1", name: "M1", target: "2026-07-31", progress: 66 },
    { key: "M2", name: "M2", target: "2026-08-31", progress: 27 },
  ],
}

Deno.test("bucketOf places issues by cycle, then milestone, then backlog", () => {
  assertEquals(bucketOf({ cycle: 48, milestone: "M2" }), "C48")
  assertEquals(bucketOf({ cycle: null, milestone: "M2" }), "M2")
  assertEquals(bucketOf({ cycle: null, milestone: null }), "BACKLOG")
  assertEquals(bucketOf({ cycle: 47, milestone: "M1" }), "C47")
})

Deno.test("buildBuckets orders cycles then milestones then backlog", () => {
  const keys = buildBuckets(DATA).map((b) => b.key)
  assertEquals(keys, ["C47", "C48", "C49", "M1", "M2", "BACKLOG"])
})

Deno.test("milestoneDisplayName drops an M#: prefix but keeps a plain name", () => {
  assertEquals(milestoneDisplayName("M1: Measure and page", "M1"), "Measure and page")
  assertEquals(milestoneDisplayName("M12: Chaos", "M12"), "Chaos")
  assertEquals(milestoneDisplayName("Reliability hardening", "abc"), "Reliability hardening")
  assertEquals(milestoneDisplayName("", "M3"), "M3")
})

Deno.test("milestoneForecast lands milestones sequentially by target date", () => {
  const data = {
    ...DATA,
    issues: [
      { milestone: "M1", statusType: "unstarted", estimate: 20, assignee: "A" },
      { milestone: "M2", statusType: "unstarted", estimate: 20, assignee: "A" },
    ],
    capacity: { roster: { A: { email: "a@x" } }, defaultVelocity: 20, people: {} },
  }
  const fc = milestoneForecast(data)
  assertEquals(fc.teamWeeklyPoints, 20)
  assertEquals(fc.milestones.map((m) => m.key), ["M1", "M2"])
  // M1 needs one week from asOf; M2 starts after M1 lands, so its landing is later.
  assertEquals(fc.milestones[1].landing > fc.milestones[0].landing, true)

  // A throughput override replaces the roster-sum and slows the landings (half the rate, so M1's one
  // week of work takes two).
  const slow = milestoneForecast(data, 10)
  assertEquals(slow.teamWeeklyPoints, 10)
  assertEquals(slow.milestones[0].weeksNeeded, 2)
  assertEquals(slow.milestones[0].landing > fc.milestones[0].landing, true)

  // A non-positive override is meaningless and falls back to the roster sum, not a nonsense date.
  assertEquals(milestoneForecast(data, 0).teamWeeklyPoints, 20)
  assertEquals(milestoneForecast(data, -5).teamWeeklyPoints, 20)
})

Deno.test("teamWeeklyThroughput averages deflated per-cycle capacity and drops below the base sum", () => {
  const data = {
    ...DATA,
    issues: [],
    capacity: {
      config: { workdaysPerCycle: 5, oncallPenalty: 0.45 },
      defaultVelocity: 20,
      roster: { A: { email: "a@x" }, B: { email: "b@x" } },
      people: { A: { cycles: { "48": { oncall: true } } } }, // A on-call in cycle 48 only
    },
  }
  // C48: A 20*(1-0.45)=11, B 20 -> 31. C49: A 20, B 20 -> 40. Average -> 36, under the 40 base sum.
  assertEquals(teamWeeklyThroughput(data), 36)
})

Deno.test("weeksBetween is roughly right and never negative", () => {
  assertEquals(Math.round(weeksBetween("2026-07-13", "2026-07-20")), 1)
  assertEquals(weeksBetween("2026-07-20", "2026-07-13"), 0)
})

Deno.test("milestoneCapacity scales with weeks remaining", () => {
  const m1 = milestoneCapacity("M1", DATA, 10) // ~1.1 weeks from asOf
  const m2 = milestoneCapacity("M2", DATA, 10) // ~4.4 weeks from M1 target
  assertEquals(m1 < m2, true)
  assertEquals(m1 > 0, true)
})

Deno.test("slopScan catches dashes, semicolons, phrases, checklists, length", () => {
  assertEquals(slopScan("a clean short note").flags.length, 0)
  assertEquals(slopScan("we use an em—dash here").flags.includes("em/en dash"), true)
  assertEquals(slopScan("first clause; second clause").flags.includes("semicolon"), true)
  assertEquals(slopScan("- [ ] a task item").flags.includes("checklist"), true)
  const p = slopScan("This leverages a comprehensive robust approach")
  assertEquals(p.flags.some((f) => f.startsWith("phrase")), true)
  assertEquals(p.score >= 1, true)
})

Deno.test("missingData only blocks when the issue is in an active cycle", () => {
  assertEquals(missingData({ cycle: 48, estimate: 0, assignee: "Unassigned", milestone: null }).blocking, true)
  assertEquals(missingData({ cycle: null, estimate: 0, assignee: "Unassigned", milestone: null }).blocking, false)
  assertEquals(missingData({ cycle: 48, estimate: 3, assignee: "Ada", milestone: "M1" }).flags.length, 0)
})

Deno.test("slopHash is stable across whitespace reflow and changes with content", () => {
  assertEquals(slopHash("hello   world"), slopHash("hello world\n"))
  assertEquals(slopHash("hello world") === slopHash("hello there"), false)
})

Deno.test("statusRank orders active work before terminal states", () => {
  assertEquals(statusRank("started") < statusRank("backlog"), true)
  assertEquals(statusRank("backlog") < statusRank("completed"), true)
  assertEquals(statusRank("canceled") > statusRank("triage"), true)
})

Deno.test("personCycleCapacity deflates for time off and on-call", () => {
  const cap = {
    config: { workdaysPerCycle: 5, oncallPenalty: 0.4 },
    defaultVelocity: 20,
    people: {
      Ada: { velocity: 20, cycles: { "48": { oncall: true }, "49": { outDays: 5, reason: "PTO" } } },
    },
  }
  assertEquals(personCycleCapacity("Nobody", 48, cap).points, 20) // default velocity, no events
  assertEquals(personCycleCapacity("Ada", 48, cap).points, 12) // 20 * (1 - 0.4)
  assertEquals(personCycleCapacity("Ada", 49, cap).points, 0) // all 5 workdays out
  assertEquals(personCycleCapacity("Ada", 48, cap).factors[0].kind, "oncall")
  assertEquals(personCycleCapacity("Ada", null, cap).factors.length, 0) // no cycle, no deflation
})

Deno.test("dependencyWaves orders by blocker depth and excludes unconnected issues", () => {
  const issues = [
    { id: "A", blockedBy: [], blocks: ["B"] },
    { id: "B", blockedBy: ["A"], blocks: ["C"] },
    { id: "C", blockedBy: ["B"], blocks: [] },
    { id: "D", blockedBy: [], blocks: [] }, // no relations, excluded
  ]
  assertEquals(dependencyWaves(issues), [["A"], ["B"], ["C"]])
})

Deno.test("dependencyWaves breaks a cycle into a final wave instead of hanging", () => {
  const issues = [
    { id: "X", blockedBy: ["Y"], blocks: ["Y"] },
    { id: "Y", blockedBy: ["X"], blocks: ["X"] },
  ]
  const waves = dependencyWaves(issues)
  assertEquals(waves.length, 1)
  assertEquals(waves[0].sort(), ["X", "Y"])
})

Deno.test("orderingRisks flags a blocker that finishes after its dependent", () => {
  const issues = [
    { id: "A", blockedBy: ["B"], statusType: "unstarted", _bucketEnd: "2026-07-31" },
    { id: "B", blockedBy: [], statusType: "unstarted", _bucketEnd: "2026-08-31" },
  ]
  assertEquals(orderingRisks(issues), [{ issue: "A", blocker: "B" }])
})

Deno.test("orderingRisks ignores completed blockers", () => {
  const issues = [
    { id: "A", blockedBy: ["B"], statusType: "unstarted", _bucketEnd: "2026-07-31" },
    { id: "B", blockedBy: [], statusType: "completed", _bucketEnd: "2026-08-31" },
  ]
  assertEquals(orderingRisks(issues), [])
})
