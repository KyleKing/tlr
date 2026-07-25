// The Review page's window is the review pointer to the newest capture, not the last two captures.
// These cover how the anchor is chosen, which is what decides whether a change you never looked at
// stays in the queue or falls out of it: the pointer's own row when it is still there, and the
// project's oldest capture when it is not (a first run, a pruned pointer, or a legacy pointer another
// project left behind before pointers were per-project).

import { assertEquals } from "@std/assert"
import { generateSnapshots, type Snapshot } from "@/seed.ts"
import { openStore, type SnapshotStore } from "@/snapshot.ts"
import { projectRows, reviewAnchor } from "../scripts/serve.ts"

const HOUR_MS = 3600 * 1000
const SLUG_URL = "https://linear.app/acme/project/horse-tinder-c0ffee001122"
const START_MS = 1_700_000_000_000

function named(snapshot: Snapshot, name: string, url = SLUG_URL): Snapshot {
  return { ...snapshot, project: { ...snapshot.project, name, url } }
}

function withStore(fn: (store: SnapshotStore) => void): void {
  const path = Deno.makeTempFileSync({ suffix: ".tlr.sqlite" })
  const store = openStore(path)
  try {
    fn(store)
  } finally {
    store.close()
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        Deno.removeSync(`${path}${suffix}`)
      } catch {
        // the wal and shm siblings only exist while the connection is open
      }
    }
  }
}

// Eight captures a day, the schedule this window has to survive.
function captureDay(store: SnapshotStore, snapshot: Snapshot): number[] {
  return Array.from(
    { length: 8 },
    (_, i) => store.saveSnapshot(snapshot, START_MS + i * 3 * HOUR_MS, `run-${i}`).id,
  )
}

Deno.test("with no pointer the window opens at the project's oldest capture, not the previous one", () => {
  withStore((store) => {
    const { a } = generateSnapshots()
    const ids = captureDay(store, a)
    const rows = projectRows(store, a.project.name)

    assertEquals(rows.length, 8)
    assertEquals(rows[0].id, ids[7])
    assertEquals(reviewAnchor(store, rows).id, ids[0])
  })
})

Deno.test("the pointer anchors the window, so unreviewed captures accumulate behind it", () => {
  withStore((store) => {
    const { a } = generateSnapshots()
    const ids = captureDay(store, a)
    store.setReviewPointer(ids[2])
    const rows = projectRows(store, a.project.name)

    assertEquals(reviewAnchor(store, rows).id, ids[2])

    store.setReviewPointer(ids[6])
    assertEquals(reviewAnchor(store, projectRows(store, a.project.name)).id, ids[6])
  })
})

Deno.test("a pruned pointer falls back to the oldest surviving capture instead of throwing", () => {
  withStore((store) => {
    const { a } = generateSnapshots()
    const ids = captureDay(store, a)
    store.setReviewPointer(ids[3])
    store.setReviewPointer(ids[7])
    assertEquals(store.deleteSnapshots([ids[3]]), 1)

    store.setReviewPointer(ids[3])
    const rows = projectRows(store, a.project.name)
    assertEquals(reviewAnchor(store, rows).id, ids[0])
  })
})

Deno.test("a pointer left by another project is ignored rather than diffed across projects", () => {
  withStore((store) => {
    const { a } = generateSnapshots()
    const other = named(a, "Other Project", "https://linear.app/acme/project/other-abcdef001122")
    const mine = captureDay(store, a)
    const theirs = store.saveSnapshot(other, START_MS + 30 * HOUR_MS, "other").id
    store.setReviewPointer(theirs)

    const rows = projectRows(store, a.project.name)
    assertEquals(rows.some((r) => r.id === theirs), false)
    assertEquals(reviewAnchor(store, rows).id, mine[0])
  })
})

Deno.test("switching projects keeps each project's own pointer instead of restarting its queue", () => {
  withStore((store) => {
    const { a } = generateSnapshots()
    const other = named(a, "Other Project", "https://linear.app/acme/project/other-abcdef001122")
    const mine = captureDay(store, named(a, a.project.name))
    const theirs = captureDay(store, other)
    const myRows = projectRows(store, a.project.name)
    const theirRows = projectRows(store, "Other Project")
    store.setReviewPointer(mine[4], myRows[0].projectKey)
    store.setReviewPointer(theirs[5], theirRows[0].projectKey)

    assertEquals(reviewAnchor(store, myRows).id, mine[4])
    assertEquals(reviewAnchor(store, theirRows).id, theirs[5])
  })
})

Deno.test("a renamed project keeps one history, so the window does not restart at the rename", () => {
  withStore((store) => {
    const { a } = generateSnapshots()
    const before = named(a, "Original")
    const ids = captureDay(store, before)
    const later = store.saveSnapshot(named(a, "Renamed"), START_MS + 30 * HOUR_MS).id

    const rows = projectRows(store, "Renamed")
    assertEquals(rows[0].id, later)
    assertEquals(reviewAnchor(store, rows).id, ids[0])
  })
})
