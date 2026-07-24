import { expect, test } from "./fixtures.ts"

test("board loads and renders the sample data", async ({ page }) => {
  await page.goto("/")

  await expect(page).toHaveTitle(/planning board/)
  await expect(page.locator("#title")).not.toBeEmpty()
  await expect(page.locator("#summary")).not.toBeEmpty()
  await expect(page.locator("#grid tr").first()).toBeVisible()
})

test("configuration panel opens and closes", async ({ page }) => {
  await page.goto("/")

  await page.click("#config-btn")
  await expect(page.locator("#config-panel")).toBeVisible()

  await page.click("#config-close")
  await expect(page.locator("#config-panel")).toBeHidden()
})
