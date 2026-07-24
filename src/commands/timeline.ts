import { bucketOf, buildBuckets, dependencyWaves, orderingRisks } from "../../web/lib/planning.js"
import type { Snapshot } from "@/seed.ts"

export function projectTimeline(snapshot: Snapshot) {
  const buckets = buildBuckets(snapshot)
  const bucketByKey = Object.fromEntries(buckets.map((b) => [b.key, b]))
  for (const i of snapshot.issues) {
    i.blocks ||= []
    i.blockedBy ||= []
    i.related ||= []
    ;(i as { _bucket?: string })._bucket = bucketOf(i)
    ;(i as { _bucketEnd?: string })._bucketEnd = (bucketByKey[bucketOf(i)] || { end: "9999-12-31" }).end
  }

  const byId = Object.fromEntries(snapshot.issues.map((i) => [i.id, i]))
  const waves = dependencyWaves(snapshot.issues).map((ids: string[], n: number) => ({
    wave: n,
    issues: ids.map((id) => {
      const i = byId[id]
      return { id, title: i.title, milestone: i.milestone, cycle: i.cycle, assignee: i.assignee }
    }),
  }))

  const risks = orderingRisks(snapshot.issues).map((r: { issue: string; blocker: string }) => ({
    issue: r.issue,
    blocker: r.blocker,
    detail: `${r.issue} is blocked by ${r.blocker}, which finishes later`,
  }))

  return { waves, risks }
}
