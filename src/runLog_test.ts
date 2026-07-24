import { assertEquals } from "@std/assert"
import { appendRunEntry, lastRun, lastSuccessAt, parseRunLog, type RunEntry, type RunOutcome } from "@/runLog.ts"

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

Deno.test("lastRun and lastSuccessAt on an empty log", () => {
  assertEquals(lastRun([]), null)
  assertEquals(lastSuccessAt([]), null)
})
