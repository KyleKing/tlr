import { assert, assertEquals } from "@std/assert"
import type { RunEntry, RunOutcome } from "@/runLog.ts"
import { plistPath, relativeTime, SCHEDULE_LABEL, scheduleHealth, STALE_AFTER_MS } from "@/schedule.ts"

const NOW = Date.parse("2026-07-24T09:00:00.000Z")

function entry(hoursAgo: number, outcome: RunOutcome, detail = ""): RunEntry {
  const finishedAt = new Date(NOW - hoursAgo * 3600000).toISOString()
  return { startedAt: finishedAt, finishedAt, durationMs: 900, outcome, detail }
}

Deno.test("scheduleHealth stays quiet when no schedule is installed, even after a failure", () => {
  const health = scheduleHealth({ entries: [entry(1, "failed", "Linear → 401")], installed: false, nowMs: NOW })
  assertEquals(health.state, "unscheduled")
  assertEquals(health.message, null)
})

Deno.test("scheduleHealth stays quiet on a fresh install with no runs yet", () => {
  const health = scheduleHealth({ entries: [], installed: true, nowMs: NOW })
  assertEquals(health.state, "never-run")
  assertEquals(health.message, null)
})

Deno.test("scheduleHealth stays quiet after a recent success", () => {
  const health = scheduleHealth({ entries: [entry(3, "captured")], installed: true, nowMs: NOW })
  assertEquals(health.state, "ok")
  assertEquals(health.message, null)
})

// Four missed runs at the three-hour cadence, and long enough that a laptop shut overnight does not
// raise a banner before its wake catch-up run clears it.
Deno.test("the staleness window spans several missed runs without tripping on a night's sleep", () => {
  assertEquals(STALE_AFTER_MS / 3600000, 12)
  assertEquals(scheduleHealth({ entries: [entry(11, "captured")], installed: true, nowMs: NOW }).state, "ok")
  assertEquals(scheduleHealth({ entries: [entry(13, "captured")], installed: true, nowMs: NOW }).state, "stale")
})

Deno.test("scheduleHealth says which part of a partial run failed, not that the run failed", () => {
  const health = scheduleHealth({
    entries: [entry(4, "captured"), entry(1, "partial", "1 of 2 projects failed; b.json: Linear → 500")],
    installed: true,
    nowMs: NOW,
  })
  assertEquals(health.state, "partial")
  assert(health.message?.startsWith("Some projects failed in the scheduled snapshot 1 hour ago"))
  assert(health.message?.includes("b.json: Linear → 500"))
  assertEquals(health.lastSuccessAt, entry(4, "captured").finishedAt)
})

Deno.test("scheduleHealth names the failure and when it happened", () => {
  const health = scheduleHealth({
    entries: [entry(30, "captured"), entry(2, "failed", "Linear → 401 Unauthorized")],
    installed: true,
    nowMs: NOW,
  })
  assertEquals(health.state, "failed")
  assert(health.message?.includes("2 hours ago"))
  assert(health.message?.includes("Linear → 401 Unauthorized"))
  assertEquals(health.lastSuccessAt, entry(30, "captured").finishedAt)
})

Deno.test("scheduleHealth reports a stale store when the last success fell too far behind", () => {
  const health = scheduleHealth({
    entries: [entry(STALE_AFTER_MS / 3600000 + 6, "captured"), entry(1, "skipped", "lock held")],
    installed: true,
    nowMs: NOW,
  })
  assertEquals(health.state, "stale")
  assert(health.message?.includes("18 hours ago"))
})

Deno.test("scheduleHealth reports stale when every run so far refused to do anything", () => {
  const health = scheduleHealth({ entries: [entry(1, "skipped", "lock held")], installed: true, nowMs: NOW })
  assertEquals(health.state, "stale")
  assertEquals(health.lastSuccessAt, null)
  assert(health.message?.includes("never captured"))
})

Deno.test("relativeTime rounds to the largest sensible unit", () => {
  assertEquals(relativeTime(new Date(NOW - 20000).toISOString(), NOW), "just now")
  assertEquals(relativeTime(new Date(NOW - 60000).toISOString(), NOW), "1 minute ago")
  assertEquals(relativeTime(new Date(NOW - 45 * 60000).toISOString(), NOW), "45 minutes ago")
  assertEquals(relativeTime(new Date(NOW - 3600000).toISOString(), NOW), "1 hour ago")
  assertEquals(relativeTime(new Date(NOW - 5 * 86400000).toISOString(), NOW), "5 days ago")
  assertEquals(relativeTime("nonsense", NOW), "at an unknown time")
})

Deno.test("plistPath sits under the user's LaunchAgents directory", () => {
  assertEquals(plistPath("/Users/example"), `/Users/example/Library/LaunchAgents/${SCHEDULE_LABEL}.plist`)
})
