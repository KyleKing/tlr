import { assertEquals } from "@std/assert"
import { generateSnapshots, type Snapshot } from "@/seed.ts"
import { planPrune, pruneStore, RETENTION } from "@/retention.ts"
import { openStore, type SnapshotRow } from "@/snapshot.ts"

const DAY_MS = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 6, 23, 12)

function row(id: number, ageDays: number, projectKey = "slug:aaa"): SnapshotRow {
  return {
    id,
    capturedAt: NOW - Math.round(ageDays * DAY_MS),
    label: "scheduled",
    projectName: "Horse Tinder",
    projectKey,
    asOf: new Date(NOW - Math.round(ageDays * DAY_MS)).toISOString().slice(0, 10),
    bytes: 175_000,
  }
}

function renamed(snapshot: Snapshot, name: string, url: string): Snapshot {
  return { ...snapshot, project: { ...snapshot.project, name, url } }
}

Deno.test("planPrune keeps every capture inside the recent window", () => {
  const rows = [row(1, 0), row(2, 0.125), row(3, 0.25), row(4, RETENTION.fullDays - 1)]
  assertEquals(planPrune(rows).drop, [])
})

Deno.test("planPrune thins to one a day past the recent window", () => {
  const rows = [
    row(1, 0),
    row(2, RETENTION.fullDays + 1),
    row(3, RETENTION.fullDays + 1.25),
    row(4, RETENTION.fullDays + 1.5),
  ]
  const plan = planPrune(rows)
  assertEquals(plan.drop, [3, 4])
  assertEquals(plan.keep, [1, 2])
  assertEquals(plan.bytesFreedEstimate, 350_000)
})

Deno.test("planPrune thins to one a week past a year", () => {
  const rows = [row(1, 0), row(2, 400), row(3, 401), row(4, 402), row(5, 410)]
  const plan = planPrune(rows)
  assertEquals(plan.keep, [1, 2, 5])
})

Deno.test("planPrune never drops the newest capture of a project", () => {
  const rows = [row(1, 500), row(2, 900, "slug:bbb")]
  assertEquals(planPrune(rows).drop, [])
})

Deno.test("planPrune buckets each project separately", () => {
  const rows = [row(1, 0), row(2, 30), row(3, 30.5), row(4, 0, "slug:bbb"), row(5, 30, "slug:bbb")]
  assertEquals(planPrune(rows).drop, [3])
})

Deno.test("planPrune honours pinned ids", () => {
  const rows = [row(1, 0), row(2, 30), row(3, 30.5)]
  assertEquals(planPrune(rows, { keepIds: [3] }).drop, [])
})

Deno.test("pruneStore dry-runs by default and keeps the review pointer", () => {
  const { a, b } = generateSnapshots()
  const path = Deno.makeTempFileSync({ suffix: ".tlr.sqlite" })
  const store = openStore(path)
  try {
    const old = store.saveSnapshot(a, NOW - 90 * DAY_MS)
    const older = store.saveSnapshot(a, NOW - 90 * DAY_MS - 3600_000)
    const stale = store.saveSnapshot(b, NOW - 60 * DAY_MS)
    const staleToo = store.saveSnapshot(b, NOW - 60 * DAY_MS - 3600_000)
    store.saveSnapshot(b, NOW)
    store.setReviewPointer(older.id)

    const dry = pruneStore(store)
    assertEquals(dry.dryRun, true)
    assertEquals(dry.deleted, 0)
    assertEquals(dry.drop, [staleToo.id])
    assertEquals(store.listSnapshots().length, 5)

    const wet = pruneStore(store, { dryRun: false })
    assertEquals(wet.deleted, 1)
    const left = store.listSnapshots().map((r) => r.id).sort((x, y) => x - y)
    assertEquals(left.includes(older.id), true)
    assertEquals(left.includes(staleToo.id), false)
    assertEquals(left.includes(old.id), true)
    assertEquals(left.includes(stale.id), true)
  } finally {
    store.close()
    Deno.removeSync(path)
  }
})

Deno.test("pruneStore prunes a renamed project as one history", () => {
  const { a } = generateSnapshots()
  const url = "https://linear.app/acme/project/horse-tinder-c0ffee001122"
  const path = Deno.makeTempFileSync({ suffix: ".tlr.sqlite" })
  const store = openStore(path)
  try {
    const first = store.saveSnapshot(renamed(a, "Horse Tinder", url), NOW - 40 * DAY_MS)
    const second = store.saveSnapshot(
      renamed(a, "Pony Match", "https://linear.app/acme/project/pony-match-c0ffee001122"),
      NOW - 40 * DAY_MS + 3600_000,
    )
    store.saveSnapshot(renamed(a, "Pony Match", url), NOW)

    const keys = new Set(store.listSnapshots().map((r) => r.projectKey))
    assertEquals(keys.size, 1)
    assertEquals(pruneStore(store).drop, [first.id])
    assertEquals(second.id > first.id, true)
  } finally {
    store.close()
    Deno.removeSync(path)
  }
})
