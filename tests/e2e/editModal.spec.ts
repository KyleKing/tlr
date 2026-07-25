import type { Page } from "@playwright/test"
import { expect, FORECAST_BOARD, stubBoard, test } from "./fixtures.ts"

// The seed project's data is deterministic (see src/seed.ts): estimates come from 0/1/2/3/5/8, and no
// ticket carries a Linear UUID, so nothing in this file can reach a real write even by accident.
const SEED = "?project=seeded-reliability"

async function openFromReview(page: Page) {
  await page.goto(`/review${SEED}`)
  const trigger = page.locator("button[data-edit]").first()
  await trigger.click()
  await expect(page.locator("#edit-modal form.editf")).toBeVisible()
  return trigger
}

const inModal = (page: Page) =>
  page.evaluate(() => {
    const dialog = document.getElementById("edit-modal")
    return Boolean(dialog?.contains(document.activeElement))
  })

test("both entry points open the same editor", async ({ page }) => {
  await openFromReview(page)
  await expect(page.locator("#edit-modal")).toHaveAttribute("aria-labelledby", "emodal-title")
  await expect(page.locator("#emodal-title")).toContainText("Edit SEED-")

  await page.goto(`/${SEED}`)
  await page.locator("#grid [data-id]").first().hover()
  await page.click('#tip [data-act="edit"]')
  await expect(page.locator("#edit-modal form.editf")).toBeVisible()
  await expect(page.locator("#edit-impact")).toContainText("No changes yet")
})

test("focus moves into the modal, stays there, and returns to the trigger", async ({ page }) => {
  const trigger = await openFromReview(page)
  await expect(page.locator("#ef-title")).toBeFocused()

  // Tabbing past the last control wraps inside the dialog rather than reaching the page behind it.
  for (let i = 0; i < 30; i++) await page.keyboard.press("Tab")
  expect(await inModal(page)).toBe(true)
  await page.keyboard.press("Shift+Tab")
  expect(await inModal(page)).toBe(true)

  await page.locator('#edit-modal [data-act="cancel"]').click()
  await expect(page.locator("#edit-modal")).toBeHidden()
  await expect(trigger).toBeFocused()
})

test("an estimate off the team's scale blocks the write and says why on the field", async ({ page }) => {
  await openFromReview(page)
  const estimate = page.locator("#ef-estimate")
  const error = page.locator('.efield[data-field="estimate"] .efield-err')

  await estimate.fill("4")
  await expect(error).toBeVisible()
  await expect(error).toContainText("Estimate must be one of")
  await expect(estimate).toHaveAttribute("aria-invalid", "true")
  await expect(page.locator('#edit-modal [data-act="preview"]')).toBeDisabled()
  await expect(page.locator('#edit-modal [data-act="apply"]')).toBeDisabled()

  // A value on the scale clears the reason and lets the dry run through again.
  await estimate.fill("5")
  await expect(error).toBeHidden()
  await expect(page.locator('#edit-modal [data-act="preview"]')).toBeEnabled()
})

test("the preview lists only the fields that changed, old value to new", async ({ page }) => {
  await openFromReview(page)
  const before = await page.locator("#ef-title").inputValue()
  await page.locator("#ef-title").fill("A clearer title")
  await page.locator('#edit-modal [data-act="preview"]').click()

  const rows = page.locator("#edit-modal .echanges li")
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("Title")
  await expect(rows.first().locator(".efrom")).toHaveText(before)
  await expect(rows.first().locator(".eto")).toHaveText("A clearer title")
  await expect(page.locator("#edit-modal .emodal-out-h")).toContainText("nothing has been written")
})

test("closing with edits in flight asks first", async ({ page }) => {
  await openFromReview(page)
  const guard = page.locator("#edit-modal .emodal-guard")
  await expect(guard).toBeHidden()

  await page.locator("#ef-title").fill("Half-written")
  await page.keyboard.press("Escape")
  await expect(page.locator("#edit-modal")).toBeVisible()
  await expect(guard).toBeVisible()

  await guard.locator('[data-act="keep"]').click()
  await expect(guard).toBeHidden()
  await expect(page.locator("#edit-modal")).toBeVisible()

  // The backdrop is the same question, not a shortcut past it.
  await page.mouse.click(5, 5)
  await expect(guard).toBeVisible()
  await expect(page.locator("#edit-modal")).toBeVisible()

  await guard.locator('[data-act="discard"]').click()
  await expect(page.locator("#edit-modal")).toBeHidden()
})

test("an untouched editor closes on Escape without a question", async ({ page }) => {
  await openFromReview(page)
  await page.keyboard.press("Escape")
  await expect(page.locator("#edit-modal")).toBeHidden()
})

test("the description toggles between plain markdown and its rendered form", async ({ page }) => {
  await openFromReview(page)
  const textarea = page.locator("#ef-description")
  await textarea.fill("## Why\n\n- **fast** path\n- `code` path")

  await page.locator('#edit-modal [data-desc="preview"]').click()
  const preview = page.locator("#edit-modal .emodal-md")
  await expect(preview).toBeVisible()
  await expect(textarea).toBeHidden()
  await expect(preview.locator("h4")).toHaveText("Why")
  await expect(preview.locator("li")).toHaveCount(2)
  await expect(preview.locator("strong")).toHaveText("fast")
  await expect(preview.locator("code")).toHaveText("code")

  // Back to Edit: the text is untouched, because the textarea is what the write path reads.
  await page.locator('#edit-modal [data-desc="write"]').click()
  await expect(textarea).toBeVisible()
  await expect(preview).toBeHidden()
  await expect(textarea).toHaveValue("## Why\n\n- **fast** path\n- `code` path")
})

// The impact pane reads the same stubbed board the what-if tests use (see fixtures.ts), so every
// number below is arithmetic off two people at 20 points a cycle rather than off whatever the seeded
// project happens to hold today.
async function openFromStubbedBoard(page: Page) {
  await stubBoard(page)
  await page.goto("/")
  await page.waitForSelector("#grid tr")
  await page.locator('#grid [data-id="FC-1"]').hover()
  await page.click('#tip [data-act="edit"]')
  await expect(page.locator("#edit-modal form.editf")).toBeVisible()
}

test("the impact pane follows the form and never issues a write", async ({ page }) => {
  let writes = 0
  await page.route("**/api/edit", (route) => {
    writes++
    return route.abort()
  })
  await openFromStubbedBoard(page)
  const pane = page.locator("#edit-impact")
  await expect(pane).toContainText("No changes yet")

  // FC-1 is Ada's only work in cycle 48, so re-estimating it moves her whole load for that cycle and
  // pulls M1's landing in with it.
  await page.locator("#ef-estimate").fill("8")
  await expect(pane).toContainText("Ada Lovelace, cycle 48")
  await expect(pane.locator(".eimpact-num.down").first()).toBeVisible()
  await expect(pane).toContainText("Forecast")
  await expect(pane).toContainText("M1: Engine")

  // Handing it to Bob, who already carries a full cycle 49, is the warning case.
  await page.locator("#ef-assignee").selectOption("Bob Kahn")
  await page.locator("#ef-cycle").selectOption("49")
  await expect(pane.locator(".eimpact-alert")).toContainText("over capacity")

  await page.locator("#ef-description").fill("Utilize a holistic, robust approach; it delves into the realm.")
  await expect(pane).toContainText("Slop score")
  await expect(pane).toContainText("worse")

  expect(writes).toBe(0)
})

test("the ticket's blockers show in the pane with the date they land", async ({ page }) => {
  await stubBoard(page, {
    ...FORECAST_BOARD,
    issues: FORECAST_BOARD.issues.map((i) =>
      i.id === "FC-1" ? { ...i, blocks: ["FC-2"] } : i.id === "FC-2" ? { ...i, blockedBy: ["FC-1"] } : i
    ),
  })
  await page.goto("/")
  await page.waitForSelector("#grid tr")
  await page.locator('#grid [data-id="FC-1"]').hover()
  await page.click('#tip [data-act="edit"]')
  const pane = page.locator("#edit-impact")

  await page.locator("#ef-cycle").selectOption("")
  await page.locator("#ef-milestone").selectOption("M2")
  await expect(pane).toContainText("blocks FC-2")
  await expect(pane).toContainText("critical path")
})
