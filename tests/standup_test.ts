import { assertEquals } from "@std/assert"
import { standup } from "@/commands/standup.ts"
import { cyclePathFromHistory } from "../web/lib/issues.js"
import type { Issue, Snapshot } from "@/seed.ts"

function issue(over: Partial<Issue> & { id: string }): Issue {
  return {
    title: over.id,
    url: `https://linear.app/x/issue/${over.id}`,
    estimate: 0,
    assignee: "Ada",
    status: "Todo",
    statusType: "unstarted",
    priority: null,
    priorityValue: null,
    labels: [],
    parentId: null,
    milestone: null,
    cycle: null,
    description: "",
    blocks: [],
    blockedBy: [],
    related: [],
    ...over,
  } as Issue
}

function snapshot(issues: Issue[], currentCycle = 52): Snapshot {
  return {
    project: { name: "P", start: "2026-07-01", target: "2026-11-30", url: "https://linear.app/x/project/p" },
    cycles: [],
    asOf: "2026-08-21",
    currentCycle,
    teamCapacityPerCycle: 0,
    teamVelocity: 0,
    milestones: [],
    issues,
    capacity: { config: { workdaysPerCycle: 5, oncallPenalty: 0.5 }, defaultVelocity: 0, roster: {}, people: {} },
  } as unknown as Snapshot
}

Deno.test("cyclePathFromHistory records each cycle a ticket landed in, oldest first", () => {
  const nodes = [
    { createdAt: "2026-08-14T00:00:00Z", fromCycle: { number: 51 }, toCycle: { number: 52 } },
    { createdAt: "2026-08-04T00:00:00Z", fromCycle: null, toCycle: { number: 51 } },
    { createdAt: "2026-08-17T00:00:00Z", fromCycle: { number: 52 }, toCycle: { number: 53 } },
  ]
  assertEquals(cyclePathFromHistory(nodes), [51, 52, 53])
})

Deno.test("a move out to no cycle and back does not double-count as two hops", () => {
  const nodes = [
    { createdAt: "2026-08-01T00:00:00Z", fromCycle: null, toCycle: { number: 50 } },
    { createdAt: "2026-08-05T00:00:00Z", fromCycle: { number: 50 }, toCycle: null },
    { createdAt: "2026-08-10T00:00:00Z", fromCycle: null, toCycle: { number: 50 } },
    { createdAt: "2026-08-17T00:00:00Z", fromCycle: { number: 50 }, toCycle: { number: 52 } },
  ]
  assertEquals(cyclePathFromHistory(nodes), [50, 52])
})

Deno.test("an absent history is unknown rather than zero hops", () => {
  assertEquals(cyclePathFromHistory(undefined), undefined)
  const s = standup(snapshot([issue({ id: "A-1", cycle: 52, estimate: 3 })]))
  assertEquals(s.hopDataMissing, 1)
  assertEquals(s.hops.distribution, [])
})

Deno.test("headline separates closed work from scope carried in from an earlier cycle", () => {
  const s = standup(snapshot([
    issue({ id: "A-1", cycle: 52, estimate: 5, statusType: "completed", status: "Merged" }),
    issue({ id: "A-2", cycle: 52, estimate: 3, cyclePath: [50, 51, 52] }),
    issue({ id: "A-3", cycle: 52, estimate: 2, cyclePath: [52] }),
    issue({ id: "A-4", cycle: 52, estimate: 4, statusType: "canceled", status: "Canceled" }),
  ]))
  assertEquals(s.headline.committed, { issues: 4, points: 14 })
  assertEquals(s.headline.closed, { points: 9, share: 64 })
  assertEquals(s.headline.open, { issues: 2, points: 5 })
  // Only A-2 arrived from an earlier cycle. A-3 was opened into 52.
  assertEquals(s.headline.carriedIn, { issues: 1, points: 3 })
})

Deno.test("next-cycle load counts both what is already committed and what would roll over", () => {
  const s = standup(snapshot([
    // Ada closed 8 pts in each of 48-51, so her average is 8.
    ...[48, 49, 50, 51].map((c) =>
      issue({ id: `H-${c}`, cycle: c, estimate: 8, statusType: "completed", status: "Merged" })
    ),
    issue({ id: "A-1", cycle: 52, estimate: 6 }),
    issue({ id: "A-2", cycle: 53, estimate: 10 }),
  ]))
  const ada = s.people.find((p) => p.person === "Ada")!
  assertEquals(ada.capacity, 8)
  assertEquals(ada.rollover, 6)
  assertEquals(ada.next, 10)
  assertEquals(ada.total, 16)
  assertEquals(ada.over, 8)
  // 8 pts of capacity against a 75% execution target supports committing 11.
  assertEquals(s.totals.ceiling, 11)
  assertEquals(s.totals.cut, 5)
})

Deno.test("someone out next cycle gets no capacity but keeps their load visible", () => {
  const issues = [
    ...[48, 49, 50, 51].map((c) =>
      issue({ id: `H-${c}`, cycle: c, estimate: 4, assignee: "Grace", statusType: "completed", status: "Merged" })
    ),
    issue({ id: "A-1", cycle: 53, estimate: 9, assignee: "Grace" }),
  ]
  const present = standup(snapshot(issues)).people[0]
  assertEquals(present.capacity, 4)
  assertEquals(present.ooo, false)
  assertEquals(present.over, 5)

  const away = standup(snapshot(issues), { out: ["Grace"] }).people[0]
  assertEquals(away.capacity, 0)
  assertEquals(away.ooo, true)
  // The work does not vanish because the owner is out, so it still shows as 9 pts needing a new home.
  assertEquals(away.total, 9)
  assertEquals(away.over, 9)
})

Deno.test("chronic tickets are the ones past four hops, and unfiled work groups on its own", () => {
  const s = standup(snapshot([
    issue({ id: "A-1", cycle: 52, estimate: 4, cyclePath: [43, 44, 45, 46, 47, 48] }),
    issue({ id: "A-2", cycle: 52, estimate: 1, cyclePath: [51, 52], milestone: "m1" }),
    issue({ id: "A-3", cycle: 53, estimate: 8, cyclePath: [49, 50, 51, 52, 53] }),
  ]))
  assertEquals(s.hops.chronic, { issues: 2, points: 12 })
  assertEquals(s.hops.offenders[0].id, "A-1")
  assertEquals(s.hops.offenders[0].hops, 5)
  assertEquals(s.hops.offenders[0].path, [43, 44, 45, 46, 47, 48])
  const unfiled = s.groups.find((g) => g.name === "— unfiled —")!
  assertEquals(unfiled.open, 4)
  assertEquals(unfiled.next, 8)
  assertEquals(unfiled.carry, 12)
  assertEquals(unfiled.worstHop, 5)
})
