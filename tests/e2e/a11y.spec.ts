import { AxeBuilder } from "@axe-core/playwright"
import { expect, stubBoard, test } from "./fixtures.ts"

// Catches the "selected filter looks the same as unselected" and low-contrast-button class of bugs
// programmatically, instead of relying on someone noticing in a screenshot.
test("board passes automated color-contrast checks", async ({ page }) => {
  await page.goto("/")
  await page.waitForSelector("#grid tr")
  // Press a status chip and a flag checkbox so their selected-state colors are part of the scan too.
  await page.click("#status-chips button")
  await page.click("#fsel-btn")
  await page.click("#flag-list input[type=checkbox]")

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2aa"])
    .options({ runOnly: { type: "rule", values: ["color-contrast"] } })
    .analyze()

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
})

// What-if mode paints a banner, a tag pill, and a delta table whose landing and shift cells carry the
// early/late slip colors, none of which exist until the mode is on and an overlay is in play.
test("board what-if mode passes automated color-contrast checks", async ({ page }) => {
  await stubBoard(page)
  await page.goto("/")
  await page.waitForSelector("#grid tr")
  await page.click("#whatif-btn")
  await page.locator('td[data-name="Ada Lovelace"][data-cycle="48"]').click({ button: "right" })
  await page.locator("#ov-outdays").fill("5")
  await page.locator('#ov-popup [data-act="save"]').click()
  await page.waitForSelector(".whatif-table .fc.late")

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2aa"])
    .options({ runOnly: { type: "rule", values: ["color-contrast"] } })
    .analyze()

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
})

// The secrets pane starts hidden, and axe skips hidden content, so open it to get its state chips,
// notes, and disabled inputs into a scan.
test("settings secrets pane passes automated color-contrast checks", async ({ page }) => {
  await page.goto("/settings")
  await page.click('.cfg-nav-item[data-pane="secrets"]')
  await page.waitForSelector(".cfg-secret")

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2aa"])
    .options({ runOnly: { type: "rule", values: ["color-contrast"] } })
    .analyze()

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
})

// The roadmap draws its own card, axis-label, and edge colors, so scan it with cards on screen and a
// status chip pressed rather than only in its empty state.
test("roadmap passes automated color-contrast checks", async ({ page }) => {
  await page.goto("/roadmap?project=seeded-reliability")
  await page.waitForSelector(".rm-card")
  await page.click("#status-chips button")

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2aa"])
    .options({ runOnly: { type: "rule", values: ["color-contrast"] } })
    .analyze()

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
})

test("review and changes pages pass automated color-contrast checks", async ({ page }) => {
  for (const path of ["/review", "/changes", "/roadmap", "/settings"]) {
    await page.goto(path)
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2aa"])
      .options({ runOnly: { type: "rule", values: ["color-contrast"] } })
      .analyze()
    expect(results.violations, `${path}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([])
  }
})
