// Pure planning logic shared by the browser app and Deno tests. No DOM here.

export const ACTIVE_CYCLES = [48, 49]

export function bucketOf(issue) {
  if (issue.cycle === 47) return "C47"
  if (ACTIVE_CYCLES.includes(issue.cycle)) return `C${issue.cycle}`
  if (issue.milestone) return issue.milestone
  return "BACKLOG"
}

// Display label for a milestone column: drop a leading "M1: "/"M12: " ordinal prefix when present, so
// a project that follows the convention shows the name without the redundant code, and one with plain
// names shows the name as-is. The full name lives in the hover; CSS truncates the visible label.
export function milestoneDisplayName(name, fallback) {
  if (!name) return fallback
  return name.replace(/^M\d+:\s*/, "") || fallback
}

// Ordered time buckets with an end date each, so cycles and milestones compare on one axis. `issues`
// is optional; when given, a cycle column is dropped if no issue actually falls into it (milestone and
// backlog columns always show, since those are meaningful even with zero issues today).
export function buildBuckets(data, issues) {
  const cyc = Object.fromEntries(data.cycles.map((c) => [c.n, c]))
  const hasIssue = (key) => !Array.isArray(issues) || issues.some((i) => bucketOf(i) === key)
  const cols = []
  if (cyc[47] && hasIssue("C47")) {
    cols.push({ key: "C47", label: "Cycle 47", sub: "past", end: cyc[47].end, kind: "cycle" })
  }
  for (const n of ACTIVE_CYCLES) {
    if (cyc[n] && hasIssue(`C${n}`)) {
      cols.push({
        key: `C${n}`,
        label: `Cycle ${n}`,
        sub: n === data.currentCycle ? "current" : "next",
        end: cyc[n].end,
        kind: "cycle",
      })
    }
  }
  for (const m of data.milestones) {
    cols.push({
      key: m.key,
      label: milestoneDisplayName(m.name, m.key),
      name: m.name,
      sub: `target ${m.target}`,
      end: m.target,
      progress: m.progress,
      kind: "milestone",
    })
  }
  cols.push({ key: "BACKLOG", label: "Backlog", sub: "unscheduled", end: "9999-12-31", kind: "backlog" })
  return cols
}

export function weeksBetween(fromISO, toISO) {
  const ms = new Date(toISO) - new Date(fromISO)
  return Math.max(0, ms / (7 * 24 * 3600 * 1000))
}

// Milestone capacity = weeks in its window * team capacity/cycle. Window starts at asOf (or prior
// milestone end) and ends at the target. A forecast assumption, not real staffing.
export function milestoneCapacity(milestoneKey, data, teamPerCycle) {
  const idx = data.milestones.findIndex((m) => m.key === milestoneKey)
  if (idx < 0) return 0
  const target = data.milestones[idx].target
  const start = idx === 0 ? data.asOf : maxDate(data.asOf, data.milestones[idx - 1].target)
  return Math.round(weeksBetween(start, target) * teamPerCycle)
}

function maxDate(a, b) {
  return new Date(a) > new Date(b) ? a : b
}

// Milestone slip forecast: a realistic landing date per milestone, always a forecast, never a real
// date. Milestones deliver in target-date order, each starting when the one before finishes (or asOf,
// whichever is later). Weeks of work = a milestone's remaining (open) points over team weekly
// throughput, where throughput sums each rostered person's base velocity per one-week cycle.
const _DAY_MS = 24 * 3600 * 1000
const _WEEK_MS = 7 * _DAY_MS

// The people to plan for: the roster if one is set, otherwise every real assignee on the issues.
export function rosterOrAssignees(snapshot) {
  const roster = Object.keys(snapshot.capacity?.roster ?? {})
  return roster.length ? roster : [...new Set(snapshot.issues.map((i) => i.assignee))].filter((p) => p !== "Unassigned")
}

function teamWeeklyPoints(snapshot) {
  return rosterOrAssignees(snapshot).reduce((sum, p) => sum + personCycleCapacity(p, null, snapshot.capacity).base, 0)
}

function forecastStatus(slipDays) {
  if (slipDays <= -3) return "ahead"
  if (slipDays <= 3) return "on-track"
  return "at-risk"
}

// weeklyPoints overrides the team throughput used for the landing math. Omit for the default (sum of
// each rostered person's base velocity). Pass a realistic figure (e.g. a per-person ceiling deflated
// for on-call and OOO) when the project is only a slice of the team's work, so the forecast does not
// assume everyone spends their whole week on it.
export function milestoneForecast(snapshot, weeklyPoints) {
  // A non-positive override is meaningless (it would land everything at asOf or before), so fall back
  // to the roster sum rather than emit a nonsense date.
  const weekly = weeklyPoints != null && weeklyPoints > 0 ? weeklyPoints : teamWeeklyPoints(snapshot)
  const ordered = [...snapshot.milestones].sort((a, b) => a.target.localeCompare(b.target))
  let cursor = snapshot.asOf
  const milestones = ordered.map((m) => {
    const open = snapshot.issues.filter((i) =>
      i.milestone === m.key && i.statusType !== "completed" && i.statusType !== "canceled"
    )
    const done = snapshot.issues.filter((i) => i.milestone === m.key && i.statusType === "completed")
    const remainingPoints = open.reduce((s, i) => s + (i.estimate || 0), 0)
    const completedPoints = done.reduce((s, i) => s + (i.estimate || 0), 0)
    const weeksNeeded = weekly > 0 ? remainingPoints / weekly : 0
    const start = new Date(cursor) > new Date(snapshot.asOf) ? cursor : snapshot.asOf
    const landing = new Date(new Date(start).getTime() + weeksNeeded * _WEEK_MS).toISOString().slice(0, 10)
    cursor = landing
    const slipDays = Math.round((new Date(landing) - new Date(m.target)) / _DAY_MS)
    return {
      key: m.key,
      name: m.name,
      target: m.target,
      remainingPoints,
      completedPoints,
      weeksNeeded: Math.round(weeksNeeded * 10) / 10,
      landing,
      slipDays,
      status: forecastStatus(slipDays),
    }
  })
  return { asOf: snapshot.asOf, teamWeeklyPoints: weekly, milestones }
}

// A realistic weekly throughput for the forecast: the team's average per-cycle capacity across the
// active cycles, using each rostered person's deflated points (on-call and OOO hold it down) rather
// than raw base velocity. `teamWeeklyPoints` (the default) assumes everyone is fully available every
// week; pass this into milestoneForecast when a near-term on-call or PTO week should be reflected.
// Falls back to 0 when there is no roster or no active cycle, which milestoneForecast reads as "no
// throughput" and leaves landings at asOf.
export function teamWeeklyThroughput(snapshot) {
  const people = rosterOrAssignees(snapshot)
  if (!people.length || !ACTIVE_CYCLES.length) return 0
  let sum = 0
  for (const c of ACTIVE_CYCLES) {
    for (const p of people) sum += personCycleCapacity(p, c, snapshot.capacity).points
  }
  return Math.round(sum / ACTIVE_CYCLES.length)
}

const TELLS = [
  "comprehensive",
  "robust",
  "seamless",
  "leverage",
  "delve",
  "furthermore",
  "moreover",
  "utilize",
  "holistic",
  "streamline",
  "facilitate",
  "in order to",
  "it's not just",
  "not only",
  "boasts",
  "underscore",
  "pivotal",
  "realm",
]

// Scan free text for AI-slop signals. Returns { score, flags }.
export function slopScan(text) {
  const t = text || ""
  const flags = []
  if (/[—–]/.test(t)) flags.push("em/en dash")
  if (/\w;\s/.test(t)) flags.push("semicolon")
  if (/^[ \t]*[-*] \[[ xX]\]/m.test(t)) flags.push("checklist")
  const lower = t.toLowerCase()
  const hits = TELLS.filter((p) => lower.includes(p))
  if (hits.length) flags.push(`phrase: ${hits.slice(0, 3).join(", ")}`)
  if (t.length > 1500) flags.push(`long (${Math.round(t.length / 100) / 10}k chars)`)
  const bullets = (t.match(/^[ \t]*[-*] /gm) || []).length
  if (bullets >= 8) flags.push(`${bullets} bullets`)
  const score = flags.length + hits.length + (t.length > 3000 ? 1 : 0)
  return { score, flags }
}

// Stable hash of a ticket's text, so a dismissed slop flag can persist until the content
// changes. Whitespace is collapsed first, so trivial reflows do not re-flag.
export function slopHash(text) {
  const t = (text || "").replace(/\s+/g, " ").trim()
  let h = 5381
  for (let k = 0; k < t.length; k++) h = ((h << 5) + h + t.charCodeAt(k)) | 0
  return (h >>> 0).toString(36)
}

// Sort order for statuses within a cell: active work first, terminal states last.
const STATUS_RANK = { started: 0, unstarted: 1, triage: 2, backlog: 3, completed: 4, canceled: 5 }
export function statusRank(statusType) {
  return STATUS_RANK[statusType] ?? 9
}

export const CAPACITY_DEFAULTS = { workdaysPerCycle: 5, oncallPenalty: 0.45, defaultVelocity: 20 }

// Effective points a person can deliver in one cycle, after time off and on-call. Returns
// { base, points, factors } where factors describe each deflation so the board can show why.
// A null cycleN means "no cycle events" (used to size milestone windows off base velocity).
// baseOverride replaces the person's velocity as the starting point (e.g. a flat per-project ceiling),
// while still applying the same deflations, so callers don't re-implement the on-call/OOO math.
export function personCycleCapacity(person, cycleN, capacity, baseOverride) {
  const cfg = { ...CAPACITY_DEFAULTS, ...(capacity?.config) }
  const p = (capacity?.people?.[person]) || {}
  const base = baseOverride ?? p.velocity ?? (capacity?.defaultVelocity) ?? cfg.defaultVelocity
  const ev = cycleN == null ? {} : (p.cycles?.[String(cycleN)]) || {}
  const factors = []
  let points = base
  if (ev.outDays > 0) {
    points *= Math.max(0, (cfg.workdaysPerCycle - ev.outDays) / cfg.workdaysPerCycle)
    factors.push({ kind: "out", days: ev.outDays, reason: ev.reason || "out" })
  }
  if (ev.oncall) {
    points *= 1 - cfg.oncallPenalty
    factors.push({ kind: "oncall" })
  }
  return { base, points: Math.round(points), factors }
}

// Missing-data flags. `blocking` is true only when the issue sits in an active cycle,
// where missing fields actually block execution.
export function missingData(issue) {
  const flags = []
  if (!issue.estimate) flags.push("no estimate")
  if (issue.assignee === "Unassigned") flags.push("unassigned")
  if (!issue.milestone) flags.push("no milestone")
  const inCycle = ACTIVE_CYCLES.includes(issue.cycle)
  return { flags, blocking: inCycle && flags.length > 0 }
}

// Order issues into dependency waves: wave 0 has no blockers among the connected set, wave n depends
// only on earlier waves. Only issues touching a blocks/blockedBy edge are included. A dependency cycle
// is broken by dropping its remaining nodes into a final wave, so the function always terminates.
export function dependencyWaves(issues) {
  const byId = Object.fromEntries(issues.map((i) => [i.id, i]))
  const connected = new Set()
  for (const i of issues) {
    if ((i.blockedBy || []).length || (i.blocks || []).length) connected.add(i.id)
  }
  const blockers = {} // id -> its blockers within the connected set
  const indeg = {}
  for (const id of connected) {
    blockers[id] = (byId[id].blockedBy || []).filter((b) => connected.has(b))
    indeg[id] = blockers[id].length
  }
  const waves = []
  let frontier = [...connected].filter((id) => indeg[id] === 0)
  const placed = new Set()
  while (frontier.length) {
    frontier.sort()
    waves.push(frontier)
    for (const id of frontier) placed.add(id)
    const next = []
    for (const id of connected) {
      if (placed.has(id)) continue
      if (blockers[id].every((b) => placed.has(b))) next.push(id)
    }
    frontier = next
  }
  const leftover = [...connected].filter((id) => !placed.has(id)) // dependency cycle, if any
  if (leftover.length) waves.push(leftover.sort())
  return waves
}

// A blocking edge is an ordering risk when the blocker finishes after the issue it blocks.
export function orderingRisks(issues) {
  const byId = Object.fromEntries(issues.map((i) => [i.id, i]))
  const bucketEnd = {}
  const risks = []
  for (const i of issues) bucketEnd[i.id] = i._bucketEnd
  for (const i of issues) {
    for (const blockerId of i.blockedBy || []) {
      const blocker = byId[blockerId]
      if (!blocker) continue
      if (blocker.statusType === "completed" || blocker.statusType === "canceled") continue
      if (new Date(bucketEnd[blockerId]) > new Date(bucketEnd[i.id])) {
        risks.push({ issue: i.id, blocker: blockerId })
      }
    }
  }
  return risks
}
