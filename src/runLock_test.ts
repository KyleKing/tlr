import { assert, assertEquals } from "@std/assert"
import { acquireLock, lockDecision, MIN_RUN_INTERVAL_MS, parseLock, shouldSkipRun, STALE_LOCK_MS } from "@/runLock.ts"

const NOW = Date.parse("2026-07-24T09:00:00.000Z")

function lockStartedMinutesAgo(minutes: number) {
  return { pid: 4242, startedAt: new Date(NOW - minutes * 60000).toISOString() }
}

Deno.test("lockDecision takes a free lock", () => {
  assertEquals(lockDecision(null, NOW), "acquire")
})

Deno.test("lockDecision waits for a run that is still young", () => {
  assertEquals(lockDecision(lockStartedMinutesAgo(2), NOW), "blocked")
  assertEquals(lockDecision(lockStartedMinutesAgo(29), NOW), "blocked")
})

Deno.test("lockDecision steals a lock left behind by a killed run", () => {
  assertEquals(lockDecision(lockStartedMinutesAgo(STALE_LOCK_MS / 60000), NOW), "steal")
  assertEquals(lockDecision(lockStartedMinutesAgo(600), NOW), "steal")
})

Deno.test("lockDecision honors an explicit staleness window", () => {
  assertEquals(lockDecision(lockStartedMinutesAgo(10), NOW, 5 * 60000), "steal")
  assertEquals(lockDecision(lockStartedMinutesAgo(10), NOW, 60 * 60000), "blocked")
})

Deno.test("parseLock rejects anything it cannot act on", () => {
  assertEquals(parseLock(""), null)
  assertEquals(parseLock("{"), null)
  assertEquals(parseLock('{"pid":"nine","startedAt":"2026-07-24T09:00:00.000Z"}'), null)
  assertEquals(parseLock('{"pid":9,"startedAt":"not a date"}'), null)
  assertEquals(parseLock('{"pid":9,"startedAt":"2026-07-24T09:00:00.000Z"}'), {
    pid: 9,
    startedAt: "2026-07-24T09:00:00.000Z",
  })
})

Deno.test("shouldSkipRun refuses a catch-up run right after a successful one", () => {
  const oneHourAgo = new Date(NOW - 60 * 60000).toISOString()
  assertEquals(shouldSkipRun(oneHourAgo, NOW), true)
})

Deno.test("shouldSkipRun lets the next day's run through", () => {
  const yesterday = new Date(NOW - 24 * 60 * 60000).toISOString()
  const justInside = new Date(NOW - MIN_RUN_INTERVAL_MS).toISOString()
  assertEquals(shouldSkipRun(yesterday, NOW), false)
  assertEquals(shouldSkipRun(justInside, NOW), false)
})

Deno.test("shouldSkipRun runs when nothing has ever succeeded, or the clock moved backwards", () => {
  assertEquals(shouldSkipRun(null, NOW), false)
  assertEquals(shouldSkipRun("not a date", NOW), false)
  assertEquals(shouldSkipRun(new Date(NOW + 60000).toISOString(), NOW), false)
})

Deno.test("acquireLock blocks a second run and releases for the next one", async () => {
  const dir = await Deno.makeTempDir()
  const path = `${dir}/snapshot-run.lock`
  try {
    const release = await acquireLock(path, NOW)
    assert(release)
    assertEquals(await acquireLock(path, NOW), null)
    await release()
    const again = await acquireLock(path, NOW)
    assert(again)
    await again()
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("acquireLock takes over a stale lock file", async () => {
  const dir = await Deno.makeTempDir()
  const path = `${dir}/snapshot-run.lock`
  try {
    await Deno.writeTextFile(path, JSON.stringify(lockStartedMinutesAgo(120)))
    const release = await acquireLock(path, NOW)
    assert(release)
    await release()
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("acquireLock takes over a lock file it cannot read", async () => {
  const dir = await Deno.makeTempDir()
  const path = `${dir}/snapshot-run.lock`
  try {
    await Deno.writeTextFile(path, "half-written")
    const release = await acquireLock(path, NOW)
    assert(release)
    await release()
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
