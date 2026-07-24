// Append-only log of scheduled snapshot runs, one JSON object per line. A scheduled run has no
// terminal to print to, so this file is the only record of what happened; the server reads it back
// for /api/schedule/health and the board turns a failure into a banner.
//
// Parsing is pure and lives apart from the two I/O functions at the bottom, so the append-and-cap
// rules are unit-testable without a filesystem. A malformed line is dropped rather than thrown on:
// a half-written line from a killed process should not blind the health check to every run before it.

export const RUN_LOG_LIMIT = 200
const DETAIL_LIMIT = 500

export type RunOutcome = "captured" | "failed" | "skipped" | "unchanged"

export type RunEntry = {
  startedAt: string
  finishedAt: string
  durationMs: number
  outcome: RunOutcome
  detail: string
}

const OUTCOMES: RunOutcome[] = ["captured", "failed", "skipped", "unchanged"]

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

export function lastRun(entries: RunEntry[]): RunEntry | null {
  return entries.length ? entries[entries.length - 1] : null
}

// When a run last actually wrote or confirmed a snapshot. "unchanged" counts: the data was fetched and
// compared, and only the redundant write was skipped. "skipped" does not — nothing was fetched.
export function lastSuccessAt(entries: RunEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.outcome === "captured" || entry.outcome === "unchanged") return entry.finishedAt
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
