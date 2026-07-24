import { expect, test } from "@playwright/test"

// Capture the two seed snapshots (older first, so the drifted one is newest) into the isolated e2e
// store, giving the Changes and Review pages a real before/after to diff. No Linear connection: this
// posts the committed seed data files that `deno task seed` wrote.
test("seed snapshot history", async ({ request }) => {
  for (const [dataFile, label] of [["seed-a.json", "a"], ["seed-b.json", "b"]]) {
    const res = await request.post("/api/snapshot", { data: { dataFile, label } })
    expect(res.ok()).toBeTruthy()
  }
})
