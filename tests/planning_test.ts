import { assertEquals } from "jsr:@std/assert@1"
import {
  bucketOf,
  buildBuckets,
  chainRisks,
  dependencyWaves,
  milestoneCapacity,
  milestoneDisplayName,
  milestoneForecast,
  missingData,
  personCycleCapacity,
  planningPeople,
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
  // Any cycle number routes to its own column, not just a fixed 47-49 window (see buildBuckets).
  assertEquals(bucketOf({ cycle: 112, milestone: "M1" }), "C112")
})

Deno.test("buildBuckets orders cycles then milestones then backlog", () => {
  const keys = buildBuckets(DATA).map((b) => b.key)
  assertEquals(keys, ["C47", "C48", "C49", "M1", "M2", "BACKLOG"])
})

Deno.test("buildBuckets drops a cycle column with no issues in it", () => {
  const issues = [{ cycle: 48, milestone: null }, { cycle: null, milestone: "M1" }]
  const keys = buildBuckets(DATA, issues).map((b) => b.key)
  assertEquals(keys, ["C48", "M1", "M2", "BACKLOG"])
})

Deno.test("buildBuckets shows a cycle with tickets even when it sits past a gap outside the usual window", () => {
  const dataWithGap = {
    ...DATA,
    cycles: [...DATA.cycles, { n: 52, start: "2026-08-17", end: "2026-08-24" }],
  }
  const issues = [{ cycle: 52, milestone: null }]
  const keys = buildBuckets(dataWithGap, issues).map((b) => b.key)
  assertEquals(keys, ["C52", "M1", "M2", "BACKLOG"])
  assertEquals(buildBuckets(dataWithGap, issues)[0].sub, "next")
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
    // Throughput counts whoever owns work here, not whoever is on the roster.
    issues: [
      { assignee: "A", statusType: "unstarted", estimate: 5, milestone: "M1" },
      { assignee: "B", statusType: "unstarted", estimate: 5, milestone: "M1" },
    ],
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
  assertEquals(missingData({ cycle: 48, estimate: 0, assignee: "Unassigned", milestone: null }, DATA).blocking, true)
  assertEquals(
    missingData({ cycle: null, estimate: 0, assignee: "Unassigned", milestone: null }, DATA).blocking,
    false,
  )
  assertEquals(missingData({ cycle: 48, estimate: 3, assignee: "Ada", milestone: "M1" }, DATA).flags.length, 0)
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

// One-week cycles, so "cycles available" is weeks between asOf and the milestone target.
type Capacity = { roster?: Record<string, unknown>; people: Record<string, { velocity: number }> }
type ChainIssue = ReturnType<typeof chained>

function chainSnapshot(issues: ChainIssue[], capacity: Capacity | null = null) {
  return {
    asOf: "2026-07-23",
    milestones: [{ key: "M1", target: "2026-08-06" }],
    capacity: capacity ?? {
      roster: { Ada: {}, Bo: {} },
      people: { Ada: { velocity: 10 }, Bo: { velocity: 5 } },
    },
    issues,
  }
}

const chained = (id: string, estimate: number, assignee: string, blocks: string[]) => ({
  id,
  estimate,
  assignee,
  blocks,
  blockedBy: [] as string[],
  statusType: "unstarted",
  milestone: "M1" as string | null,
  cycle: null as number | null,
})

Deno.test("chainRisks charges the heaviest path to its owners, one segment at a time", () => {
  const snap = chainSnapshot([
    chained("A", 10, "Ada", ["B"]),
    chained("B", 10, "Bo", []),
  ])
  const [chain] = chainRisks(snap)
  assertEquals(chain.path, ["A", "B"])
  assertEquals(chain.points, 20)
  // Ada needs 1 cycle for her 10 points, Bo needs 2 for his: sequential, so 3 rather than 20/15.
  assertEquals(chain.owners.map((o) => [o.person, o.cycles]), [["Bo", 2], ["Ada", 1]])
  assertEquals(chain.cyclesNeeded, 3)
  assertEquals(chain.cyclesAvailable, 2)
  assertEquals(chain.shortfall, 1)
  assertEquals(chain.atRisk, true)
})

Deno.test("chainRisks only counts the heaviest path, not work that runs beside it", () => {
  const snap = chainSnapshot([
    chained("A", 10, "Ada", ["B", "C"]),
    chained("B", 10, "Ada", []),
    chained("C", 1, "Ada", []),
  ])
  const [chain] = chainRisks(snap)
  assertEquals(chain.ids, ["A", "B", "C"])
  assertEquals(chain.path, ["A", "B"])
  assertEquals(chain.points, 20)
})

Deno.test("chainRisks reads a blocks edge with no matching blockedBy, which is what a real ingest holds", () => {
  const snap = chainSnapshot([
    chained("A", 10, "Ada", ["B"]),
    chained("B", 10, "Ada", []),
  ])
  const [chain] = chainRisks(snap)
  assertEquals(chain.path, ["A", "B"])
})

Deno.test("chainRisks leaves completed work out of the chain", () => {
  const done = { ...chained("A", 30, "Bo", ["B"]), statusType: "completed" }
  const [chain] = chainRisks(chainSnapshot([done, chained("B", 5, "Ada", [])]))
  assertEquals(chain, undefined)
})

// Ada at 10 and Bo at 5 own work here, so unowned work is charged at their median rather than the
// default velocity, which would have made it the fastest work in the plan.
Deno.test("chainRisks charges unassigned work at the median of the people who own work", () => {
  const snap = chainSnapshot([
    chained("A", 15, "Unassigned", ["B"]),
    chained("B", 0, "Ada", []),
    chained("C", 3, "Bo", []),
  ])
  const [chain] = chainRisks(snap)
  assertEquals(chain.owners.find((o) => o.person === "Unassigned")!.perCycle, 7.5)
})

Deno.test("chainRisks calls a chain stalled when an owner delivers nothing", () => {
  const snap = chainSnapshot([
    chained("A", 8, "Ada", ["B"]),
    chained("B", 8, "Idle", []),
  ], { people: { Ada: { velocity: 10 }, Idle: { velocity: 0 } } })
  const [chain] = chainRisks(snap)
  assertEquals(chain.stalled, true)
  assertEquals(chain.cyclesNeeded, null)
  assertEquals(chain.shortfall, null)
  assertEquals(chain.atRisk, true)
})

Deno.test("chainRisks reports no shortfall when the chain touches no milestone target", () => {
  const loose = (id: string, blocks: string[]) => ({ ...chained(id, 10, "Ada", blocks), milestone: null })
  const [chain] = chainRisks(chainSnapshot([loose("A", ["B"]), loose("B", [])]))
  assertEquals(chain.cyclesAvailable, null)
  assertEquals(chain.shortfall, null)
  assertEquals(chain.atRisk, false)
})

Deno.test("chainRisks counts what the chain spans, which is the part worth a badge", () => {
  const snap = chainSnapshot([
    { ...chained("A", 5, "Ada", ["B"]), milestone: "M1", cycle: 48 },
    { ...chained("B", 5, "Bo", []), milestone: "M2", cycle: 50 },
  ])
  const [chain] = chainRisks(snap)
  assertEquals(chain.spans, { milestones: 2, cycles: 2, assignees: 2 })
})

// The roster is an identity directory covering every engineer, so that people who join later already
// resolve for on-call and calendar. Planning against it would credit the forecast with capacity nobody
// spends on this project.
Deno.test("planningPeople reads ownership of live work, not the roster", () => {
  const snapshot = {
    capacity: { roster: { Ada: {}, Bo: {}, "Never Here": {} }, people: {} },
    issues: [
      { assignee: "Ada", statusType: "unstarted" },
      { assignee: "Bo", statusType: "completed" },
      { assignee: "Unassigned", statusType: "unstarted" },
      { assignee: "Departed", statusType: "unstarted", archived: true },
    ],
  }
  assertEquals(planningPeople(snapshot), ["Ada", "Bo"])
})

Deno.test("teamWeeklyThroughput ignores a rostered person who owns nothing here", () => {
  const base = {
    ...DATA,
    capacity: { roster: { A: {}, B: {} }, defaultVelocity: 20, people: {}, config: {} },
  }
  const onlyA = teamWeeklyThroughput({ ...base, issues: [{ assignee: "A", statusType: "unstarted" }] })
  const both = teamWeeklyThroughput({
    ...base,
    issues: [{ assignee: "A", statusType: "unstarted" }, { assignee: "B", statusType: "unstarted" }],
  })
  assertEquals(onlyA, 20)
  assertEquals(both, 40)
})
