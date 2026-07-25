import { assert, assertEquals } from "@std/assert"
import {
  appendRunEntry,
  combineOutcomes,
  lastRun,
  lastSuccessAt,
  parseRunLog,
  type ProjectOutcome,
  type ProjectResult,
  RUN_LOG_LIMIT,
  type RunEntry,
  type RunOutcome,
  summarizeResults,
} from "@/runLog.ts"

const RUNS_PER_DAY = 8

function entry(finishedAt: string, outcome: RunOutcome = "captured", detail = ""): RunEntry {
  return { startedAt: finishedAt, finishedAt, durationMs: 1200, outcome, detail }
}

function line(e: RunEntry): string {
  return `${JSON.stringify(e)}\n`
}

Deno.test("parseRunLog reads one entry per line and ignores blank lines", () => {
  const text = `${line(entry("2026-07-20T09:00:00.000Z"))}\n${line(entry("2026-07-21T09:00:00.000Z"))}`
  const entries = parseRunLog(text)
  assertEquals(entries.length, 2)
  assertEquals(entries[1].finishedAt, "2026-07-21T09:00:00.000Z")
})

Deno.test("parseRunLog drops a truncated or malformed line without losing the rest", () => {
  const text = [
    JSON.stringify(entry("2026-07-20T09:00:00.000Z")),
    '{"startedAt":"2026-07-21T09:00:00.000Z","fin',
    JSON.stringify({ startedAt: "x", finishedAt: "y", durationMs: 1, outcome: "captured", detail: "" }),
    JSON.stringify({ startedAt: "2026-07-22T09:00:00.000Z", outcome: "captured" }),
    JSON.stringify({ ...entry("2026-07-23T09:00:00.000Z"), outcome: "exploded" }),
    JSON.stringify(entry("2026-07-24T09:00:00.000Z")),
  ].join("\n")
  assertEquals(parseRunLog(text).map((e) => e.finishedAt), ["2026-07-20T09:00:00.000Z", "2026-07-24T09:00:00.000Z"])
})

Deno.test("appendRunEntry adds one line and round-trips", () => {
  const first = appendRunEntry("", entry("2026-07-20T09:00:00.000Z"))
  const second = appendRunEntry(first, entry("2026-07-21T09:00:00.000Z", "failed", "Linear → 401"))
  const entries = parseRunLog(second)
  assertEquals(entries.length, 2)
  assertEquals(entries[1].outcome, "failed")
  assertEquals(entries[1].detail, "Linear → 401")
  assertEquals(second.endsWith("\n"), true)
})

Deno.test("appendRunEntry caps the log by dropping the oldest entries", () => {
  let text = ""
  for (let i = 0; i < 10; i++) text = appendRunEntry(text, entry(`2026-07-${String(i + 10)}T09:00:00.000Z`), 4)
  const entries = parseRunLog(text)
  assertEquals(entries.length, 4)
  assertEquals(entries[0].finishedAt, "2026-07-16T09:00:00.000Z")
  assertEquals(entries[3].finishedAt, "2026-07-19T09:00:00.000Z")
})

// Eight runs a day, so the cap is what decides how far back the history reaches. A quarter is the
// floor worth keeping: it covers a full set of quarterly cycles.
Deno.test("the log cap holds at least a quarter of history at the scheduled cadence", () => {
  assert(RUN_LOG_LIMIT / RUNS_PER_DAY >= 90)
})

Deno.test("appendRunEntry bounds a runaway detail string", () => {
  const huge = "x".repeat(5000)
  const entries = parseRunLog(appendRunEntry("", entry("2026-07-20T09:00:00.000Z", "failed", huge)))
  assertEquals(entries[0].detail.length, 501)
})

Deno.test("lastRun and lastSuccessAt read from the end, and skipped runs are not successes", () => {
  const text = [
    entry("2026-07-20T09:00:00.000Z", "captured"),
    entry("2026-07-21T09:00:00.000Z", "unchanged"),
    entry("2026-07-22T09:00:00.000Z", "skipped"),
  ].reduce((acc, e) => appendRunEntry(acc, e), "")
  const entries = parseRunLog(text)
  assertEquals(lastRun(entries)?.outcome, "skipped")
  assertEquals(lastSuccessAt(entries), "2026-07-21T09:00:00.000Z")
})

// The minimum-interval gate compares this against the next run's start, so it has to be the previous
// run's start too. Reporting the finish would understate the gap by however long the run took.
Deno.test("lastSuccessAt reports when the run began, not when it ended", () => {
  const slow: RunEntry = {
    startedAt: "2026-07-24T09:00:00.000Z",
    finishedAt: "2026-07-24T09:25:00.000Z",
    durationMs: 1_500_000,
    outcome: "captured",
    detail: "",
  }
  assertEquals(lastSuccessAt([slow]), "2026-07-24T09:00:00.000Z")
})

Deno.test("lastRun and lastSuccessAt on an empty log", () => {
  assertEquals(lastRun([]), null)
  assertEquals(lastSuccessAt([]), null)
})

function result(project: string, outcome: ProjectOutcome, detail = "captured #1"): ProjectResult {
  return { detail, outcome, project }
}

Deno.test("combineOutcomes separates all-succeeded, some-succeeded, and all-failed", () => {
  assertEquals(combineOutcomes([result("a.json", "captured"), result("b.json", "unchanged")]), "captured")
  assertEquals(combineOutcomes([result("a.json", "unchanged"), result("b.json", "unchanged")]), "unchanged")
  assertEquals(combineOutcomes([result("a.json", "captured"), result("b.json", "failed")]), "partial")
  assertEquals(combineOutcomes([result("a.json", "failed"), result("b.json", "failed")]), "failed")
})

Deno.test("combineOutcomes ignores local seeds, and reads a run of nothing else as skipped", () => {
  assertEquals(combineOutcomes([result("seed-b.json", "not-applicable"), result("a.json", "captured")]), "captured")
  assertEquals(combineOutcomes([result("seed-b.json", "not-applicable"), result("a.json", "failed")]), "failed")
  assertEquals(combineOutcomes([result("seed-b.json", "not-applicable")]), "skipped")
  assertEquals(combineOutcomes([]), "failed")
})

Deno.test("summarizeResults names the failing projects first, with the count", () => {
  const detail = summarizeResults([
    result("a.json", "captured", "captured #4"),
    result("b.json", "failed", "Linear → 500"),
    result("seed-b.json", "not-applicable", "local seed, no Linear project"),
  ])
  assertEquals(
    detail,
    "1 of 2 projects failed; b.json: Linear → 500; a.json: captured #4; seed-b.json: local seed, no Linear project",
  )
})

Deno.test("summarizeResults on a clean run is just the per-project lines", () => {
  assertEquals(
    summarizeResults([
      result("a.json", "captured", "captured #4"),
      result("b.json", "unchanged", "unchanged since #2"),
    ]),
    "a.json: captured #4; b.json: unchanged since #2",
  )
})

Deno.test("a partial run does not count as the last success", () => {
  const entries = parseRunLog(
    [entry("2026-07-20T09:00:00.000Z", "captured"), entry("2026-07-21T09:00:00.000Z", "partial")]
      .reduce((acc, e) => appendRunEntry(acc, e), ""),
  )
  assertEquals(lastRun(entries)?.outcome, "partial")
  assertEquals(lastSuccessAt(entries), "2026-07-20T09:00:00.000Z")
})
