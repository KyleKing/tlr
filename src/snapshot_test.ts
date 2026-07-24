import { assertEquals } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { openStore } from "@/snapshot.ts"

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
