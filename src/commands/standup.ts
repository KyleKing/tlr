// The weekly standup roll-up: what the current cycle committed against what it closed, which
// milestones drag the most work into the next cycle, which tickets have been copied between cycles
// enough times to stop counting as planned work, and whether the next cycle's commitment fits the
// team's demonstrated throughput.
//
// Two conventions the numbers depend on. Capacity is per-person completed points averaged over the
// preceding cycles rather than a configured ceiling, because a ceiling nobody has ever hit is not a
// forecast. And an unestimated ticket contributes 0 points while still counting as an issue, so
// every points column is a floor and `unestimated` says how far off it can be.

import { liveIssues } from "../../web/lib/issues.js"
import type { Issue, Snapshot } from "@/seed.ts"

const NO_MILESTONE = "— unfiled —"

export type StandupOptions = {
  // The cycle under review. Defaults to the snapshot's current cycle.
  cycle?: number
  // How many cycles of history to average throughput over.
  lookback?: number
  // Assignees with no capacity next cycle (time off). Matched against Issue.assignee exactly.
  out?: string[]
  // The share of committed points the team intends to actually finish.
  target?: number
}

export type HopRow = {
  id: string
  title: string
  assignee: string
  status: string | null
  estimate: number
  cycle: number | null
  group: string
  hops: number
  path: number[]
}

// Undefined rather than 0 when the capture predates cyclePath, so an old snapshot cannot quietly
// report a fleet of well-behaved tickets.
export function hopsOf(issue: Issue): number | undefined {
  if (!issue.cyclePath) return undefined
  return Math.max(0, issue.cyclePath.length - 1)
}

function points(issues: Issue[]): number {
  return issues.reduce((acc, i) => acc + (i.estimate || 0), 0)
}

function isClosed(issue: Issue): boolean {
  return issue.statusType === "completed" || issue.statusType === "canceled"
}

// A snapshot holds one project, so milestone is the coarsest grouping available. Unfiled work is
// called out on its own because a ticket in a cycle with no milestone is scope nobody is tracking.
function groupOf(issue: Issue): string {
  return issue.milestone ?? NO_MILESTONE
}

export function standup(snapshot: Snapshot, options: StandupOptions = {}) {
  const cycle = options.cycle ?? snapshot.currentCycle
  const next = cycle + 1
  const lookback = options.lookback ?? 4
  const out = new Set(options.out ?? [])
  const target = options.target ?? 0.75

  const issues = liveIssues(snapshot.issues) as Issue[]
  const inCycle = issues.filter((i) => i.cycle === cycle)
  const open = inCycle.filter((i) => !isClosed(i))
  const closed = inCycle.filter(isClosed)
  const committedNext = issues.filter((i) => i.cycle === next && !isClosed(i))

  const carriedIn = open.filter((i) => (hopsOf(i) ?? 0) > 0)
  const headline = {
    cycle,
    committed: { issues: inCycle.length, points: points(inCycle) },
    closed: { points: points(closed), share: pct(points(closed), points(inCycle)) },
    open: { issues: open.length, points: points(open) },
    carriedIn: { issues: carriedIn.length, points: points(carriedIn) },
    nextCommitted: { issues: committedNext.length, points: points(committedNext) },
    nextIfAllRolls: points(open) + points(committedNext),
    unestimated: open.filter((i) => !i.estimate).length,
  }

  // Per-person throughput over the preceding `lookback` cycles. A person who closed nothing in the
  // window gets 0, which is the honest read: nothing in the data supports giving them a budget.
  const window = range(cycle - lookback, cycle - 1)
  const velocity = new Map<string, number>()
  for (const person of assignees(issues)) {
    const done = issues.filter((i) =>
      i.assignee === person && isClosed(i) && i.cycle != null && window.includes(i.cycle)
    )
    velocity.set(person, round1(points(done) / lookback))
  }

  const load = new Map<string, { next: number; rollover: number }>()
  for (const i of committedNext) bump(load, i.assignee, "next", i.estimate || 0)
  for (const i of open) bump(load, i.assignee, "rollover", i.estimate || 0)

  const people = [...load.keys()].sort().map((person) => {
    const capacity = out.has(person) ? 0 : velocity.get(person) ?? 0
    const l = load.get(person)!
    const total = l.next + l.rollover
    return {
      person,
      capacity,
      ooo: out.has(person),
      next: l.next,
      rollover: l.rollover,
      total,
      over: round1(total - capacity),
    }
  }).sort((a, b) => b.total - a.total)

  const capacityTotal = round1(people.reduce((acc, p) => acc + p.capacity, 0))
  const loadTotal = people.reduce((acc, p) => acc + p.total, 0)
  // The ceiling that satisfies the execution target: commit capacity/target, not capacity, because
  // finishing 75% of a smaller number is the goal rather than finishing everything.
  const ceiling = capacityTotal > 0 ? Math.round(capacityTotal / target) : 0

  const byGroup = new Map<
    string,
    { done: number; open: number; openIssues: number; next: number; nextIssues: number; worstHop: number }
  >()
  for (const i of inCycle) {
    const row = ensureGroup(byGroup, groupOf(i))
    if (isClosed(i)) row.done += i.estimate || 0
    else {
      row.open += i.estimate || 0
      row.openIssues++
      row.worstHop = Math.max(row.worstHop, hopsOf(i) ?? 0)
    }
  }
  for (const i of committedNext) {
    const row = ensureGroup(byGroup, groupOf(i))
    row.next += i.estimate || 0
    row.nextIssues++
  }
  const groups = [...byGroup.entries()].map(([name, r]) => ({ name, ...r, carry: r.open + r.next }))
    .sort((a, b) => b.carry - a.carry)

  const openAndNext = [...open, ...committedNext]
  const hopRows: HopRow[] = openAndNext
    .filter((i) => (hopsOf(i) ?? 0) >= 1)
    .map((i) => ({
      id: i.id,
      title: i.title,
      assignee: i.assignee,
      status: i.status,
      estimate: i.estimate || 0,
      cycle: i.cycle,
      group: groupOf(i),
      hops: hopsOf(i)!,
      path: i.cyclePath ?? [],
    }))
    .sort((a, b) => b.hops - a.hops || b.estimate - a.estimate)

  const distribution = new Map<number, { issues: number; points: number }>()
  for (const i of openAndNext) {
    const h = hopsOf(i)
    if (h === undefined) continue
    const row = distribution.get(h) ?? { issues: 0, points: 0 }
    row.issues++
    row.points += i.estimate || 0
    distribution.set(h, row)
  }

  // Tickets past the hop threshold are the ones to close, date, or write a blocker on. Four is the
  // point where a ticket has been nominally in scope for a month without landing.
  const chronic = hopRows.filter((r) => r.hops >= 4)

  return {
    headline,
    groups,
    people,
    totals: {
      capacity: capacityTotal,
      load: loadTotal,
      ceiling,
      cut: Math.max(0, loadTotal - ceiling),
      ratio: capacityTotal ? round1(loadTotal / capacityTotal) : null,
    },
    hops: {
      distribution: [...distribution.entries()].sort((a, b) => a[0] - b[0]).map(([hops, r]) => ({ hops, ...r })),
      offenders: hopRows.slice(0, 20),
      chronic: { issues: chronic.length, points: chronic.reduce((acc, r) => acc + r.estimate, 0) },
    },
    // Snapshots without cyclePath cannot answer any hop question, so say so rather than reporting zeros.
    hopDataMissing: openAndNext.filter((i) => hopsOf(i) === undefined).length,
  }
}

function ensureGroup(
  m: Map<
    string,
    { done: number; open: number; openIssues: number; next: number; nextIssues: number; worstHop: number }
  >,
  name: string,
) {
  let row = m.get(name)
  if (!row) {
    row = { done: 0, open: 0, openIssues: 0, next: 0, nextIssues: 0, worstHop: 0 }
    m.set(name, row)
  }
  return row
}

function bump(m: Map<string, { next: number; rollover: number }>, person: string, key: "next" | "rollover", n: number) {
  const row = m.get(person) ?? { next: 0, rollover: 0 }
  row[key] += n
  m.set(person, row)
}

function assignees(issues: Issue[]): string[] {
  return [...new Set(issues.map((i) => i.assignee))].filter((p) => p !== "Unassigned")
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k)
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((100 * part) / whole) : 0
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
