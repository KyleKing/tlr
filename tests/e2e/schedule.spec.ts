import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.ts"

// The health payload the server would build from a run log whose last entry failed. Stubbed rather
// than written to disk so the test does not depend on a LaunchAgent existing on the machine running it
// — the e2e machine has none, which is exactly the second case below.
const FAILED_HEALTH = {
  state: "failed",
  lastRun: {
    startedAt: "2026-07-24T09:00:00.000Z",
    finishedAt: "2026-07-24T09:00:04.000Z",
    durationMs: 4000,
    outcome: "failed",
    detail: "Linear → 401 Unauthorized",
  },
  lastSuccessAt: "2026-07-22T09:00:04.000Z",
  message: "The scheduled snapshot failed 2 hours ago: Linear → 401 Unauthorized",
}

function stubHealth(page: Page, health: unknown) {
  return page.route("**/api/schedule/health", (route) => route.fulfill({ json: health }))
}

test("a failed scheduled run raises a dismissible banner", async ({ page }) => {
  await stubHealth(page, FAILED_HEALTH)
  await page.goto("/")

  const banner = page.locator("#schedule-notice")
  await expect(banner).toBeVisible()
  await expect(banner).toContainText("The scheduled snapshot failed")
  await expect(banner).toContainText("Linear → 401 Unauthorized")

  await banner.locator(".schedule-notice-dismiss").click()
  await expect(banner).toHaveCount(0)

  // Dismissal sticks for that run, so the banner does not come back on the next page.
  await page.goto("/review")
  await expect(page.locator("#schedule-notice")).toHaveCount(0)
})

test("no banner when nothing is scheduled, which is the normal state", async ({ page }) => {
  await stubHealth(page, { state: "unscheduled", lastRun: null, lastSuccessAt: null, message: null })
  await page.goto("/")
  await page.waitForSelector("#grid tr")
  await expect(page.locator("#schedule-notice")).toHaveCount(0)
})

// Unstubbed. The state depends on whether whoever runs this installed the schedule, so assert the
// contract instead: the route answers a state the banner knows, and an uninstalled schedule says
// nothing at all.
test("the real health route answers without a run log or a LaunchAgent", async ({ page }) => {
  const health = await page.request.get("/api/schedule/health").then((r) => r.json())
  expect(["failed", "never-run", "ok", "stale", "unscheduled"]).toContain(health.state)
  if (health.state === "unscheduled") expect(health.message).toBeNull()
})
