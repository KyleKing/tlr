// Propose an assignee + cycle for every unscheduled, open issue, under a weekly per-person point
// ceiling, honoring on-call/OOO deflation, keeping a dependency chain with one owner, and steering
// work toward the person it fits best. Pure and deterministic: no network, no Linear. The output is a
// set of tlr ops (set_assignee, set_cycle) plus a plan the caller can review before writing.
//
// It is greedy, not optimal. Issues are ordered blockers-first, then by priority, milestone target,
// and size; each is placed with its best-fit owner in the earliest cycle that still has room. Work
// that does not fit inside the horizon is returned assigned but unscheduled, so a later cycle can pick
// it up without losing the owner decision.

import { CAPACITY_DEFAULTS } from "../../web/lib/planning.js"
import type { Issue, Snapshot } from "@/seed.ts"
import type { Op } from "@/ops.ts"

export type Affinity = { person: string; keywords: string[] }

export type BalanceOptions = {
  weeklyPerPerson?: number
  start?: number
  end?: number
  people?: string[]
  affinities?: Affinity[]
  // How many cycles before its milestone target a ticket may be pulled forward. Caps front-loading so
  // late-milestone work does not cram into near cycles just because capacity exists. A blocker still
  // leads what it blocks regardless. Omit for no cap (schedule anything that fits).
  maxLeadCycles?: number
}

export type Assignment = {
  id: string
  title: string
  person: string
  cycle: number | null
  estimate: number
  milestone: string | null
  priority: string
  reason: string
}

const OPEN: Issue["statusType"][] = ["backlog", "unstarted"]
const ALIVE = (i: Issue) => i.statusType !== "completed" && i.statusType !== "canceled"

// Default steer: Marissa leans browser automation, synthetics, and post-deploy monitoring; Kyle leans
// the watch-doggo AI agent, uptime math, performance, and orchestration/infra. Keywords match against
// a lowercased title + labels haystack. Continuity and load balance can override a weak signal.
const DEFAULT_AFFINITIES: Affinity[] = [
  {
    person: "Marissa TK",
    keywords: [
      "synthetic", "browser", "chromium", "browserbase", "smoke", "post-deploy", "playbook",
      "probe", "vendor", "member-access", "radar", "fixture", "drift", "status page",
    ],
  },
  {
    person: "Kyle King",
    keywords: [
      "watch-doggo", "watchdoggo", "code review", "code-gen", "uptime", "month-end", "error budget",
      "error-budget", "slo", "dagster", "hatchet", "n+1", "index", "postgres", "performance",
      "pulumi", "kill-switch", "outbox", "resilience", "bedrock",
    ],
  },
]

function haystack(i: Issue): string {
  return `${i.title} ${(i.labels ?? []).join(" ")}`.toLowerCase()
}

function affinityScore(i: Issue, affinities: Affinity[]): Record<string, number> {
  const h = haystack(i)
  const out: Record<string, number> = {}
  for (const a of affinities) {
    out[a.person] = a.keywords.reduce((n, k) => n + (h.includes(k) ? 1 : 0), 0)
  }
  return out
}

// Per-person capacity for one cycle: the weekly ceiling deflated by out-days (pro rata over the work
// week) and by an on-call week (a flat penalty), matching planning.js so a hand run and the board
// agree.
function cycleCapacity(person: string, cycle: number, snapshot: Snapshot, weekly: number): number {
  const cfg = { ...CAPACITY_DEFAULTS, ...(snapshot.capacity?.config) }
  const ev = snapshot.capacity?.people?.[person]?.cycles?.[String(cycle)] ?? {}
  let points = weekly
  if (ev.outDays && ev.outDays > 0) {
    points *= Math.max(0, (cfg.workdaysPerCycle - ev.outDays) / cfg.workdaysPerCycle)
  }
  if (ev.oncall) points *= 1 - cfg.oncallPenalty
  return Math.round(points)
}

// Depth in the blocking graph: a blocker gets a lower depth than what it blocks, so blockers are
// placed first and never after the work that waits on them.
function blockingDepth(issues: Issue[]): Record<string, number> {
  const byId = Object.fromEntries(issues.map((i) => [i.id, i]))
  const depth: Record<string, number> = {}
  const visiting = new Set<string>()
  function walk(id: string): number {
    if (depth[id] !== undefined) return depth[id]
    if (visiting.has(id)) return 0
    visiting.add(id)
    const i = byId[id]
    const blockers = i?.blockedBy ?? []
    const d = blockers.length ? 1 + Math.max(...blockers.map(walk)) : 0
    visiting.delete(id)
    return (depth[id] = d)
  }
  for (const i of issues) walk(i.id)
  return depth
}

const MILESTONE_TARGET = (snapshot: Snapshot, key: string | null): string => {
  const m = snapshot.milestones.find((x) => x.key === key)
  return m?.target ?? "9999-12-31"
}

// Cycle number whose week contains a date; extrapolated weekly past the last known cycle so a target
// months out still maps to a number.
function cycleForDate(snapshot: Snapshot, iso: string): number {
  const cycles = snapshot.cycles
  for (const c of cycles) {
    if (iso >= c.start && iso < c.end) return c.n
  }
  const last = cycles[cycles.length - 1]
  if (iso < cycles[0].start) return cycles[0].n
  const weeks = Math.floor((new Date(iso).getTime() - new Date(last.end).getTime()) / (7 * 24 * 3600 * 1000))
  return last.n + 1 + Math.max(0, weeks)
}

export function balance(snapshot: Snapshot, options: BalanceOptions = {}): {
  options: Required<Pick<BalanceOptions, "weeklyPerPerson" | "start" | "end">> & { people: string[] }
  capacity: { person: string; cycle: number; capacity: number; committed: number; free: number }[]
  assignments: Assignment[]
  unscheduled: Assignment[]
  atRisk: { id: string; title: string; milestone: string | null; reason: string }[]
  perCycle: { cycle: number; end: string; byPerson: Record<string, number> }[]
  ops: Op[]
} {
  const weekly = options.weeklyPerPerson ?? snapshot.capacity?.defaultVelocity ?? 20
  const start = options.start ?? snapshot.currentCycle + 1
  const end = options.end ?? start + 7
  const people = options.people ??
    (snapshot.capacity?.roster ? Object.keys(snapshot.capacity.roster) : [])
  const affinities = (options.affinities ?? DEFAULT_AFFINITIES).filter((a) => people.includes(a.person))
  const cycles: number[] = []
  for (let n = start; n <= end; n++) cycles.push(n)
  const cycleEnd = Object.fromEntries(snapshot.cycles.map((c) => [c.n, c.end]))

  // Remaining capacity grid, seeded then drained by work already committed to a cycle in the window.
  const free: Record<string, Record<number, number>> = {}
  const cap: Record<string, Record<number, number>> = {}
  for (const p of people) {
    free[p] = {}
    cap[p] = {}
    for (const n of cycles) {
      const c = cycleCapacity(p, n, snapshot, weekly)
      cap[p][n] = c
      free[p][n] = c
    }
  }
  for (const i of snapshot.issues) {
    if (i.cycle && cycles.includes(i.cycle) && ALIVE(i) && free[i.assignee]?.[i.cycle] !== undefined) {
      free[i.assignee][i.cycle] -= i.estimate || 0
    }
  }
  const committed: Record<string, Record<number, number>> = {}
  for (const p of people) {
    committed[p] = {}
    for (const n of cycles) committed[p][n] = cap[p][n] - free[p][n]
  }

  // Who already owns committed work in each milestone (seeded once, not grown during the run, so a
  // single pick can't snowball into owning the whole milestone). A live dependency chain still stays
  // together through the neighbor check in `pick`, which reads the assignee as it is decided.
  const owned: Record<string, Set<string>> = Object.fromEntries(people.map((p) => [p, new Set<string>()]))
  for (const i of snapshot.issues) {
    if (i.milestone && owned[i.assignee]) owned[i.assignee].add(i.milestone)
  }
  const byId = Object.fromEntries(snapshot.issues.map((i) => [i.id, i]))

  const depth = blockingDepth(snapshot.issues)
  const candidates = snapshot.issues
    .filter((i) => OPEN.includes(i.statusType) && i.cycle == null)
    .sort((a, b) => {
      if (depth[a.id] !== depth[b.id]) return depth[a.id] - depth[b.id]
      const pa = a.priorityValue || 99, pb = b.priorityValue || 99
      if (pa !== pb) return pa - pb
      const ta = MILESTONE_TARGET(snapshot, a.milestone), tb = MILESTONE_TARGET(snapshot, b.milestone)
      if (ta !== tb) return ta.localeCompare(tb)
      if ((b.estimate || 0) !== (a.estimate || 0)) return (b.estimate || 0) - (a.estimate || 0)
      return a.id.localeCompare(b.id)
    })

  const assignments: Assignment[] = []
  const unscheduled: Assignment[] = []
  const atRisk: { id: string; title: string; milestone: string | null; reason: string }[] = []
  const ops: Op[] = []
  const scheduledCycle: Record<string, number> = {}
  const assignedTotal: Record<string, number> = Object.fromEntries(people.map((p) => [p, 0]))

  // Balance-first: work flows to the lighter person unless affinity or an owned chain pulls it. The
  // balance term is in weeks-of-work, so a one-keyword lean (1.0) is worth ~one week of imbalance and
  // an owned chain (1.5) a bit more; neither lets one person run far ahead of the other.
  const AFFINITY_W = 1.0, CONTINUITY_W = 1.5, BALANCE_W = 1.0
  const pick = (issue: Issue, est: number): string => {
    const score = affinityScore(issue, affinities)
    const owns = (p: string) => owned[p].has(issue.milestone ?? "") ||
      [...(issue.blockedBy ?? []), ...(issue.blocks ?? []), ...(issue.related ?? [])]
        .some((n) => byId[n]?.assignee === p)
    const value = (p: string) =>
      AFFINITY_W * score[p] + CONTINUITY_W * (owns(p) ? 1 : 0) - BALANCE_W * (assignedTotal[p] / weekly)
    return [...people].sort((a, b) => value(b) - value(a) || assignedTotal[a] - assignedTotal[b] || a.localeCompare(b))[0]
  }

  for (const issue of candidates) {
    const est = issue.estimate || 0
    const score = affinityScore(issue, affinities)
    const person = pick(issue, est)

    const leadFloor = options.maxLeadCycles !== undefined
      ? cycleForDate(snapshot, MILESTONE_TARGET(snapshot, issue.milestone)) - options.maxLeadCycles
      : start
    const earliest = Math.max(
      start,
      leadFloor,
      ...(issue.blockedBy ?? []).map((b) => scheduledCycle[b] ?? start),
    )
    let placed: number | null = null
    for (const n of cycles) {
      if (n < earliest) continue
      if (free[person][n] >= est && est > 0) {
        placed = n
        break
      }
    }
    // Nothing fits whole: drop into the earliest in-window cycle with the most room (partial overflow).
    if (placed == null && est > 0) {
      const roomy = cycles.filter((n) => n >= earliest).sort((a, b) => free[person][b] - free[person][a])
      if (roomy.length && free[person][roomy[0]] > 0) placed = roomy[0]
    }

    const target = MILESTONE_TARGET(snapshot, issue.milestone)
    const row: Assignment = {
      id: issue.id,
      title: issue.title,
      person,
      cycle: placed,
      estimate: est,
      milestone: issue.milestone,
      priority: issue.priority ?? "No priority",
      reason: score[person] > 0 ? "affinity" : owned[person].has(issue.milestone ?? "") ? "continuity" : "balance",
    }
    ops.push({ kind: "set_assignee", id: issue.id, assignee: person })
    if (placed != null) {
      free[person][placed] -= est
      scheduledCycle[issue.id] = placed
      assignedTotal[person] += est
      assignments.push(row)
      ops.push({ kind: "set_cycle", id: issue.id, cycle: placed })
      if (cycleEnd[placed] && cycleEnd[placed] > target) {
        atRisk.push({ id: issue.id, title: issue.title, milestone: issue.milestone, reason: `cycle ${placed} ends ${cycleEnd[placed]}, after milestone target ${target}` })
      }
    } else {
      row.reason = est === 0
        ? "no estimate"
        : earliest > end
        ? `milestone too far out; schedule near cycle ${leadFloor}`
        : "beyond horizon capacity"
      unscheduled.push(row)
      if (target <= (cycleEnd[end] ?? "9999-12-31")) {
        atRisk.push({ id: issue.id, title: issue.title, milestone: issue.milestone, reason: `unscheduled but milestone target ${target} is inside the horizon` })
      }
    }
    if (byId[issue.id]) byId[issue.id].assignee = person
  }

  const capacityRows = people.flatMap((p) =>
    cycles.map((n) => ({ person: p, cycle: n, capacity: cap[p][n], committed: committed[p][n], free: free[p][n] }))
  )
  const perCycle = cycles.map((n) => ({
    cycle: n,
    end: cycleEnd[n] ?? "",
    byPerson: Object.fromEntries(people.map((p) => [p, cap[p][n] - free[p][n]])),
  }))

  return {
    options: { weeklyPerPerson: weekly, start, end, people },
    capacity: capacityRows,
    assignments,
    unscheduled,
    atRisk,
    perCycle,
    ops,
  }
}
