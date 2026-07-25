// Append-only log of scheduled snapshot runs, one JSON object per line. A scheduled run has no
// terminal to print to, so this file is the only record of what happened; the server reads it back
// for /api/schedule/health and the board turns a failure into a banner.
//
// Parsing is pure and lives apart from the two I/O functions at the bottom, so the append-and-cap
// rules are unit-testable without a filesystem. A malformed line is dropped rather than thrown on:
// a half-written line from a killed process should not blind the health check to every run before it.

// Eight runs a day (scripts/schedule.sh), so 1000 lines is about four months of history. Details are
// capped below, which puts the file's ceiling under a megabyte even in the worst case.
export const RUN_LOG_LIMIT = 1000
const DETAIL_LIMIT = 500

export type RunOutcome = "captured" | "failed" | "partial" | "skipped" | "unchanged"

// One project's share of a run. A run touches every project in the manifest independently, so the
// entry has to carry which ones worked and which did not. "not-applicable" is a local data file with
// no Linear project behind it (the seed generator writes one): nothing to fetch, and not a fault.
export type ProjectOutcome = "captured" | "failed" | "not-applicable" | "unchanged"

export type ProjectResult = {
  detail: string
  outcome: ProjectOutcome
  project: string
}

export type RunEntry = {
  startedAt: string
  finishedAt: string
  durationMs: number
  outcome: RunOutcome
  detail: string
}

const OUTCOMES: RunOutcome[] = ["captured", "failed", "partial", "skipped", "unchanged"]

function isOutcome(value: unknown): value is RunOutcome {
  return typeof value === "string" && OUTCOMES.includes(value as RunOutcome)
}

function toEntry(value: unknown): RunEntry | null {
  if (typeof value !== "object" || value === null) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.startedAt !== "string" || typeof raw.finishedAt !== "string") return null
  if (typeof raw.durationMs !== "number" || !isOutcome(raw.outcome)) return null
  if (Number.isNaN(Date.parse(raw.startedAt)) || Number.isNaN(Date.parse(raw.finishedAt))) return null
  return {
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    durationMs: raw.durationMs,
    outcome: raw.outcome,
    detail: typeof raw.detail === "string" ? raw.detail : "",
  }
}

export function parseRunLog(text: string): RunEntry[] {
  const entries: RunEntry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const entry = toEntry(parsed)
    if (entry) entries.push(entry)
  }
  return entries
}

export function serializeRunLog(entries: RunEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "")
}

// A run entry with its free-text detail bounded, so one enormous error message cannot dominate the file.
export function boundEntry(entry: RunEntry): RunEntry {
  return entry.detail.length <= DETAIL_LIMIT ? entry : { ...entry, detail: `${entry.detail.slice(0, DETAIL_LIMIT)}…` }
}

// The log text with `entry` appended and the oldest entries dropped past `limit`, so the file has a
// fixed ceiling however long the schedule runs.
export function appendRunEntry(text: string, entry: RunEntry, limit: number = RUN_LOG_LIMIT): string {
  const entries = [...parseRunLog(text), boundEntry(entry)]
  return serializeRunLog(entries.slice(-limit))
}

// The run's outcome from its per-project results: every project worked, some did, or none did. A run
// with nothing but local seed files did no work at all and reads as "skipped".
export function combineOutcomes(results: ProjectResult[]): RunOutcome {
  const applicable = results.filter((r) => r.outcome !== "not-applicable")
  if (!results.length) return "failed"
  if (!applicable.length) return "skipped"
  const failed = applicable.filter((r) => r.outcome === "failed")
  if (failed.length === applicable.length) return "failed"
  if (failed.length) return "partial"
  return applicable.some((r) => r.outcome === "captured") ? "captured" : "unchanged"
}

// The entry's detail line: failures first and counted, so whoever reads the banner sees which project
// broke and why before the projects that were fine.
export function summarizeResults(results: ProjectResult[]): string {
  const applicable = results.filter((r) => r.outcome !== "not-applicable")
  const failed = results.filter((r) => r.outcome === "failed")
  const rest = results.filter((r) => r.outcome !== "failed")
  const lines = [...failed, ...rest].map((r) => `${r.project}: ${r.detail}`)
  const head = failed.length ? `${failed.length} of ${applicable.length} projects failed` : null
  return (head ? [head, ...lines] : lines).join("; ")
}

export function lastRun(entries: RunEntry[]): RunEntry | null {
  return entries.length ? entries[entries.length - 1] : null
}

// When the last run that actually wrote or confirmed a snapshot began. "unchanged" counts: the data was
// fetched and compared, and only the redundant write was skipped. "skipped" does not — nothing was
// fetched. Neither does "partial": a project that failed has to be retried, so a partial run must not
// hold the minimum-interval gate shut against the next attempt.
//
// This reports the run's start, not its finish, because the minimum-interval gate in src/runLock.ts
// compares it against the next run's start. Start-to-start is the true cadence; measuring from the
// previous finish would understate every gap by that run's duration and skip legitimate runs.
export function lastSuccessAt(entries: RunEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.outcome === "captured" || entry.outcome === "unchanged") return entry.startedAt
  }
  return null
}

export async function readRunLog(path: string): Promise<RunEntry[]> {
  const text = await Deno.readTextFile(path).catch(() => "")
  return parseRunLog(text)
}

export async function recordRun(path: string, entry: RunEntry): Promise<void> {
  const text = await Deno.readTextFile(path).catch(() => "")
  await Deno.writeTextFile(path, appendRunEntry(text, entry))
}
