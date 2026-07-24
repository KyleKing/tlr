import { AxeBuilder } from "@axe-core/playwright"
import { expect, test } from "./fixtures.ts"

// Catches the "selected filter looks the same as unselected" and low-contrast-button class of bugs
// programmatically, instead of relying on someone noticing in a screenshot.
test("board passes automated color-contrast checks", async ({ page }) => {
  await page.goto("/")
  await page.waitForSelector("#grid tr")
  // Press a status and a flag chip so their selected-state colors are part of the scan too.
  await page.click("#status-chips button")
  await page.click("#flag-chips button")

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2aa"])
    .options({ runOnly: { type: "rule", values: ["color-contrast"] } })
    .analyze()

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
})

test("review and changes pages pass automated color-contrast checks", async ({ page }) => {
  for (const path of ["/review", "/changes", "/settings"]) {
    await page.goto(path)
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2aa"])
      .options({ runOnly: { type: "rule", values: ["color-contrast"] } })
      .analyze()
    expect(results.violations, `${path}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([])
  }
})
