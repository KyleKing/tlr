import { assertEquals } from "jsr:@std/assert@1"
import { balance } from "../src/commands/balance.ts"
import type { Issue, Snapshot } from "../src/seed.ts"

function issue(over: Partial<Issue> & { id: string }): Issue {
  return {
    id: over.id,
    title: over.title ?? over.id,
    url: "",
    estimate: over.estimate ?? 0,
    assignee: over.assignee ?? "Unassigned",
    status: "Backlog",
    statusType: over.statusType ?? "backlog",
    priority: over.priority ?? "Medium",
    priorityValue: over.priorityValue ?? 3,
    labels: over.labels ?? [],
    parentId: null,
    milestone: over.milestone ?? "M1",
    cycle: over.cycle ?? null,
    description: "",
    blocks: over.blocks ?? [],
    blockedBy: over.blockedBy ?? [],
    related: over.related ?? [],
  }
}

function snapshot(
  issues: Issue[],
  people?: Record<string, { velocity?: number; cycles?: Record<string, unknown> }>,
  milestones?: { key: string; name: string; target: string; progress: number }[],
): Snapshot {
  const cycles = []
  for (let n = 48; n <= 60; n++) {
    const start = new Date(Date.UTC(2026, 6, 20) + (n - 48) * 7 * 86400000).toISOString().slice(0, 10)
    const end = new Date(Date.UTC(2026, 6, 27) + (n - 48) * 7 * 86400000).toISOString().slice(0, 10)
    cycles.push({ n, start, end })
  }
  return {
    project: { name: "T", start: "2026-07-01", target: "2026-11-30", url: "" },
    cycles,
    asOf: "2026-07-24",
    currentCycle: 48,
    teamCapacityPerCycle: 40,
    teamVelocity: 40,
    milestones: milestones ?? [
      { key: "M1", name: "M1", target: "2026-08-31", progress: 0 },
      { key: "M2", name: "M2", target: "2026-11-30", progress: 0 },
    ],
    issues,
    capacity: {
      config: { workdaysPerCycle: 5, oncallPenalty: 0.45 },
      defaultVelocity: 10,
      roster: { "Kyle King": { email: "k@x" }, "Marissa TK": { email: "m@x" } },
      // deno-lint-ignore no-explicit-any
      people: (people ?? {}) as any,
    },
  }
}

Deno.test("balance schedules every open, unscheduled issue that fits the horizon", () => {
  const issues = [
    issue({ id: "T-1", estimate: 3, milestone: "M1" }),
    issue({ id: "T-2", estimate: 5, milestone: "M1" }),
    issue({ id: "T-3", estimate: 2, statusType: "started", cycle: 49, assignee: "Kyle King" }), // already scheduled, skipped
  ]
  const r = balance(snapshot(issues), { weeklyPerPerson: 10, start: 49, end: 52 })
  const ids = r.assignments.map((a) => a.id).sort()
  assertEquals(ids, ["T-1", "T-2"])
  assertEquals(r.unscheduled.length, 0)
})

Deno.test("no cycle exceeds a person's deflated capacity for a whole-fit placement", () => {
  const issues = Array.from({ length: 8 }, (_, i) => issue({ id: `T-${i}`, estimate: 5, milestone: "M1" }))
  const r = balance(snapshot(issues), { weeklyPerPerson: 10, start: 49, end: 52 })
  for (const row of r.capacity) assertEquals(row.free >= 0, true, `${row.person} C${row.cycle} free ${row.free}`)
})

Deno.test("out-days deflate a person's capacity for that cycle", () => {
  const issues = [issue({ id: "T-1", estimate: 10, milestone: "M1" })]
  const r = balance(snapshot(issues, { "Kyle King": { cycles: { "49": { outDays: 2, reason: "PTO" } } } }), {
    weeklyPerPerson: 10,
    start: 49,
    end: 49,
  })
  const kyle49 = r.capacity.find((c) => c.person === "Kyle King" && c.cycle === 49)!
  assertEquals(kyle49.capacity, 6) // 10 * (5-2)/5
})

Deno.test("a blocker is never scheduled after the work it blocks", () => {
  const issues = [
    issue({ id: "T-blocked", estimate: 8, blockedBy: ["T-blocker"], priorityValue: 1 }),
    issue({ id: "T-blocker", estimate: 8, blocks: ["T-blocked"], priorityValue: 3 }),
  ]
  const r = balance(snapshot(issues), { weeklyPerPerson: 10, start: 49, end: 55 })
  const at = Object.fromEntries(r.assignments.map((a) => [a.id, a.cycle]))
  assertEquals((at["T-blocker"] ?? 0) <= (at["T-blocked"] ?? 0), true)
})

Deno.test("the lead cap leaves far-milestone work unscheduled", () => {
  const issues = [
    issue({ id: "T-near", estimate: 3, milestone: "M1" }), // target 2026-08-31
    issue({ id: "T-far", estimate: 3, milestone: "M2" }), // target 2026-11-30
  ]
  const r = balance(snapshot(issues), { weeklyPerPerson: 10, start: 49, end: 52, maxLeadCycles: 4 })
  assertEquals(r.assignments.map((a) => a.id), ["T-near"])
  assertEquals(r.unscheduled.map((a) => a.id), ["T-far"])
})

Deno.test("load stays balanced between two people on affinity-neutral work", () => {
  const issues = Array.from({ length: 6 }, (_, i) => issue({ id: `T-${i}`, estimate: 4, milestone: "M1" }))
  const r = balance(snapshot(issues), { weeklyPerPerson: 12, start: 49, end: 54 })
  const load: Record<string, number> = {}
  for (const a of r.assignments) load[a.person] = (load[a.person] ?? 0) + a.estimate
  const vals = Object.values(load)
  assertEquals(Math.abs(vals[0] - vals[1]) <= 4, true, `loads ${JSON.stringify(load)}`)
})

Deno.test("cycles the team does not run are dropped and warned, nothing scheduled", () => {
  const r = balance(snapshot([issue({ id: "T-1", estimate: 3 })]), { weeklyPerPerson: 10, start: 61, end: 62 })
  assertEquals(r.assignments.length, 0)
  assertEquals(r.warnings.some((w) => w.includes("do not exist")), true)
  assertEquals(r.warnings.some((w) => w.includes("no runnable cycles")), true)
})

// An owner the plan does model, but who has no roster entry, gets the default ceiling rather than a
// measured one, since velocity, on-call, and out-days all hang off the roster.
Deno.test("an owner missing from the roster raises a warning about their capacity", () => {
  const issues = [issue({ id: "T-1", estimate: 3, statusType: "started", cycle: 50, assignee: "Stranger" })]
  const r = balance(snapshot(issues), { weeklyPerPerson: 10, start: 49, end: 52 })
  assertEquals(r.warnings.some((w) => w.includes("off-roster") && w.includes("Stranger")), true)
})

// An owner left out of `people` entirely is worse: their committed work never lands in the grid, so
// every cycle they occupy looks emptier than it is.
Deno.test("committed work owned by someone outside the plan raises a warning", () => {
  const issues = [issue({ id: "T-1", estimate: 3, statusType: "started", cycle: 50, assignee: "Stranger" })]
  const r = balance(snapshot(issues), { weeklyPerPerson: 10, start: 49, end: 52, people: ["Kyle King"] })
  assertEquals(r.warnings.some((w) => w.includes("capacity not modeled") && w.includes("Stranger")), true)
})

// Balance exists to assign unowned work, so a project where nothing is assigned has no owners to learn
// from. It falls back to the roster and says so rather than proposing nothing.
Deno.test("a project with no owners yet falls back to the roster and warns", () => {
  const r = balance(snapshot([issue({ id: "T-1", estimate: 3 })]), { weeklyPerPerson: 10, start: 49, end: 52 })
  assertEquals(r.options.people, ["Kyle King", "Marissa TK"])
  assertEquals(r.warnings.some((w) => w.includes("nobody owns work in this project yet")), true)
})

// Once people own work here, they are the plan, not the whole roster.
Deno.test("balance spreads across the people who own work, not the roster", () => {
  const issues = [
    issue({ id: "T-1", estimate: 3, statusType: "started", cycle: 49, assignee: "Marissa TK" }),
    issue({ id: "T-2", estimate: 3 }),
  ]
  const r = balance(snapshot(issues), { weeklyPerPerson: 10, start: 49, end: 52 })
  assertEquals(r.options.people, ["Marissa TK"])
})

Deno.test("unestimated in-scope work is left unscheduled with a warning", () => {
  const r = balance(snapshot([issue({ id: "T-1", estimate: 0, milestone: "M1" })]), {
    weeklyPerPerson: 10,
    start: 49,
    end: 52,
  })
  assertEquals(r.assignments.length, 0)
  assertEquals(r.unscheduled.map((a) => a.id), ["T-1"])
  assertEquals(r.warnings.some((w) => w.includes("no estimate")), true)
})

Deno.test("a milestone whose work lands after its target is flagged at-risk", () => {
  const ms = [{ key: "M1", name: "M1", target: "2026-07-20", progress: 0 }] // before the horizon start
  const r = balance(snapshot([issue({ id: "T-1", estimate: 3, milestone: "M1" })], undefined, ms), {
    weeklyPerPerson: 10,
    start: 49,
    end: 52,
  })
  const m1 = r.milestoneRisk.find((m) => m.key === "M1")!
  assertEquals(m1.verdict, "at-risk")
})

Deno.test("a far-target milestone with unplaced work is deferred, not at-risk", () => {
  const r = balance(snapshot([issue({ id: "T-1", estimate: 3, milestone: "M2" })]), {
    weeklyPerPerson: 10,
    start: 49,
    end: 52,
    maxLeadCycles: 2, // M2 target 2026-11-30 is far out, so it can't be pulled into this window
  })
  const m2 = r.milestoneRisk.find((m) => m.key === "M2")!
  assertEquals(m2.verdict, "deferred")
  assertEquals(m2.unscheduledPoints, 3)
})

Deno.test("a milestone whose work all lands by target is on-track", () => {
  const ms = [{ key: "M1", name: "M1", target: "2026-12-31", progress: 0 }] // comfortably after the window
  const r = balance(snapshot([issue({ id: "T-1", estimate: 3, milestone: "M1" })], undefined, ms), {
    weeklyPerPerson: 10,
    start: 49,
    end: 52,
  })
  const m1 = r.milestoneRisk.find((m) => m.key === "M1")!
  assertEquals(m1.verdict, "on-track")
  assertEquals(m1.unscheduledPoints, 0)
})

Deno.test("an in-scope issue scheduled past its milestone target lands in atRisk", () => {
  const ms = [{ key: "M1", name: "M1", target: "2026-07-20", progress: 0 }]
  const r = balance(snapshot([issue({ id: "T-1", estimate: 3, milestone: "M1" })], undefined, ms), {
    weeklyPerPerson: 10,
    start: 49,
    end: 52,
  })
  assertEquals(r.atRisk.some((a) => a.id === "T-1"), true)
})

Deno.test("an on-call week deflates capacity by the penalty", () => {
  const r = balance(
    snapshot([issue({ id: "T-1", estimate: 1, milestone: "M1" })], {
      "Kyle King": { cycles: { "49": { oncall: true } } },
    }),
    { weeklyPerPerson: 10, start: 49, end: 49 },
  )
  const kyle = r.capacity.find((c) => c.person === "Kyle King" && c.cycle === 49)!
  assertEquals(kyle.capacity, 6) // round(10 * (1 - 0.45))
})

Deno.test("an oversized estimate is still placed, not silently dropped", () => {
  const r = balance(snapshot([issue({ id: "T-big", estimate: 40, milestone: "M1" })]), {
    weeklyPerPerson: 10,
    start: 49,
    end: 52,
  })
  assertEquals(r.assignments.map((a) => a.id), ["T-big"])
  assertEquals(r.unscheduled.length, 0)
})

Deno.test("the plan is deterministic across runs", () => {
  const build = () =>
    balance(
      snapshot(
        Array.from({ length: 10 }, (_, i) => issue({ id: `T-${i}`, estimate: 3, milestone: i % 2 ? "M1" : "M2" })),
      ),
      {
        weeklyPerPerson: 12,
        start: 49,
        end: 54,
      },
    )
  assertEquals(JSON.stringify(build()), JSON.stringify(build()))
})
