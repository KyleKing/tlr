// Single-instance guard and redundancy guard for the scheduled snapshot run.
//
// launchd fires a missed StartCalendarInterval on wake and coalesces several missed ones into a single
// run, so two things can happen that a plain "fetch and write" entry point handles badly: a catch-up
// run landing while a run started by hand is still going, and a catch-up run landing minutes after a
// successful one. The lock covers the first, the minimum interval the second.
//
// Both decisions are pure functions of a timestamp so they can be tested without a clock or a file.
// Staleness is time-based rather than a liveness probe on the recorded pid: checking a pid needs a
// signal permission the task does not otherwise want, and a run that has been holding the lock for
// half an hour is wedged whether its process still exists or not.

export const MIN_RUN_INTERVAL_MS = 12 * 60 * 60 * 1000
export const STALE_LOCK_MS = 30 * 60 * 1000

export type LockInfo = { pid: number; startedAt: string }
export type LockDecision = "acquire" | "blocked" | "steal"

export function parseLock(text: string): LockInfo | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const raw = parsed as Record<string, unknown>
  if (typeof raw.pid !== "number" || typeof raw.startedAt !== "string") return null
  if (Number.isNaN(Date.parse(raw.startedAt))) return null
  return { pid: raw.pid, startedAt: raw.startedAt }
}

// An unreadable lock file counts as stale: it cannot name a run to wait for, and leaving it in place
// would wedge every future run.
export function lockDecision(
  lock: LockInfo | null,
  nowMs: number,
  staleAfterMs: number = STALE_LOCK_MS,
): LockDecision {
  if (!lock) return "acquire"
  const age = nowMs - Date.parse(lock.startedAt)
  return age >= staleAfterMs ? "steal" : "blocked"
}

// Whether a run this soon after the last successful one would only write what is already stored.
export function shouldSkipRun(
  lastSuccessAt: string | null,
  nowMs: number,
  minIntervalMs: number = MIN_RUN_INTERVAL_MS,
): boolean {
  if (!lastSuccessAt) return false
  const since = nowMs - Date.parse(lastSuccessAt)
  if (Number.isNaN(since) || since < 0) return false
  return since < minIntervalMs
}

export type ReleaseLock = () => Promise<void>

// Take the lock, or return null when a live run already holds it. Creating the file with `createNew`
// is the atomic step: two runs racing here cannot both succeed, and the loser then decides on the age
// of what it found. Do not reuse the returned release after calling it.
export async function acquireLock(path: string, nowMs: number = Date.now()): Promise<ReleaseLock | null> {
  const body = `${JSON.stringify({ pid: Deno.pid, startedAt: new Date(nowMs).toISOString() })}\n`
  const release: ReleaseLock = () => Deno.remove(path).catch(() => {})

  try {
    await Deno.writeTextFile(path, body, { createNew: true })
    return release
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err
  }

  const existing = parseLock(await Deno.readTextFile(path).catch(() => ""))
  if (lockDecision(existing, nowMs) === "blocked") return null
  await Deno.writeTextFile(path, body)
  return release
}
