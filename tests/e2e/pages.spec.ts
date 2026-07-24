import { expect, test } from "./fixtures.ts"

test("changes page renders the weekly report from two snapshots", async ({ page }) => {
  await page.goto("/changes")

  await expect(page.locator("h1")).toContainText("Changes")
  // shipped, moved, at risk
  await expect(page.locator(".rsec")).toHaveCount(3)
  await expect(page.locator(".page-body")).toContainText("SEED-101")
  await expect(page.locator(".rsec li.risk").first()).toBeVisible()
})

test("review page groups changes by ticket and marks them reviewed", async ({ page }) => {
  await page.goto("/review")

  const groups = page.locator(".rgroup")
  await expect(groups.first()).toBeVisible()
  const count = await groups.count()
  expect(count).toBeGreaterThan(0)

  await page.locator("button[data-id]").first().click()
  await expect(page.locator(".rgroup.reviewed")).toHaveCount(1)
})

test("nav moves between board, changes, and review", async ({ page }) => {
  await page.goto("/")
  await page.click(".topnav a[href='/changes']")
  await expect(page).toHaveURL(/\/changes$/)
  await page.click(".topnav a[href='/review']")
  await expect(page).toHaveURL(/\/review$/)
})
