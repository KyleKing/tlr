import { assert, assertEquals } from "@std/assert"
import { generateSnapshots } from "@/seed.ts"
import { scanIssues, scanText } from "@/commands/scan.ts"

Deno.test("scanText flags a slop string and returns a stable hash", () => {
  const r = scanText("This will comprehensively leverage a robust, seamless approach; it delves in.")
  assert(r.score >= 2)
  assert(r.flags.length > 0)
  assertEquals(r.hash, scanText("This will comprehensively leverage a robust, seamless approach; it delves in.").hash)
})

Deno.test("scanText on clean text scores low", () => {
  const r = scanText("Add a p99 latency panel and alert when it exceeds 300ms.")
  assertEquals(r.score, 0)
  assertEquals(r.flags, [])
})

Deno.test("scanIssues finds the seeded slop tickets sorted by score", () => {
  const { a } = generateSnapshots()
  const r = scanIssues(a)
  assertEquals(r.total, a.issues.length)
  assert(r.summary.flaggedCount > 0)
  for (const f of r.flagged) assert(f.score >= 2)
  const scores = r.flagged.map((f) => f.score)
  assertEquals(scores, [...scores].sort((x, y) => y - x))
  assertEquals(r.summary.flaggedCount, r.flagged.length)
})
