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

// The scheduled-snapshot banner only paints when a run failed, so stub that state to get its tinted
// bar and its dismiss button into a scan. Every page carries it, so the board is enough.
test("the scheduled-snapshot banner passes automated color-contrast checks", async ({ page }) => {
  await page.route("**/api/schedule/health", (route) =>
    route.fulfill({
      json: {
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
      },
    }))
  await page.goto("/")
  await page.waitForSelector("#schedule-notice")

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

// The editor modal draws a dimmed backdrop, a field grid, a rendered description, the impact column,
// and the inline reason on a field that fails validation — none of which exist until it is open, and
// the invalid state is exactly where a red-on-tinted-background regression would land.
test("the open ticket editor passes automated color-contrast checks", async ({ page }) => {
  await page.goto("/review?project=seeded-reliability")
  await page.locator("button[data-edit]").first().click()
  await expect(page.locator("#edit-modal form.editf")).toBeVisible()

  await page.locator("#ef-estimate").fill("4")
  await expect(page.locator('.efield[data-field="estimate"] .efield-err')).toBeVisible()
  await page.locator("#ef-description").fill("## Heading\n\n- a **bold** item\n- a `code` item\n\n> quoted")
  await page.locator('#edit-modal [data-desc="preview"]').click()
  await expect(page.locator("#edit-modal .emodal-md h4")).toBeVisible()

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
