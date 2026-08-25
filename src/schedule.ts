// Health of the scheduled snapshot run, for the server route the board's banner reads.
//
// The schedule is a per-user launchd LaunchAgent (see scripts/schedule.sh and ADR 0008), so "is it
// installed" is answered by the presence of its plist in ~/Library/LaunchAgents. Not installed is the
// normal state, not a fault: the banner stays away until someone opts in and a run then fails or the
// last good one falls too far behind.
//
// scheduleHealth is pure so every state is testable off a fixed clock.

import { lastRun, lastSuccessAt, type RunEntry } from "@/runLog.ts"

export const SCHEDULE_LABEL = "me.kyleking.tlr.snapshot"

export const DEFAULT_CADENCE_HOURS = 3

// Four missed runs, and never less than half a day: a laptop closed overnight would otherwise raise a
// banner every morning, before the wake catch-up run has had a chance to clear it.
export const STALE_AFTER_MS = 12 * 60 * 60 * 1000

export type ScheduleState = "failed" | "never-run" | "ok" | "partial" | "stale" | "unscheduled"

export type ScheduleHealth = {
  state: ScheduleState
  lastRun: RunEntry | null
  lastSuccessAt: string | null
  message: string | null
}

export type HealthInput = {
  entries: RunEntry[]
  installed: boolean
  nowMs: number
  cadenceHours?: number
  staleAfterMs?: number
}

export function plistPath(home: string): string {
  return `${home}/Library/LaunchAgents/${SCHEDULE_LABEL}.plist`
}

export async function isScheduleInstalled(): Promise<boolean> {
  return (await installedCadenceHours()) !== null
}

/** How often the installed agent runs, or null when nothing is installed. */
export async function installedCadenceHours(): Promise<number | null> {
  const home = Deno.env.get("HOME")
  if (!home) return null
  const plist = await Deno.readTextFile(plistPath(home)).catch(() => null)
  return plist === null ? null : cadenceHoursFromPlist(plist)
}

// The agent schedules one calendar interval per run of the day, so the count of them is the cadence.
export function cadenceHoursFromPlist(plist: string): number {
  const runs = plist.match(/<key>Hour<\/key>/g)?.length ?? 0
  return runs > 0 && 24 % runs === 0 ? 24 / runs : DEFAULT_CADENCE_HOURS
}

export function cadencePhrase(hours: number): string {
  return hours === 1 ? "every hour" : `every ${hours} hours`
}

export function staleAfterFor(cadenceHours: number): number {
  return Math.max(STALE_AFTER_MS, 4 * cadenceHours * 60 * 60 * 1000)
}

// Coarse on purpose: the banner needs "when, roughly", and a precise duration would only invite the
// reader to compare it against a wall clock in another timezone.
export function relativeTime(thenIso: string, nowMs: number): string {
  const diff = nowMs - Date.parse(thenIso)
  if (Number.isNaN(diff)) return "at an unknown time"
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

function failedMessage(entry: RunEntry, nowMs: number): string {
  const when = relativeTime(entry.finishedAt, nowMs)
  return entry.detail
    ? `The scheduled snapshot failed ${when}: ${entry.detail}`
    : `The scheduled snapshot failed ${when}.`
}

// A partial run captured some projects and lost others, so the wording has to name the part that
// failed without implying the run as a whole did. The detail already lists which projects and why.
function partialMessage(entry: RunEntry, nowMs: number): string {
  const when = relativeTime(entry.finishedAt, nowMs)
  return entry.detail
    ? `Some projects failed in the scheduled snapshot ${when}: ${entry.detail}`
    : `Some projects failed in the scheduled snapshot ${when}.`
}

function staleMessage(successAt: string | null, nowMs: number, cadenceHours: number): string {
  const cadence = cadencePhrase(cadenceHours)
  return successAt
    ? `No snapshot has been captured since ${relativeTime(successAt, nowMs)}, though the snapshot runs ${cadence}.`
    : `The snapshot is scheduled ${cadence} but has never captured anything.`
}

export function scheduleHealth(
  { entries, installed, nowMs, cadenceHours = DEFAULT_CADENCE_HOURS, staleAfterMs = staleAfterFor(cadenceHours) }:
    HealthInput,
): ScheduleHealth {
  const latest = lastRun(entries)
  const successAt = lastSuccessAt(entries)
  const quiet = (state: ScheduleState): ScheduleHealth => ({
    state,
    lastRun: latest,
    lastSuccessAt: successAt,
    message: null,
  })

  if (!installed) return quiet("unscheduled")
  if (!latest) return quiet("never-run")
  if (latest.outcome === "failed") {
    return { state: "failed", lastRun: latest, lastSuccessAt: successAt, message: failedMessage(latest, nowMs) }
  }
  if (latest.outcome === "partial") {
    return { state: "partial", lastRun: latest, lastSuccessAt: successAt, message: partialMessage(latest, nowMs) }
  }
  if (!successAt || nowMs - Date.parse(successAt) >= staleAfterMs) {
    return {
      state: "stale",
      lastRun: latest,
      lastSuccessAt: successAt,
      message: staleMessage(successAt, nowMs, cadenceHours),
    }
  }
  return quiet("ok")
}
