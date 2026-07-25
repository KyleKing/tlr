// Propose an assignee + cycle for every unscheduled, open issue, under a weekly per-person point
// ceiling, honoring on-call/OOO deflation, keeping a dependency chain with one owner, and steering
// work toward the person it fits best. Pure and deterministic: no network, no Linear. The output is a
// set of tlr ops (set_assignee, set_cycle) plus a plan the caller can review before writing.
//
// It is greedy, not optimal. Issues are ordered blockers-first, then by priority, milestone target,
// and size; each is placed with its best-fit owner in the earliest cycle that still has room. Work
// that does not fit inside the horizon is returned assigned but unscheduled, so a later cycle can pick
// it up without losing the owner decision.

import { liveSnapshot } from "../../web/lib/issues.js"
import { personCycleCapacity, planningPeople } from "../../web/lib/planning.js"
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
      "synthetic",
      "browser",
      "chromium",
      "browserbase",
      "smoke",
      "post-deploy",
      "playbook",
      "probe",
      "vendor",
      "member-access",
      "radar",
      "fixture",
      "drift",
      "status page",
    ],
  },
  {
    person: "Kyle King",
    keywords: [
      "watch-doggo",
      "watchdoggo",
      "code review",
      "code-gen",
      "uptime",
      "month-end",
      "error budget",
      "error-budget",
      "slo",
      "dagster",
      "hatchet",
      "n+1",
      "index",
      "postgres",
      "performance",
      "pulumi",
      "kill-switch",
      "outbox",
      "resilience",
      "bedrock",
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

// Per-person capacity for one cycle: the person's velocity (or the flat project ceiling when a caller
// passes one) after the shared on-call/OOO deflation. Delegates to planning.js so the board, the
// capacity report, and balance all agree on the math.
function cycleCapacity(person: string, cycle: number, snapshot: Snapshot, weeklyOverride?: number): number {
  return personCycleCapacity(person, cycle, snapshot.capacity, weeklyOverride).points
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

export type MilestoneRisk = {
  key: string
  target: string
  latestScheduledEnd: string | null
  unscheduledPoints: number
  verdict: "on-track" | "at-risk" | "deferred"
}

export function balance(snapshot: Snapshot, options: BalanceOptions = {}): {
  options: Required<Pick<BalanceOptions, "weeklyPerPerson" | "start" | "end">> & { people: string[] }
  warnings: string[]
  capacity: { person: string; cycle: number; capacity: number; committed: number; free: number }[]
  assignments: Assignment[]
  unscheduled: Assignment[]
  atRisk: { id: string; title: string; milestone: string | null; reason: string }[]
  milestoneRisk: MilestoneRisk[]
  perCycle: { cycle: number; end: string; byPerson: Record<string, number> }[]
  ops: Op[]
} {
  snapshot = liveSnapshot(snapshot) as Snapshot
  const weekly = options.weeklyPerPerson ?? snapshot.capacity?.defaultVelocity ?? 20
  const start = options.start ?? snapshot.currentCycle + 1
  // Default the window to the cycles the project actually has. Running eight past the last real cycle
  // put every candidate in `unscheduled` with a warning, which reads as "nothing fits" when the truth
  // is that the window was asking about weeks the team has not planned yet.
  // Seeded below `start` on purpose: when the project has no cycle after the current one there is
  // genuinely nowhere to plan, and the window should collapse to `start` so the "do not exist" warning
  // says so, rather than quietly inventing a cycle to aim at.
  const lastCycle = snapshot.cycles.reduce((max, c) => Math.max(max, c.n), 0)
  const end = options.end ?? Math.max(start, Math.min(start + 7, lastCycle))
  // Who to spread work across: the people who already own live work here, matching what the forecast
  // plans for (planning.js's planningPeople). The roster is an identity directory covering every
  // engineer, so defaulting to it would hand this project's tickets to people who have never touched
  // it. A project where nothing is assigned yet has no owners to learn from, and balance exists
  // precisely to assign unowned work, so that one case falls back to the roster and says so.
  const owners = planningPeople(snapshot)
  const rostered = Object.keys(snapshot.capacity?.roster ?? {})
  const people = options.people ?? (owners.length ? owners : rostered)
  const affinities = (options.affinities ?? DEFAULT_AFFINITIES).filter((a) => people.includes(a.person))
  const cycleEnd = Object.fromEntries(snapshot.cycles.map((c) => [c.n, c.end]))
  const warnings: string[] = []

  // Only schedule into cycles the team actually runs. A cycle in the window with no matching snapshot
  // cycle has nowhere to land a `set_cycle`, so drop it and say so rather than propose an impossible move.
  const existing = new Set(snapshot.cycles.map((c) => c.n))
  const cycles: number[] = []
  const missing: number[] = []
  for (let n = start; n <= end; n++) (existing.has(n) ? cycles : missing).push(n)
  if (missing.length) {
    warnings.push(`cycles ${missing.join(", ")} do not exist in the team yet; nothing scheduled there`)
  }
  if (!people.length) warnings.push("nobody owns work here and the roster is empty; nothing to assign")
  if (!options.people && !owners.length && rostered.length) {
    warnings.push(
      `nobody owns work in this project yet, so the whole roster is in play (${rostered.length} people); ` +
        `pass an explicit list to narrow it`,
    )
  }
  if (!cycles.length) warnings.push("no runnable cycles in the window; every candidate left unscheduled")

  // Remaining capacity grid, seeded then drained by work already committed to a cycle in the window.
  const free: Record<string, Record<number, number>> = {}
  const cap: Record<string, Record<number, number>> = {}
  for (const p of people) {
    free[p] = {}
    cap[p] = {}
    for (const n of cycles) {
      const c = cycleCapacity(p, n, snapshot, options.weeklyPerPerson)
      cap[p][n] = c
      free[p][n] = c
    }
  }

  // Two different gaps, both of which make the load math wrong, and both worth naming.
  //
  // Someone holding committed work who is not in `people` never appears in the capacity grid, so their
  // load is invisible and every cycle they occupy reads as emptier than it is.
  //
  // Someone in `people` who is not in the roster is the opposite problem: they get a row in the grid,
  // but with no velocity, no on-call, and no out-days recorded, their ceiling is the default rather
  // than anything measured. `deno task roster` is the fix.
  const uncounted = new Set<string>()
  const unmodelled = new Set<string>()
  const rosterSet = new Set(rostered)
  for (const i of snapshot.issues) {
    if (!i.cycle || !cycles.includes(i.cycle) || !ALIVE(i) || i.assignee === "Unassigned") continue
    if (!people.includes(i.assignee)) uncounted.add(i.assignee)
    else if (!rosterSet.has(i.assignee)) unmodelled.add(i.assignee)
  }
  if (uncounted.size) {
    warnings.push(
      `owners outside this plan hold committed work in the window (capacity not modeled): ${
        [...uncounted].sort().join(", ")
      }`,
    )
  }
  if (unmodelled.size) {
    warnings.push(
      `off-roster owners, so their capacity is the default rather than measured (run deno task roster): ${
        [...unmodelled].sort().join(", ")
      }`,
    )
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

  const unestimated = candidates.filter((i) => !i.estimate).map((i) => i.id)
  if (unestimated.length) {
    warnings.push(`no estimate, left unscheduled: ${unestimated.join(", ")}`)
  }

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
  const pick = (issue: Issue, score: Record<string, number>): string => {
    const owns = (p: string) =>
      owned[p].has(issue.milestone ?? "") ||
      [...(issue.blockedBy ?? []), ...(issue.blocks ?? []), ...(issue.related ?? [])]
        .some((n) => byId[n]?.assignee === p)
    const value = (p: string) =>
      AFFINITY_W * score[p] + CONTINUITY_W * (owns(p) ? 1 : 0) - BALANCE_W * (assignedTotal[p] / weekly)
    return [...people].sort((a, b) =>
      value(b) - value(a) || assignedTotal[a] - assignedTotal[b] || a.localeCompare(b)
    )[0]
  }

  for (const issue of candidates) {
    const est = issue.estimate || 0
    const score = affinityScore(issue, affinities)
    const person = pick(issue, score)

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
        atRisk.push({
          id: issue.id,
          title: issue.title,
          milestone: issue.milestone,
          reason: `cycle ${placed} ends ${cycleEnd[placed]}, after milestone target ${target}`,
        })
      }
    } else {
      row.reason = est === 0
        ? "no estimate"
        : earliest > end
        ? `milestone too far out; schedule near cycle ${leadFloor}`
        : "beyond horizon capacity"
      unscheduled.push(row)
      if (target <= (cycleEnd[end] ?? "9999-12-31")) {
        atRisk.push({
          id: issue.id,
          title: issue.title,
          milestone: issue.milestone,
          reason: `unscheduled but milestone target ${target} is inside the horizon`,
        })
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

  // Schedule-aware deadline read per milestone this pass touched: the latest cycle any of its still-open
  // work lands in (committed or newly placed), and how many open points are still unplaced. A milestone
  // is at risk when work lands after its target, or when work is unplaced and the target sits inside the
  // window we planned; unplaced work for a target past the window is deferred, not at risk. This answers
  // "do the estimates say we miss the date" from the actual plan, not a team-average forecast.
  const horizonEndDate = cycles.length ? cycleEnd[cycles[cycles.length - 1]] : (cycleEnd[end] ?? "9999-12-31")
  const touched = new Set(candidates.map((c) => c.milestone).filter((m): m is string => m != null))
  const milestoneRisk = snapshot.milestones
    .filter((m) => touched.has(m.key))
    .map((m) => {
      let latestScheduledEnd: string | null = null
      let unscheduledPoints = 0
      for (const i of snapshot.issues) {
        if (i.milestone !== m.key || !ALIVE(i)) continue
        const c = i.cycle ?? scheduledCycle[i.id] ?? null
        if (c == null) {
          unscheduledPoints += i.estimate || 0
          continue
        }
        const e = cycleEnd[c]
        if (e && (latestScheduledEnd == null || e > latestScheduledEnd)) latestScheduledEnd = e
      }
      const landsLate = latestScheduledEnd != null && latestScheduledEnd > m.target
      const unplacedByDeadline = unscheduledPoints > 0 && m.target <= horizonEndDate
      const verdict: MilestoneRisk["verdict"] = landsLate || unplacedByDeadline
        ? "at-risk"
        : unscheduledPoints > 0
        ? "deferred"
        : "on-track"
      return { key: m.key, target: m.target, latestScheduledEnd, unscheduledPoints, verdict }
    })

  return {
    options: { weeklyPerPerson: weekly, start, end, people },
    warnings,
    capacity: capacityRows,
    assignments,
    unscheduled,
    atRisk,
    milestoneRisk,
    perCycle,
    ops,
  }
}
