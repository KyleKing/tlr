// Where local state lives, and the two writes that touch it. Shared by the dev server's refresh
// endpoint and the scheduled run (scripts/snapshot.ts) so both capture on exactly the same terms.
//
// The run log and the lock sit beside whichever snapshot store is in play, so pointing TLR_SNAPSHOT_DB
// at a throwaway file (the e2e harness does) moves all three together instead of leaving a scheduled
// run's bookkeeping in the real store.

import { openStore } from "@/snapshot.ts"
import type { Snapshot } from "@/seed.ts"

export const DATA_ROOT = new URL("../web/data/", import.meta.url)
export const SNAPSHOT_DB = Deno.env.get("TLR_SNAPSHOT_DB") ?? new URL("tlr.sqlite", DATA_ROOT).pathname

function sibling(path: string, name: string): string {
  const cut = path.lastIndexOf("/")
  return cut === -1 ? name : `${path.slice(0, cut + 1)}${name}`
}

export const RUN_LOG_PATH = sibling(SNAPSHOT_DB, "snapshot-runs.jsonl")
export const RUN_LOCK_PATH = sibling(SNAPSHOT_DB, "snapshot-run.lock")

// Writes JSON to `path` atomically (write a sibling temp file, then rename over the target) so a
// concurrent reader — the board's own polling, another write in flight, a snapshot capture — never
// observes a half-written file. A plain writeTextFile can otherwise be read mid-write and throw
// "Unexpected end of JSON input", which is a real risk here: three different POST handlers write the
// same project data file, and nothing serializes them against each other or against a GET.
export async function writeJsonAtomic(path: URL, data: unknown): Promise<void> {
  const tmp = new URL(`${path.href}.${crypto.randomUUID()}.tmp`)
  await Deno.writeTextFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await Deno.rename(tmp, path)
}

// A capture that loses most of the issue list is far more often a broken read than a real event: a
// truncated page, an ingest that resolved the wrong project, a permissions change. Storing it turns
// the next diff into a mass deletion nobody asked for, so a drop past the threshold is refused.
//
// Half is the line, and only once the previous snapshot had COLLAPSE_FLOOR issues. A project of six
// tickets legitimately loses three in an afternoon; a project of eighty does not lose forty. Both
// numbers are deliberately loose — this guards against a read that broke, not against normal churn,
// and a run refused for the wrong reason costs a human the time to look at it.
export const COLLAPSE_FLOOR = 10
export const COLLAPSE_MAX_DROP_RATIO = 0.5

export class CollapsedCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CollapsedCaptureError"
  }
}

export function isImplausibleDrop(
  previousCount: number,
  nextCount: number,
  floor: number = COLLAPSE_FLOOR,
  maxDropRatio: number = COLLAPSE_MAX_DROP_RATIO,
): boolean {
  if (previousCount < floor) return false
  return nextCount < previousCount * (1 - maxDropRatio)
}

export function collapseMessage(projectName: string, previousCount: number, nextCount: number): string {
  return `${projectName}: issue count fell from ${previousCount} to ${nextCount}; capture refused as a likely broken read ` +
    `(--allow-collapse to capture it anyway)`
}

// The comparable shape of a snapshot: what a plan-level diff would notice. Used to skip a capture that
// would be identical to the latest one already stored for the project.
function snapshotSignature(s: Snapshot): string {
  return JSON.stringify({ asOf: s.asOf, milestones: s.milestones, issues: s.issues })
}

// Capture a snapshot into the local store, unless the project's latest stored snapshot is identical.
// Returns the saved row, and whether the store already held it. Opens and closes its own store handle.
// Throws CollapsedCaptureError when the issue list collapsed against the stored snapshot, unless
// allowCollapse says a human has already looked at it.
//
// The whole list -> load -> compare -> insert runs inside one BEGIN IMMEDIATE. Read outside a
// transaction, two runs firing together (launchd waking a missed timer while the board's refresh
// button is pressed) both see the same "latest", both clear the dedupe check, and both insert.
export function captureSnapshot(
  snapshot: Snapshot,
  label?: string,
  opts: { allowCollapse?: boolean } = {},
): { id: number; skipped: boolean } {
  const store = openStore(SNAPSHOT_DB)
  try {
    return store.transaction(() => {
      const latest = store.listSnapshots().find((r) => r.projectName === snapshot.project.name)
      if (!latest) return { id: store.saveSnapshot(snapshot, Date.now(), label).id, skipped: false }

      const previous = store.loadSnapshot(latest.id)
      if (snapshotSignature(previous) === snapshotSignature(snapshot)) return { id: latest.id, skipped: true }
      if (!opts.allowCollapse && isImplausibleDrop(previous.issues.length, snapshot.issues.length)) {
        throw new CollapsedCaptureError(
          collapseMessage(snapshot.project.name, previous.issues.length, snapshot.issues.length),
        )
      }
      return { id: store.saveSnapshot(snapshot, Date.now(), label).id, skipped: false }
    })
  } finally {
    store.close()
  }
}
