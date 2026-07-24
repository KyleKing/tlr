import { expect, test } from "./fixtures.ts"

test("board loads and renders the sample data", async ({ page }) => {
  await page.goto("/")

  await expect(page).toHaveTitle(/planning board/)
  await expect(page.locator("#title")).not.toBeEmpty()
  await expect(page.locator("#summary")).not.toBeEmpty()
  await expect(page.locator("#grid tr").first()).toBeVisible()
})

test("the board's Configure link opens the Settings page", async ({ page }) => {
  await page.goto("/")

  await page.click("#config-btn")
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.locator(".cfg-nav")).toBeVisible()
})

test("shows the sample-data banner when the project data file is missing", async ({ page }) => {
  // force the project's own data files to 404 so loadData falls back to data-sample.json
  await page.route("**/data/**", (route) => route.fulfill({ status: 404, body: "" }))
  await page.goto("/")

  const banner = page.locator("#freshness")
  await expect(banner).toBeVisible()
  await expect(banner).toHaveClass(/sample/)
  await expect(banner).toContainText("sample data")
})

test("grid tickets are keyboard reachable and arrow-navigable", async ({ page }) => {
  await page.goto("/")

  const first = page.locator("#grid [data-id]").first()
  await expect(first).toHaveAttribute("role", "button")
  await expect(first).toHaveAttribute("aria-label", /.+/)

  const firstId = await first.getAttribute("data-id")
  await first.focus()
  await page.keyboard.press("ArrowRight")
  const focusedId = await page.evaluate(() => document.activeElement?.getAttribute("data-id"))
  expect(focusedId).not.toBe(firstId)
})
