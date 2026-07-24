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

  await page.locator("button[data-review]").first().click()
  await expect(page.locator(".rgroup.reviewed")).toHaveCount(1)
})

test("review page edits a ticket: form pre-fills, previews a dry run, and guards apply without a Linear link", async ({ page }) => {
  await page.goto("/review")

  await page.locator("button[data-edit]").first().click()
  const form = page.locator("form.editf").first()
  await expect(form).toBeVisible()

  // The form starts from the ticket's current values.
  const title = form.locator('input[name="title"]')
  await expect(title).not.toHaveValue("")
  await title.fill("A clearer title")

  // Preview is a dry run: it reports the change without writing.
  await form.locator('[data-act="preview"]').click()
  await expect(form.locator(".editf-out")).toContainText("title →")

  // Seed data carries no Linear UUID, so a write is refused and apply stays disabled.
  await expect(form.locator(".editf-warn")).toBeVisible()
  await expect(form.locator('[data-act="apply"]')).toBeDisabled()
})

test("settings page switches panes and saves the capacity block", async ({ page }) => {
  await page.goto("/settings")

  // appearance pane is open first, with the theme pickers rendered
  await expect(page.locator("#flavor-picker .flavor-btn").first()).toBeVisible()

  // switching panes hides the others
  await page.click('.cfg-nav-item[data-pane="capacity"]')
  await expect(page.locator('.cfg-pane[data-pane="capacity"]')).toBeVisible()
  await expect(page.locator('.cfg-pane[data-pane="appearance"]')).toBeHidden()

  // save writes back and reports it
  await page.click("#cfg-save")
  await expect(page.locator("#cfg-status")).toHaveText("Saved")
})

test("nav moves between board, changes, review, and settings", async ({ page }) => {
  await page.goto("/")
  await page.click(".topnav a[href='/changes']")
  await expect(page).toHaveURL(/\/changes$/)
  await page.click(".topnav a[href='/review']")
  await expect(page).toHaveURL(/\/review$/)
  await page.click(".topnav a[href='/settings']")
  await expect(page).toHaveURL(/\/settings$/)
})
