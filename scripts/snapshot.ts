// Capture a snapshot of every configured project, on the same terms the server's POST /api/refresh
// does, from a context with no browser and no terminal.
//
//   deno task snapshot                       # every project in web/data/projects.json
//   deno task snapshot --data cpu.json       # one data file
//   deno task snapshot --force               # ignore the minimum interval
//   deno task snapshot --dry-run             # report what it would do, write nothing
//   deno task snapshot --allow-collapse      # capture even if the issue list collapsed (see src/capture.ts)
//   deno task snapshot --prune               # apply the retention policy instead of only reporting it
//
// Every project runs on its own: one project's failure is recorded against that project and the rest
// still run, so a local seed file or one broken project cannot cost the others their capture.
//
// This is what the launchd LaunchAgent runs every three hours (scripts/schedule.sh). launchd fires a
// missed StartCalendarInterval once on wake, so a laptop that was asleep at the scheduled hour still gets its
// capture — which makes an overlapping run and a redundant run both realistic, hence the lock and the
// minimum interval in src/runLock.ts. Every run, including a refusal, appends one line to the run log
// that the board reads back through /api/schedule/health.
//
// Retention reports on every run and deletes on none of them unless --prune is passed, and the
// installed LaunchAgent does not pass it. A capture is ~175 KB and this runs eight times a day, so an
// unpruned store grows about half a gigabyte per project per year — real, but slow enough that reading
// a few days of "would drop N" lines in the run log costs about 10 MB and buys confidence that the
// plan groups history the way the store actually keys it. Turn it on by hand once those lines look
// right (`deno task snapshot --prune --force`), or add the flag to the plist.
//
// Out-of-office is deliberately left out of the capacity refresh: Google Calendar's OAuth handoff can
// shell out to `open` for consent, which a scheduled run has no way to complete and this task has no
// permission to attempt. On-call and velocity refresh unattended, and out-days stay whatever the last
// interactive `deno task capacity` wrote.

import { captureSnapshot, DATA_ROOT, RUN_LOCK_PATH, RUN_LOG_PATH, SNAPSHOT_DB, writeJsonAtomic } from "@/capture.ts"
import {
  combineOutcomes,
  lastSuccessAt,
  type ProjectOutcome,
  type ProjectResult,
  readRunLog,
  recordRun,
  type RunEntry,
  type RunOutcome,
  summarizeResults,
} from "@/runLog.ts"
import { type PruneResult, pruneStore } from "@/retention.ts"
import { acquireLock, MIN_RUN_INTERVAL_MS, shouldSkipRun } from "@/runLock.ts"
import { openStore } from "@/snapshot.ts"
import { type CapacityData, refreshCapacity } from "./capacity.ts"
import { ingestProject, linearKey } from "./issues.ts"
import { slugIdFromUrl } from "@/linearAccess.ts"
import type { Snapshot } from "@/seed.ts"

const UNATTENDED_CAPACITY_SOURCES = ["history", "incident"] as const

type Args = { allowCollapse: boolean; data?: string; dryRun: boolean; force: boolean; prune: boolean }
type BoardData = CapacityData & { project?: { name?: string; url?: string } }
type Result = { detail: string; outcome: RunOutcome }
type FileResult = { detail: string; outcome: ProjectOutcome }

function parseArgs(argv: string[]): Args {
  const args: Args = { allowCollapse: false, dryRun: false, force: false, prune: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--allow-collapse") args.allowCollapse = true
    else if (a === "--dry-run") args.dryRun = true
    else if (a === "--force") args.force = true
    else if (a === "--prune") args.prune = true
    else if (a === "--data") args.data = argv[++i]
  }
  return args
}

async function dataFiles(args: Args): Promise<string[]> {
  if (args.data) return [args.data.split("/").pop() as string]
  const manifest: { dataFile: string }[] = await Deno.readTextFile(new URL("projects.json", DATA_ROOT))
    .then(JSON.parse)
    .catch(() => [])
  return [...new Set(manifest.map((entry) => entry.dataFile).filter((name) => typeof name === "string"))]
}

// Capacity is best-effort. A missing Incident.io token should leave a note in the run log, not turn
// every night's snapshot into a failure the banner shouts about.
async function refreshCapacityQuietly(data: BoardData): Promise<string[]> {
  const notes: string[] = []
  for (const source of UNATTENDED_CAPACITY_SOURCES) {
    try {
      await refreshCapacity(data, { source })
    } catch (err) {
      notes.push(`${source} skipped (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  return notes
}

// scripts/seed.ts writes a data file and a manifest entry for a project that only exists locally, so
// the scheduled run finds files with no Linear project to fetch. Linear's own project URLs carry a
// slugId; a file without one has no counterpart, which is a reason to leave it alone rather than a
// failure to report.
function hasLinearCounterpart(data: BoardData): boolean {
  return Boolean(data.project?.name) && slugIdFromUrl(data.project?.url) !== null
}

// A dry run stops before the first fetch. Going further would not be dry: ingestProject rewrites the
// projects.json manifest as part of its normal work, so "fetch everything but skip the last write" is
// not a state this can report from without changing the tree.
async function refreshOne(dataFile: string, args: Args): Promise<FileResult> {
  const path = new URL(dataFile, DATA_ROOT)
  const data: BoardData = await Deno.readTextFile(path).then(JSON.parse)
  if (!hasLinearCounterpart(data)) {
    return { detail: "local only, no Linear project to fetch", outcome: "not-applicable" }
  }
  if (args.dryRun) return { detail: "would refresh and capture", outcome: "unchanged" }

  const key = await linearKey()
  const ingested = await ingestProject(key, data.project!.name!, data, dataFile)
  const merged = ingested.data as BoardData
  const notes = await refreshCapacityQuietly(merged)
  const suffix = notes.length ? ` [${notes.join("; ")}]` : ""

  await writeJsonAtomic(path, merged)
  const capture = captureSnapshot(merged as unknown as Snapshot, "scheduled", { allowCollapse: args.allowCollapse })
  return capture.skipped
    ? { detail: `unchanged since #${capture.id}${suffix}`, outcome: "unchanged" }
    : { detail: `captured #${capture.id}${suffix}`, outcome: "captured" }
}

// One project's failure is its own. The loop has to reach every other project in the manifest, and the
// run log has to name what broke, or a seed file at the front of the list hides a real project behind it.
async function refreshSafely(dataFile: string, args: Args): Promise<ProjectResult> {
  try {
    return { ...(await refreshOne(dataFile, args)), project: dataFile }
  } catch (err) {
    return { detail: err instanceof Error ? err.message : String(err), outcome: "failed", project: dataFile }
  }
}

function entryFor(startedAt: number, outcome: RunOutcome, detail: string): RunEntry {
  const finished = Date.now()
  return {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - startedAt,
    outcome,
    detail,
  }
}

export function pruneNote(result: PruneResult): string {
  if (!result.drop.length) return "prune: nothing to thin"
  const mb = Math.round(result.bytesFreedEstimate / 100_000) / 10
  return result.dryRun
    ? `prune: would drop ${result.drop.length} of ${result.drop.length + result.keep.length} snapshots ` +
      `(~${mb} MB); --prune to apply`
    : `prune: dropped ${result.deleted} snapshots (~${mb} MB)`
}

// Retention is bookkeeping, so it never turns a good capture into a failed run — a broken prune is a
// note, the same deal capacity gets. No VACUUM afterwards: the freed pages get reused by the next
// captures, so the file stops growing, and reclaiming the bytes instead would want twice the store's
// size in scratch space and an exclusive lock for as long as it takes, neither of which belongs in an
// unattended run.
function pruneQuietly(args: Args): string {
  const store = openStore(SNAPSHOT_DB)
  try {
    return pruneNote(pruneStore(store, { dryRun: !args.prune }))
  } catch (err) {
    return `prune skipped (${err instanceof Error ? err.message : String(err)})`
  } finally {
    store.close()
  }
}

// A run that captured nothing new still counts as a success: the fetch happened and the store is known
// to be current, which is what the staleness half of the health check asks about. See combineOutcomes
// in src/runLog.ts for how a mixed run reads.
async function captureAll(args: Args): Promise<Result> {
  const files = await dataFiles(args)
  if (!files.length) return { detail: "no projects configured", outcome: "failed" }
  const results: ProjectResult[] = []
  for (const file of files) results.push(await refreshSafely(file, args))
  const summary = summarizeResults(results)
  // A dry run opens nothing: openStore would create and migrate a store that is not there yet, which
  // is a write, and this run promised not to make any.
  const detail = args.dryRun ? summary : `${summary} [${pruneQuietly(args)}]`
  return { detail, outcome: combineOutcomes(results) }
}

async function guardedRun(args: Args, startedAt: number): Promise<Result> {
  const previous = lastSuccessAt(await readRunLog(RUN_LOG_PATH))
  if (!args.force && shouldSkipRun(previous, startedAt)) {
    const hours = Math.round(MIN_RUN_INTERVAL_MS / 3600000)
    return { detail: `a successful run landed under ${hours}h ago; --force to run anyway`, outcome: "skipped" }
  }
  try {
    return await captureAll(args)
  } catch (err) {
    return { detail: err instanceof Error ? err.message : String(err), outcome: "failed" }
  }
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args)
  const startedAt = Date.now()

  const release = await acquireLock(RUN_LOCK_PATH, startedAt)
  const result = release ? await guardedRun(args, startedAt) : {
    detail: "another snapshot run holds the lock",
    outcome: "skipped" as const,
  }
  if (release) await release()

  if (!args.dryRun) await recordRun(RUN_LOG_PATH, entryFor(startedAt, result.outcome, result.detail))
  if (result.outcome === "failed" || result.outcome === "partial") {
    console.error(`snapshot: ${result.detail}`)
    return 1
  }
  console.log(`snapshot: ${result.detail}`)
  return 0
}

if (import.meta.main) {
  const code = await main()
  if (code !== 0) Deno.exit(code)
}
