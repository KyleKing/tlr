// Single-instance guard and redundancy guard for the scheduled snapshot run.
//
// launchd fires a missed StartCalendarInterval on wake and coalesces several missed ones into a single
// run, so two things can happen that a plain "fetch and write" entry point handles badly: a catch-up
// run landing while a run started by hand is still going, and a catch-up run landing minutes after a
// successful one. The lock covers the first, the minimum interval the second.
//
// Both decisions are pure functions of a timestamp so they can be tested without a clock or a file.
// Staleness is time-based rather than a liveness probe on the recorded pid: checking a pid needs a
// signal permission the task does not otherwise want, and a run that has held the lock for longer than
// any bounded run can take is wedged whether its process still exists or not.
//
// Both windows are sized against the three-hour schedule (scripts/schedule.sh):
//
// - MIN_RUN_INTERVAL_MS has to sit below the cadence with room to spare, or a legitimate scheduled run
//   is intermittently skipped. It is measured start-to-start (see lastSuccessAt in runLog.ts), so the
//   only shortfall against a true three-hour gap is launchd's own lateness.
// - STALE_LOCK_MS has to sit above the worst-case duration of a live run, or a run still fetching gets
//   its lock stolen, and below the cadence, so the next scheduled run clears a wedged lock instead of
//   being blocked by it. Every Linear read is bounded by src/httpRetry.ts at three attempts, a 15s
//   per-attempt timeout, and two backoffs capped at 30s each: 105s per call at the very worst, so 90
//   minutes covers roughly fifty calls in one run.

export const MIN_RUN_INTERVAL_MS = 2 * 60 * 60 * 1000
export const STALE_LOCK_MS = 90 * 60 * 1000

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

// Whether the lock on disk is still the one this holder wrote. A steal overwrites the file, so the
// robbed holder has to recognize that the lock it is about to drop belongs to someone else.
export function isSameLock(lock: LockInfo | null, owner: LockInfo): boolean {
  return lock !== null && lock.pid === owner.pid && lock.startedAt === owner.startedAt
}

// Release only what this holder still owns. Without the check, a stolen-from run finishing first would
// free the thief's lock and let a third run start beside it. The read and the remove are not one atomic
// step, so a steal landing between them still loses the new lock file; that window is milliseconds
// wide, against a steal window measured in tens of minutes.
async function releaseOwnedLock(path: string, owner: LockInfo): Promise<void> {
  const current = parseLock(await Deno.readTextFile(path).catch(() => ""))
  if (!isSameLock(current, owner)) return
  await Deno.remove(path).catch(() => {})
}

// Take the lock, or return null when a live run already holds it. Creating the file with `createNew`
// is the atomic step: two runs racing here cannot both succeed, and the loser then decides on the age
// of what it found. Do not reuse the returned release after calling it.
export async function acquireLock(path: string, nowMs: number = Date.now()): Promise<ReleaseLock | null> {
  const owner: LockInfo = { pid: Deno.pid, startedAt: new Date(nowMs).toISOString() }
  const body = `${JSON.stringify(owner)}\n`
  const release: ReleaseLock = () => releaseOwnedLock(path, owner)

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
