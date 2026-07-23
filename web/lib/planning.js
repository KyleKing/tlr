// Pure planning logic shared by the browser app and Deno tests. No DOM here.

export const ACTIVE_CYCLES = [48, 49]

export function bucketOf(issue) {
  if (issue.cycle === 47) return "C47"
  if (ACTIVE_CYCLES.includes(issue.cycle)) return "C" + issue.cycle
  if (issue.milestone) return issue.milestone
  return "BACKLOG"
}

// Ordered time buckets with an end date each, so cycles and milestones compare on one axis.
export function buildBuckets(data) {
  const cyc = Object.fromEntries(data.cycles.map((c) => [c.n, c]))
  const cols = []
  if (cyc[47]) cols.push({ key: "C47", label: "Cycle 47", sub: "past", end: cyc[47].end, kind: "cycle" })
  for (const n of ACTIVE_CYCLES) {
    if (cyc[n]) {
      cols.push({
        key: "C" + n,
        label: "Cycle " + n,
        sub: n === data.currentCycle ? "current" : "next",
        end: cyc[n].end,
        kind: "cycle",
      })
    }
  }
  for (const m of data.milestones) {
    cols.push({
      key: m.key,
      label: m.key,
      name: m.name,
      sub: "target " + m.target,
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
  if (hits.length) flags.push("phrase: " + hits.slice(0, 3).join(", "))
  if (t.length > 1500) flags.push("long (" + Math.round(t.length / 100) / 10 + "k chars)")
  const bullets = (t.match(/^[ \t]*[-*] /gm) || []).length
  if (bullets >= 8) flags.push(bullets + " bullets")
  const score = flags.length + hits.length + (t.length > 3000 ? 1 : 0)
  return { score, flags }
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
