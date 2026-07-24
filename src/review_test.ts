import { assertEquals } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { reviewSince } from "@/review.ts"

Deno.test("reviewSince windows the two snapshots", () => {
  const { a, b } = generateSnapshots()
  const queue = reviewSince(a, b)
  assertEquals(queue.window, { from: a.asOf, to: b.asOf })
})

Deno.test("reviewSince surfaces the added issues", () => {
  const { a, b } = generateSnapshots()
  const queue = reviewSince(a, b)
  const added = queue.items.filter((i) => i.kind === "added").map((i) => i.id)
  assertEquals(added.includes("SEED-133"), true)
  assertEquals(added.includes("SEED-134"), true)
})

Deno.test("reviewSince flags the slop ticket", () => {
  const { a, b } = generateSnapshots()
  const queue = reviewSince(a, b)
  const slop = queue.items.filter((i) => i.kind === "slop").map((i) => i.id)
  assertEquals(slop.includes("SEED-134"), true)
})

Deno.test("reviewSince stays sorted by id", () => {
  const { a, b } = generateSnapshots()
  const queue = reviewSince(a, b)
  const ids = queue.items.map((i) => i.id)
  assertEquals(ids, [...ids].sort())
})
