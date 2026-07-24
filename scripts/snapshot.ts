// Capture a snapshot of every configured project, on the same terms the server's POST /api/refresh
// does, from a context with no browser and no terminal.
//
//   deno task snapshot                       # every project in web/data/projects.json
//   deno task snapshot --data cpu.json       # one data file
//   deno task snapshot --force               # ignore the minimum interval
//   deno task snapshot --dry-run             # report what it would do, write nothing
//
// This is what the launchd LaunchAgent runs daily (scripts/schedule.sh). launchd fires a missed
// StartCalendarInterval once on wake, so a laptop that was asleep at the scheduled hour still gets its
// capture — which makes an overlapping run and a redundant run both realistic, hence the lock and the
// minimum interval in src/runLock.ts. Every run, including a refusal, appends one line to the run log
// that the board reads back through /api/schedule/health.
//
// Out-of-office is deliberately left out of the capacity refresh: Google Calendar's OAuth handoff can
// shell out to `open` for consent, which a scheduled run has no way to complete and this task has no
// permission to attempt. On-call and velocity refresh unattended, and out-days stay whatever the last
// interactive `deno task capacity` wrote.

import { captureSnapshot, DATA_ROOT, RUN_LOCK_PATH, RUN_LOG_PATH, writeJsonAtomic } from "@/capture.ts"
import { lastSuccessAt, readRunLog, recordRun, type RunEntry, type RunOutcome } from "@/runLog.ts"
import { acquireLock, MIN_RUN_INTERVAL_MS, shouldSkipRun } from "@/runLock.ts"
import { type CapacityData, refreshCapacity } from "./capacity.ts"
import { ingestProject, linearKey } from "./issues.ts"
import type { Snapshot } from "@/seed.ts"

const UNATTENDED_CAPACITY_SOURCES = ["history", "incident"] as const

type Args = { data?: string; dryRun: boolean; force: boolean }
type BoardData = CapacityData & { project?: { name?: string } }
type Result = { detail: string; outcome: RunOutcome }

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") args.dryRun = true
    else if (a === "--force") args.force = true
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

// A dry run stops before the first fetch. Going further would not be dry: ingestProject rewrites the
// projects.json manifest as part of its normal work, so "fetch everything but skip the last write" is
// not a state this can report from without changing the tree.
async function refreshOne(dataFile: string, dryRun: boolean): Promise<string> {
  const path = new URL(dataFile, DATA_ROOT)
  const data: BoardData = await Deno.readTextFile(path).then(JSON.parse)
  if (!data.project?.name) return `${dataFile}: no project name, nothing to fetch`
  if (dryRun) return `${dataFile}: would refresh and capture`

  const key = await linearKey()
  const ingested = await ingestProject(key, data.project.name, data, dataFile)
  const merged = ingested.data as BoardData
  const notes = await refreshCapacityQuietly(merged)
  const suffix = notes.length ? ` [${notes.join("; ")}]` : ""

  await writeJsonAtomic(path, merged)
  const capture = captureSnapshot(merged as unknown as Snapshot, "scheduled")
  const state = capture.skipped ? `unchanged since #${capture.id}` : `captured #${capture.id}`
  return `${dataFile}: ${state}${suffix}`
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

// A run that captured nothing new still counts as a success: the fetch happened and the store is known
// to be current, which is what the staleness half of the health check asks about.
function outcomeFor(lines: string[]): RunOutcome {
  return lines.some((line) => line.includes("captured #")) ? "captured" : "unchanged"
}

async function captureAll(args: Args): Promise<Result> {
  const files = await dataFiles(args)
  if (!files.length) return { detail: "no projects configured", outcome: "failed" }
  const lines: string[] = []
  for (const file of files) lines.push(await refreshOne(file, args.dryRun))
  return { detail: lines.join("; "), outcome: outcomeFor(lines) }
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
  if (result.outcome === "failed") {
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
