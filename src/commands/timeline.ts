import { liveIssues } from "../../web/lib/issues.js"
import { bucketOf, buildBuckets, chainRisks, dependencyWaves } from "../../web/lib/planning.js"
import type { Issue, Snapshot } from "@/seed.ts"

type ChainOwner = { person: string; points: number; perCycle: number; cycles: number | null }
type Chain = {
  ids: string[]
  path: string[]
  points: number
  unestimated: number
  owners: ChainOwner[]
  cyclesNeeded: number | null
  stalled: boolean
  target: string | null
  cyclesAvailable: number | null
  shortfall: number | null
  atRisk: boolean
  spans: { milestones: number; cycles: number; assignees: number }
}

export function projectTimeline(snapshot: Snapshot) {
  const issues = liveIssues(snapshot.issues) as Issue[]
  const buckets = buildBuckets(snapshot)
  const bucketByKey = Object.fromEntries(buckets.map((b) => [b.key, b]))
  for (const i of issues) {
    i.blocks ||= []
    i.blockedBy ||= []
    i.related ||= []
    ;(i as { _bucket?: string })._bucket = bucketOf(i)
    ;(i as { _bucketEnd?: string })._bucketEnd = (bucketByKey[bucketOf(i)] || { end: "9999-12-31" }).end
  }

  const byId = Object.fromEntries(issues.map((i) => [i.id, i]))
  const waves = dependencyWaves(issues).map((ids: string[], n: number) => ({
    wave: n,
    issues: ids.map((id) => {
      const i = byId[id]
      return { id, title: i.title, milestone: i.milestone, cycle: i.cycle, assignee: i.assignee }
    }),
  }))

  const chains = (chainRisks(snapshot, issues) as Chain[]).map((c) => ({
    ids: c.ids,
    path: c.path,
    points: c.points,
    unestimated: c.unestimated,
    owners: c.owners,
    cyclesNeeded: c.cyclesNeeded,
    cyclesAvailable: c.cyclesAvailable,
    shortfall: c.shortfall,
    target: c.target,
    atRisk: c.atRisk,
    spans: c.spans,
    detail: chainDetail(c),
  }))

  return { waves, chains }
}

function chainDetail(c: Chain) {
  const who = c.owners.map((o) => `${o.person} ${o.points}pt at ${o.perCycle}/cycle`).join(", ")
  if (c.stalled) return `${c.path.length} tickets on the critical path (${who}), but nobody delivers on it`
  if (c.cyclesAvailable == null) {
    return `${c.path.length} tickets, ${c.points} points, ${c.cyclesNeeded} cycles of sequential work (${who}), no milestone target to measure against`
  }
  const verdict = c.atRisk ? `${c.shortfall} cycles short` : `${-(c.shortfall ?? 0)} cycles of slack`
  return `${c.path.length} tickets, ${c.points} points, needs ${c.cyclesNeeded} cycles (${who}) with ${c.cyclesAvailable} left before ${c.target}: ${verdict}`
}
