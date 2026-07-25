// Snapshot retention: a pure policy that decides which stored captures to keep, plus a thin applier
// over the store. One capture of a real project is ~175 KB and the scheduled run fires eight times a
// day, so an unpruned store grows about half a gigabyte per project per year.
//
// The policy thins by age, measured from the newest capture of each project rather than wall-clock
// now, so a project that stopped being captured keeps the shape of its history instead of collapsing
// to one row the moment the machine's clock moves on.

import type { SnapshotRow, SnapshotStore } from "@/snapshot.ts"

const DAY_MS = 24 * 3600 * 1000

// Keep everything for two weeks (a full cycle plus the one before it, so nothing inside a review or
// retro window is ever thinned), one per day out to a year (day resolution is what a "what changed
// since Q2" question needs), one per week beyond that (trend only). Steady state is roughly 470 rows
// per project, about 80 MB, growing ~9 MB a year instead of ~500 MB.
export const RETENTION = { fullDays: 14, dailyDays: 365 } as const

export type RetentionOptions = {
  fullDays?: number
  dailyDays?: number
  keepIds?: Iterable<number>
}

export type PrunePlan = {
  keep: number[]
  drop: number[]
  bytesFreedEstimate: number
}

function dayBucket(capturedAt: number): string {
  return new Date(capturedAt).toISOString().slice(0, 10)
}

function weekBucket(capturedAt: number): string {
  const d = new Date(capturedAt)
  const day = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - day * DAY_MS).toISOString().slice(0, 10)
}

function bucketFor(
  row: SnapshotRow,
  newest: number,
  options: Required<Omit<RetentionOptions, "keepIds">>,
): string | null {
  const ageDays = (newest - row.capturedAt) / DAY_MS
  if (ageDays <= options.fullDays) return null
  if (ageDays <= options.dailyDays) return `d:${dayBucket(row.capturedAt)}`
  return `w:${weekBucket(row.capturedAt)}`
}

function groupByProject(rows: SnapshotRow[]): Map<string, SnapshotRow[]> {
  const groups = new Map<string, SnapshotRow[]>()
  for (const row of rows) {
    const list = groups.get(row.projectKey)
    if (list) list.push(row)
    else groups.set(row.projectKey, [row])
  }
  return groups
}

// Decide what survives. Within a bucket the newest capture wins. The newest capture of every project
// and every id in `keepIds` (every project's review pointer) are never dropped, whatever bucket they
// land in.
export function planPrune(rows: SnapshotRow[], options: RetentionOptions = {}): PrunePlan {
  const bounds = {
    fullDays: options.fullDays ?? RETENTION.fullDays,
    dailyDays: options.dailyDays ?? RETENTION.dailyDays,
  }
  const pinned = new Set(options.keepIds ?? [])
  const keep = new Set<number>()

  for (const group of groupByProject(rows).values()) {
    const ordered = [...group].sort((a, b) => b.capturedAt - a.capturedAt || b.id - a.id)
    keep.add(ordered[0].id)
    const seen = new Set<string>()
    for (const row of ordered) {
      const bucket = bucketFor(row, ordered[0].capturedAt, bounds)
      if (bucket === null) {
        keep.add(row.id)
        continue
      }
      if (seen.has(bucket)) continue
      seen.add(bucket)
      keep.add(row.id)
    }
  }

  const drop = rows.filter((r) => !keep.has(r.id) && !pinned.has(r.id)).map((r) => r.id).sort((a, b) => a - b)
  const dropped = new Set(drop)
  return {
    keep: rows.filter((r) => !dropped.has(r.id)).map((r) => r.id).sort((a, b) => a - b),
    drop,
    bytesFreedEstimate: rows.filter((r) => dropped.has(r.id)).reduce((sum, r) => sum + r.bytes, 0),
  }
}

export type PruneResult = PrunePlan & { dryRun: boolean; deleted: number }

// Applier. Defaults to a dry run: pass `dryRun: false` to actually delete. Deleting inside one
// transaction keeps a concurrent capture from reading a half-pruned history.
export function pruneStore(store: SnapshotStore, options: RetentionOptions & { dryRun?: boolean } = {}): PruneResult {
  const dryRun = options.dryRun ?? true
  const keepIds = [...(options.keepIds ?? []), ...store.listReviewPointers()]
  const plan = planPrune(store.listSnapshots(), { ...options, keepIds })
  if (dryRun || plan.drop.length === 0) return { ...plan, dryRun, deleted: 0 }
  const deleted = store.transaction(() => store.deleteSnapshots(plan.drop))
  return { ...plan, dryRun, deleted }
}
