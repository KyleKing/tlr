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

// The comparable shape of a snapshot: what a plan-level diff would notice. Used to skip a capture that
// would be identical to the latest one already stored for the project.
function snapshotSignature(s: Snapshot): string {
  return JSON.stringify({ asOf: s.asOf, milestones: s.milestones, issues: s.issues })
}

// Capture a snapshot into the local store, unless the project's latest stored snapshot is identical.
// Returns the saved row, or null when nothing changed. Opens and closes its own store handle.
export function captureSnapshot(snapshot: Snapshot, label?: string): { id: number; skipped: boolean } {
  const store = openStore(SNAPSHOT_DB)
  try {
    const latest = store.listSnapshots().find((r) => r.projectName === snapshot.project.name)
    if (latest && snapshotSignature(store.loadSnapshot(latest.id)) === snapshotSignature(snapshot)) {
      return { id: latest.id, skipped: true }
    }
    const saved = store.saveSnapshot(snapshot, Date.now(), label)
    return { id: saved.id, skipped: false }
  } finally {
    store.close()
  }
}
