import { assert, assertEquals } from "@std/assert"
import {
  acquireLock,
  isSameLock,
  lockDecision,
  MIN_RUN_INTERVAL_MS,
  parseLock,
  shouldSkipRun,
  STALE_LOCK_MS,
} from "@/runLock.ts"

const NOW = Date.parse("2026-07-24T09:00:00.000Z")
const CADENCE_MS = 3 * 60 * 60 * 1000

function lockStartedMinutesAgo(minutes: number) {
  return { pid: 4242, startedAt: new Date(NOW - minutes * 60000).toISOString() }
}

Deno.test("lockDecision takes a free lock", () => {
  assertEquals(lockDecision(null, NOW), "acquire")
})

Deno.test("lockDecision waits for a run that is still young", () => {
  assertEquals(lockDecision(lockStartedMinutesAgo(2), NOW), "blocked")
  assertEquals(lockDecision(lockStartedMinutesAgo(STALE_LOCK_MS / 60000 - 1), NOW), "blocked")
})

Deno.test("lockDecision steals a lock left behind by a killed run", () => {
  assertEquals(lockDecision(lockStartedMinutesAgo(STALE_LOCK_MS / 60000), NOW), "steal")
  assertEquals(lockDecision(lockStartedMinutesAgo(600), NOW), "steal")
})

// The staleness window has to clear a bounded worst-case run without touching a live one, and has to
// expire before the next scheduled run arrives, or a wedged lock blocks that run instead of being
// taken from it.
Deno.test("the staleness window outlasts a slow run and expires inside one three-hour window", () => {
  const worstCaseRunMs = 50 * 105_000
  assert(STALE_LOCK_MS > worstCaseRunMs)
  assert(STALE_LOCK_MS < CADENCE_MS)
  assertEquals(lockDecision(lockStartedMinutesAgo(CADENCE_MS / 60000), NOW), "steal")
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

Deno.test("shouldSkipRun lets the next scheduled run through", () => {
  const yesterday = new Date(NOW - 24 * 60 * 60000).toISOString()
  const justInside = new Date(NOW - MIN_RUN_INTERVAL_MS).toISOString()
  assertEquals(shouldSkipRun(yesterday, NOW), false)
  assertEquals(shouldSkipRun(justInside, NOW), false)
})

// The gate exists to swallow a wake catch-up, not a scheduled run. It is measured start-to-start, so
// the margin below the cadence only has to absorb launchd firing late, and an hour of it is plenty.
Deno.test("the minimum interval clears every scheduled run and still swallows a catch-up", () => {
  assert(MIN_RUN_INTERVAL_MS < CADENCE_MS)
  assert(CADENCE_MS - MIN_RUN_INTERVAL_MS >= 60 * 60000)
  const onCadence = new Date(NOW - CADENCE_MS).toISOString()
  const catchUpMinutesLater = new Date(NOW - 4 * 60000).toISOString()
  assertEquals(shouldSkipRun(onCadence, NOW), false)
  assertEquals(shouldSkipRun(catchUpMinutesLater, NOW), true)
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

Deno.test("isSameLock only matches the exact holder", () => {
  const owner = { pid: 7, startedAt: "2026-07-24T09:00:00.000Z" }
  assertEquals(isSameLock(owner, owner), true)
  assertEquals(isSameLock(null, owner), false)
  assertEquals(isSameLock({ pid: 8, startedAt: owner.startedAt }, owner), false)
  assertEquals(isSameLock({ pid: 7, startedAt: "2026-07-24T10:00:00.000Z" }, owner), false)
})

// The case that goes wrong with an unconditional remove: the robbed run finishes first and frees the
// thief's lock, so a third run starts beside a run that is still writing.
Deno.test("a run whose lock was stolen does not release the lock that replaced it", async () => {
  const dir = await Deno.makeTempDir()
  const path = `${dir}/snapshot-run.lock`
  try {
    const robbed = await acquireLock(path, NOW - 2 * 60 * 60000)
    assert(robbed)
    const thief = await acquireLock(path, NOW)
    assert(thief)

    await robbed()
    assertEquals(parseLock(await Deno.readTextFile(path))?.startedAt, new Date(NOW).toISOString())
    assertEquals(await acquireLock(path, NOW), null)

    await thief()
    assertEquals(await Deno.stat(path).then(() => true).catch(() => false), false)
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
