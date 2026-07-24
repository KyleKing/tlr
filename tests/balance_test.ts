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

function snapshot(issues: Issue[], people?: Record<string, { velocity?: number; cycles?: Record<string, unknown> }>): Snapshot {
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
    milestones: [
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
