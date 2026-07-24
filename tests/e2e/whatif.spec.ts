import type { Page } from "@playwright/test"
import { expect, stubBoard, test } from "./fixtures.ts"

// Fails the test if a simulation ever reaches a write endpoint. What-if is in-memory by definition,
// so a stray POST here is the bug the whole feature has to avoid.
async function forbidWrites(page: Page) {
  const hits: string[] = []
  for (const path of ["**/api/config", "**/api/edit"]) {
    await page.route(path, (route) => {
      hits.push(route.request().url())
      return route.fulfill({ json: { ok: false } })
    })
  }
  return hits
}

const shiftFor = (page: Page, milestone: string) =>
  page.locator(".whatif-table tbody tr").filter({ hasText: milestone }).locator("td").last()

test("what-if mode simulates PTO, shows the forecast shift, and resets", async ({ page }) => {
  await stubBoard(page)
  const writes = await forbidWrites(page)
  await page.goto("/")
  await expect(page.locator("#grid tr").first()).toBeVisible()

  // Entering the mode says so, and starts with the baseline: every milestone lands where it already did.
  await page.click("#whatif-btn")
  await expect(page.locator("#whatif-bar")).toBeVisible()
  await expect(page.locator("#whatif-btn")).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator(".whatif-note")).toContainText("Nothing here is written to Linear")
  await expect(page.locator(".whatif-table caption")).toContainText("Forecast")
  await expect(page.locator(".whatif-table tbody tr")).toHaveCount(2)
  await expect(page.locator(".whatif-table .fc.same")).toHaveCount(2)
  await expect(shiftFor(page, "Engine")).toContainText("no change")

  // Ada out all five workdays of cycle 48 drops team throughput from 40/week to 30, pushing both
  // milestones out. Entered through the board's existing right-click-a-cycle-cell gesture.
  await page.locator('td[data-name="Ada Lovelace"][data-cycle="48"]').click({ button: "right" })
  const popup = page.locator("#ov-popup")
  await expect(popup).toBeVisible()
  await expect(popup.locator("h4")).toContainText("What-if")
  await expect(popup.locator("#ov-locked")).toHaveCount(0)
  await popup.locator("#ov-outdays").fill("5")
  await popup.locator("#ov-reason").fill("PTO")
  await popup.locator('[data-act="save"]').click()

  await expect(popup).toBeHidden()
  await expect(page.locator("#whatif-count")).toHaveText("1 overlay")
  await expect(shiftFor(page, "Engine")).toContainText("2d later")
  await expect(shiftFor(page, "Profiles")).toContainText("4d later")
  // The simulated time off shows on the board itself, not only in the table.
  await expect(page.locator(".cf.out").filter({ hasText: "PTO" })).toBeVisible()

  // Reset drops the overlay without leaving what-if mode.
  await page.click("#whatif-reset")
  await expect(page.locator("#whatif-bar")).toBeVisible()
  await expect(page.locator(".whatif-table .fc.same")).toHaveCount(2)
  await expect(page.locator(".cf.out")).toHaveCount(0)

  // Leaving takes the banner and every simulated number with it.
  await page.click("#whatif-exit")
  await expect(page.locator("#whatif-bar")).toBeHidden()
  await expect(page.locator("#whatif-btn")).toHaveAttribute("aria-pressed", "false")
  await expect(page.locator(".cf.out")).toHaveCount(0)
  expect(writes).toEqual([])
})

test("a what-if scope move pulls a milestone earlier and never touches the real edit path", async ({ page }) => {
  await stubBoard(page)
  const writes = await forbidWrites(page)
  await page.goto("/")
  await expect(page.locator("#grid tr").first()).toBeVisible()

  await page.click("#whatif-btn")
  await expect(shiftFor(page, "Engine")).toContainText("no change")

  // The hover card's Edit button is the same entry point as a real edit, routed to an overlay.
  await page.locator('#grid [data-id="FC-2"]').hover()
  await expect(page.locator('#tip [data-act="edit"]')).toHaveText("Move (what-if)")
  await page.click('#tip [data-act="edit"]')

  const form = page.locator("#tip form.whatif-move")
  await expect(form).toBeVisible()
  await expect(form.locator(".editf-warn")).toContainText("never reaches Linear")
  await form.locator('select[name="milestone"]').selectOption("M2")
  await form.locator('[data-act="simulate"]').click()

  await expect(page.locator("#whatif-count")).toHaveText("1 overlay")
  await expect(shiftFor(page, "Engine")).toContainText("4d earlier")
  // M2 picks the work up, but it also starts sooner, so it lands a day earlier too.
  await expect(shiftFor(page, "Profiles")).toContainText("1d earlier")

  // Exiting restores the real placement: FC-2 is back under M1's remaining work.
  await page.click("#whatif-exit")
  await expect(page.locator("#whatif-bar")).toBeHidden()
  await page.locator('#grid [data-id="FC-2"]').hover()
  await expect(page.locator('#tip [data-act="edit"]')).toHaveText("Edit")
  expect(writes).toEqual([])
})
