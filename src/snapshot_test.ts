import { assertEquals, assertThrows } from "@std/assert"
import { DatabaseSync } from "node:sqlite"
import { generateSnapshots, type Snapshot } from "@/seed.ts"
import { openStore } from "@/snapshot.ts"

const SLUG_URL = "https://linear.app/acme/project/horse-tinder-c0ffee001122"

function renamed(snapshot: Snapshot, name: string, url: string): Snapshot {
  return { ...snapshot, project: { ...snapshot.project, name, url } }
}

function withStore(fn: (store: ReturnType<typeof openStore>, path: string) => void): void {
  const path = Deno.makeTempFileSync({ suffix: ".tlr.sqlite" })
  const store = openStore(path)
  try {
    fn(store, path)
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

Deno.test("snapshot store saves, lists, reloads, and round-trips the review pointer", () => {
  const { a, b } = generateSnapshots()
  const path = Deno.makeTempFileSync({ suffix: ".tlr.sqlite" })
  const store = openStore(path)
  try {
    const savedA = store.saveSnapshot(a, 1_700_000_000_000, "before")
    const savedB = store.saveSnapshot(b, 1_700_000_600_000, "after")
    assertEquals(savedA.capturedAt, 1_700_000_000_000)
    assertEquals(savedB.label, "after")

    const rows = store.listSnapshots()
    assertEquals(rows.length, 2)
    assertEquals(rows[0].id, savedB.id)
    assertEquals(rows[0].label, "after")
    assertEquals(rows[0].asOf, b.asOf)
    assertEquals(rows[1].id, savedA.id)
    assertEquals(rows[0].projectName, a.project.name)

    const reloaded = store.loadSnapshot(savedB.id)
    assertEquals(reloaded, b)

    assertEquals(store.getReviewPointer(), null)
    store.setReviewPointer(savedA.id)
    assertEquals(store.getReviewPointer(), savedA.id)
    store.setReviewPointer(savedB.id)
    assertEquals(store.getReviewPointer(), savedB.id)
  } finally {
    store.close()
    Deno.removeSync(path)
  }
})

Deno.test("the store runs in WAL mode so a reader is not blocked by a capture", () => {
  withStore((_store, path) => {
    const db = new DatabaseSync(path)
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
      assertEquals(mode.journal_mode, "wal")
    } finally {
      db.close()
    }
  })
})

Deno.test("a second connection cannot write while a capture holds the transaction", () => {
  const { a } = generateSnapshots()
  withStore((store, path) => {
    const other = new DatabaseSync(path)
    other.exec("PRAGMA busy_timeout = 50")
    try {
      store.transaction(() => {
        store.saveSnapshot(a, 1_700_000_000_000)
        assertThrows(() => other.exec("BEGIN IMMEDIATE"))
      })
      assertEquals(store.listSnapshots().length, 1)
    } finally {
      other.close()
    }
  })
})

Deno.test("transaction rolls back everything a failed capture wrote", () => {
  const { a, b } = generateSnapshots()
  withStore((store) => {
    store.saveSnapshot(a, 1_700_000_000_000, "before")
    assertThrows(() =>
      store.transaction(() => {
        store.saveSnapshot(b, 1_700_000_600_000, "after")
        throw new Error("capture failed")
      })
    )
    assertEquals(store.listSnapshots().length, 1)
  })
})

Deno.test("a renamed project keeps one history under one key", () => {
  const { a } = generateSnapshots()
  withStore((store) => {
    store.saveSnapshot(renamed(a, "Horse Tinder", SLUG_URL), 1_700_000_000_000)
    store.saveSnapshot(
      renamed(a, "Pony Match", "https://linear.app/acme/project/pony-match-c0ffee001122"),
      1_700_000_600_000,
    )
    const key = store.projectKeyForName("Pony Match")!
    assertEquals(key, "slug:c0ffee001122")
    assertEquals(store.listProjectSnapshots(key).length, 2)
  })
})

Deno.test("rows captured before the stable key existed fold into it", () => {
  const { a } = generateSnapshots()
  withStore((store) => {
    store.saveSnapshot(renamed(a, "Horse Tinder", "https://linear.app/acme"), 1_700_000_000_000)
    assertEquals(store.listSnapshots()[0].projectKey, "name:horse tinder")
    store.saveSnapshot(renamed(a, "Horse Tinder", SLUG_URL), 1_700_000_600_000)
    const keys = new Set(store.listSnapshots().map((r) => r.projectKey))
    assertEquals([...keys], ["slug:c0ffee001122"])
  })
})

Deno.test("an existing store missing project_key migrates without losing a row", () => {
  const { a } = generateSnapshots()
  const path = Deno.makeTempFileSync({ suffix: ".tlr.sqlite" })
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at INTEGER NOT NULL,
      label TEXT,
      project_name TEXT NOT NULL,
      as_of TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  legacy.prepare("INSERT INTO snapshots (captured_at, label, project_name, as_of, json) VALUES (?, ?, ?, ?, ?)")
    .run(1_700_000_000_000, "old", a.project.name, a.asOf, JSON.stringify(renamed(a, a.project.name, SLUG_URL)))
  legacy.close()

  const store = openStore(path)
  try {
    const rows = store.listSnapshots()
    assertEquals(rows.length, 1)
    assertEquals(rows[0].projectKey, "slug:c0ffee001122")
    assertEquals(store.loadSnapshot(rows[0].id).issues.length, a.issues.length)
  } finally {
    store.close()
    Deno.removeSync(path)
  }
})

Deno.test("deleteSnapshots refuses the snapshot the review pointer references", () => {
  const { a, b } = generateSnapshots()
  withStore((store) => {
    const first = store.saveSnapshot(a, 1_700_000_000_000)
    const second = store.saveSnapshot(b, 1_700_000_600_000)
    store.setReviewPointer(first.id)
    assertEquals(store.deleteSnapshots([first.id]), 0)
    assertEquals(store.deleteSnapshots([first.id, second.id]), 1)
    assertEquals(store.listSnapshots().map((r) => r.id), [first.id])
  })
})

const OTHER_URL = "https://linear.app/acme/project/other-beef00112233"

function twoProjects(store: ReturnType<typeof openStore>) {
  const { a, b } = generateSnapshots()
  const mine = store.saveSnapshot(renamed(a, a.project.name, SLUG_URL), 1_000)
  const theirs = store.saveSnapshot(renamed(b, "Other", OTHER_URL), 2_000)
  return { mine, mineKey: "slug:c0ffee001122", theirs, theirsKey: "slug:beef00112233" }
}

Deno.test("each project keeps its own review pointer, falling back to the legacy one", () => {
  withStore((store) => {
    const { mine, mineKey, theirs, theirsKey } = twoProjects(store)

    store.setReviewPointer(mine.id, mineKey)
    store.setReviewPointer(theirs.id, theirsKey)
    assertEquals(store.getReviewPointer(mineKey), mine.id)
    assertEquals(store.getReviewPointer(theirsKey), theirs.id)
    assertEquals(store.getReviewPointer("slug:unknown00000000"), null)

    store.setReviewPointer(theirs.id)
    assertEquals(store.getReviewPointer(), theirs.id)
    assertEquals(store.getReviewPointer("slug:unknown00000000"), theirs.id)
    assertEquals(store.getReviewPointer(mineKey), mine.id)
  })
})

Deno.test("deleteSnapshots refuses a snapshot any project's pointer references", () => {
  withStore((store) => {
    const { mine, mineKey, theirs, theirsKey } = twoProjects(store)
    store.setReviewPointer(mine.id, mineKey)
    store.setReviewPointer(theirs.id, theirsKey)

    assertEquals(store.listReviewPointers().sort((x, y) => x - y), [mine.id, theirs.id])
    assertEquals(store.deleteSnapshots([mine.id, theirs.id]), 0)
    assertEquals(store.listSnapshots().length, 2)
  })
})

Deno.test("loadHistoryBefore reads only older captures, newest first, up to the limit", () => {
  const { a, b } = generateSnapshots()
  withStore((store) => {
    store.saveSnapshot(a, 1_000)
    store.saveSnapshot(b, 2_000)
    const latest = store.saveSnapshot(a, 3_000)
    const key = store.listSnapshots().find((r) => r.id === latest.id)!.projectKey

    const history = store.loadHistoryBefore(key, 3_000)
    assertEquals(history.map((s) => s.asOf), [b.asOf, a.asOf])
    assertEquals(store.loadHistoryBefore(key, 3_000, 1).length, 1)
  })
})

// A history forked across two keys for one project: captures keyed by the URL's slugId before ingest
// recorded Linear's project id, then a second run keyed by the id. Opening the store repairs it, so
// the Changes and Review pages stop seeing only half the history.
Deno.test("opening a store merges a project history forked between a slug key and an id key", () => {
  const { a, b } = generateSnapshots()
  const path = Deno.makeTempFileSync({ suffix: ".tlr.sqlite" })
  const legacy = renamed(a, "Platform", SLUG_URL)
  const modern = {
    ...renamed(b, "Platform", SLUG_URL),
    project: { ...b.project, name: "Platform", url: SLUG_URL, id: "uuid-1", slugId: "c0ffee001122" },
  }

  const first = openStore(path)
  const older = first.saveSnapshot(legacy, 1_000)
  first.setReviewPointer(older.id, "slug:c0ffee001122")
  const newer = first.saveSnapshot(modern, 2_000)
  assertEquals(first.listSnapshots().map((r) => r.projectKey), ["id:uuid-1", "slug:c0ffee001122"])
  first.close()

  const reopened = openStore(path)
  try {
    assertEquals(reopened.listSnapshots().map((r) => r.projectKey), ["id:uuid-1", "id:uuid-1"])
    // The pointer follows its history rather than being stranded on the retired key.
    assertEquals(reopened.getReviewPointer("id:uuid-1"), older.id)
    assertEquals(reopened.getReviewPointer("slug:c0ffee001122"), null)
    assertEquals(newer.id > older.id, true)
  } finally {
    reopened.close()
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        Deno.removeSync(`${path}${suffix}`)
      } catch {
        // the wal and shm siblings only exist while the connection is open
      }
    }
  }
})

// Two genuinely different projects that happen to share a display name must not be merged, and a slug
// with nothing linking it to an id keeps its own history.
Deno.test("opening a store leaves an unlinked slug history alone", () => {
  withStore((store) => {
    const { a } = generateSnapshots()
    store.saveSnapshot(renamed(a, "Platform", SLUG_URL), 1_000)
    assertEquals(store.listSnapshots().map((r) => r.projectKey), ["slug:c0ffee001122"])
  })
})
