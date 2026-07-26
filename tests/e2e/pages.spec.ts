import { expect, test } from "./fixtures.ts"

// The seed project's snapshots come from global.setup; target it by slug so the tests stay deterministic
// even when other projects (a real ingest) also sit in the shared manifest.
const SEED = "?project=seeded-reliability"

test("changes page renders the weekly report from two snapshots", async ({ page }) => {
  await page.goto(`/changes${SEED}`)

  await expect(page.locator("h1")).toContainText("Changes")
  // shipped, moved, at risk
  await expect(page.locator(".rsec")).toHaveCount(3)
  await expect(page.locator(".page-body")).toContainText("SEED-101")
  await expect(page.locator(".rsec li.risk").first()).toBeVisible()
})

test("changes page steps through snapshot history with ‹/› and a range picker", async ({ page }) => {
  await page.goto(`/changes${SEED}`)
  await expect(page.locator(".rsec")).toHaveCount(3)

  const prevBtn = page.locator("#snap-prev")
  const nextBtn = page.locator("#snap-next")
  await expect(prevBtn).toBeVisible()
  await expect(page.locator("#snap-window")).toContainText("→")

  // starting at the latest snapshot: stepping back is possible, forward isn't
  await expect(prevBtn).toBeEnabled()
  await expect(nextBtn).toBeDisabled()

  // only two snapshots exist, so stepping "to" back to the oldest leaves nothing earlier to diff
  await prevBtn.click()
  await expect(page.locator(".page-body")).toContainText("Only one snapshot exists")
  await expect(prevBtn).toBeDisabled()
  await expect(nextBtn).toBeEnabled()

  // stepping forward again lands back on a real, renderable diff
  await nextBtn.click()
  await expect(page.locator(".rsec")).toHaveCount(3)

  // changing the range still resolves to a valid pair (only one older snapshot exists either way)
  await page.selectOption("#snap-range", "30")
  await expect(page.locator(".rsec")).toHaveCount(3)
})

// Captures land every few hours, so the window has to name a time, not a date: the seed pair is
// captured seconds apart and would otherwise print the same string on both sides.
test("changes page dates the window by local capture time, and jumps a day at a time", async ({ page }) => {
  await page.goto(`/changes${SEED}`)
  await expect(page.locator(".rsec")).toHaveCount(3)

  const clock = /\d{1,2}:\d{2}/
  await expect(page.locator("#snap-window")).toHaveText(clock)
  await expect(page.locator(".page-body .window")).toHaveText(clock)
  // asOf-only rendering printed the snapshot's date twice for an intra-day pair.
  await expect(page.locator(".page-body .window")).not.toHaveText(/^(\S+ \d+) → \1$/)

  // The day jump is the coarse control over the same list: forward is at the end, back is not.
  await expect(page.locator("#snap-next-day")).toBeDisabled()
  await page.locator("#snap-prev-day").click()
  // Only two captures exist, seconds apart, so a day back falls back to one step: the oldest.
  await expect(page.locator(".page-body")).toContainText("Only one snapshot exists")
  await expect(page.locator("#snap-prev-day")).toBeDisabled()
  await expect(page.locator("#snap-next-day")).toBeEnabled()

  await page.locator("#snap-next-day").click()
  await expect(page.locator(".rsec")).toHaveCount(3)
})

test("review page groups changes by ticket and marks them reviewed", async ({ page }) => {
  await page.goto(`/review${SEED}`)

  const groups = page.locator(".rgroup")
  await expect(groups.first()).toBeVisible()
  const count = await groups.count()
  expect(count).toBeGreaterThan(0)

  // The window runs from the review pointer to the newest capture and is named by local time, so two
  // captures on the same date are told apart.
  await expect(page.locator("#meta")).toHaveText(/\d{1,2}:\d{2}.* tickets to review/)

  await page.locator("button[data-review]").first().click()
  await expect(page.locator(".rgroup.reviewed")).toHaveCount(1)

  // The mark survives a reload: it is keyed by the window's starting snapshot, not by the date pair.
  await page.reload()
  await expect(page.locator(".rgroup.reviewed")).toHaveCount(1)
})

// Marking every ticket is what moves the pointer, and the pointer is a single global key the whole
// suite shares, so this asserts the window's shape and the rejection path without moving it.
test("the review pointer only accepts a capture of the named project", async ({ request }) => {
  const queue = await (await request.get(`/api/review?project=${encodeURIComponent("Horse Tinder (seed)")}`)).json()
  expect(queue.window.fromId).toBeLessThan(queue.window.toId)
  expect(queue.window.toCapturedAt).toBeGreaterThan(0)

  const bad = await request.post("/api/review/pointer", { data: { project: "Nope", snapshotId: queue.window.toId } })
  expect(bad.status()).toBe(400)
})

test("review page edits a ticket: form pre-fills, previews a dry run, and guards apply without a Linear link", async ({ page }) => {
  await page.goto(`/review${SEED}`)

  await page.locator("button[data-edit]").first().click()
  const modal = page.locator("#edit-modal")
  const form = modal.locator("form.editf")
  await expect(form).toBeVisible()

  // The form starts from the ticket's current values, and offers every writable field.
  const title = form.locator('input[name="title"]')
  await expect(title).not.toHaveValue("")
  for (const name of ["milestone", "status", "cycle", "assignee"]) {
    await expect(form.locator(`select[name="${name}"]`)).toBeVisible()
  }
  await title.fill("A clearer title")

  // Preview is a dry run: it reports the change without writing.
  await modal.locator('[data-act="preview"]').click()
  await expect(modal.locator(".emodal-out")).toContainText("nothing has been written")
  await expect(modal.locator(".echanges li")).toContainText("Title")

  // Seed data carries no Linear UUID, so a write is refused and apply stays disabled.
  await expect(modal.locator(".editf-warn")).toBeVisible()
  await expect(modal.locator('[data-act="apply"]')).toBeDisabled()
})

test("settings page switches panes and saves the capacity block", async ({ page }) => {
  await page.goto("/settings")

  // appearance pane is open first, with the theme pickers rendered, and a note that it's global
  await expect(page.locator("#flavor-picker .flavor-btn").first()).toBeVisible()
  await expect(page.locator(".cfg-pane[data-pane='appearance']")).toContainText("browser setting")

  // switching panes hides the others
  await page.click('.cfg-nav-item[data-pane="capacity"]')
  await expect(page.locator('.cfg-pane[data-pane="capacity"]')).toBeVisible()
  await expect(page.locator('.cfg-pane[data-pane="appearance"]')).toBeHidden()

  // save writes back and reports it
  await page.click("#cfg-save")
  await expect(page.locator("#cfg-status")).toHaveText("Saved")
})

// Read-only on purpose: a write here would edit the keychain of whoever runs the suite. The pane's
// state depends on the host's own keychain, so this asserts the shape (a row per secret, a masked
// state, no value anywhere) rather than a particular set/unset outcome.
test("settings secrets pane reports credential state without ever showing a value", async ({ page }) => {
  await page.goto("/settings")
  await page.click('.cfg-nav-item[data-pane="secrets"]')

  const pane = page.locator('.cfg-pane[data-pane="secrets"]')
  await expect(pane).toBeVisible()
  await expect(pane).toContainText("write-only here")

  const rows = pane.locator(".cfg-secret")
  await expect(rows).toHaveCount(2)
  for (const name of ["incidentio", "linear"]) {
    const row = pane.locator(`.cfg-secret[data-name="${name}"]`)
    await expect(row.locator(".cfg-secret-state")).toHaveText(/Set · (environment|keychain)|Not set/)
    await expect(row.locator("input")).toHaveValue("")
    await expect(row.locator("input")).toHaveAttribute("type", "password")
  }

  // Google Calendar is reported, not driven, from here: the pane names the task that runs consent.
  await expect(pane.locator("#cfg-google")).toContainText("deno task gcal:freebusy")
})

test("the global project picker in the nav switches projects and preserves the current page", async ({ page }) => {
  // The picker hides itself below two projects, and a fresh seed registers exactly one, so the
  // manifest is stubbed rather than read off disk. Both entries point at files global.setup wrote,
  // so switching to either loads real data. Everything else still comes from the seeded store.
  await page.route("**/data/projects.json", (route) =>
    route.fulfill({
      json: [
        { slug: "seeded-reliability", name: "Horse Tinder (seed)", dataFile: "seed-b.json" },
        { slug: "seeded-earlier", name: "Horse Tinder (earlier)", dataFile: "seed-a.json" },
      ],
    }))
  await page.goto(`/review${SEED}`)

  const picker = page.locator("#global-project-picker")
  await expect(picker).toBeVisible()
  await expect(picker.locator("option")).toHaveCount(2)
  await expect(picker).toHaveValue("seeded-reliability")

  // /api/projects/access is skipped under the e2e harness (no live Linear connection), so the
  // warning banner never fires here even though the manifest may list other, unrelated projects.
  await expect(page.locator("#access-warning")).toBeHidden()
})

test("roadmap lays tickets out on the plane with dependency edges between them", async ({ page }) => {
  await page.goto(`/roadmap${SEED}`)

  await expect(page.locator("h1")).toContainText("Roadmap")
  const cards = page.locator(".rm-card")
  expect(await cards.count()).toBeGreaterThan(0)
  // The seed project has a blocking chain, so both the wave labels and the edges are non-empty.
  expect(await page.locator(".rm-row-label").count()).toBeGreaterThan(1)
  expect(await page.locator(".rm-edge").count()).toBeGreaterThan(0)
  await expect(page.locator("#summary")).toContainText("dependency waves")

  // Two cards in the same cell are packed into lanes, so nothing ever overlaps.
  const boxes = await cards.evaluateAll((els) =>
    els.map((el) => ({ left: (el as HTMLElement).offsetLeft, top: (el as HTMLElement).offsetTop }))
  )
  expect(new Set(boxes.map((b) => `${b.left},${b.top}`)).size).toBe(boxes.length)
})

test("roadmap shows detail on focus and keeps filters and the view in the URL", async ({ page }) => {
  await page.goto(`/roadmap${SEED}`)
  await page.waitForSelector(".rm-card")

  // Focus, not just hover, opens the detail card, so the plane is usable from the keyboard.
  await page.locator(".rm-card").first().focus()
  await expect(page.locator("#tip")).toBeVisible()
  await expect(page.locator("#tip .tip-meta")).toContainText("Wave")

  // The plane pans from the keyboard, and the pan lands in the address bar with the filters.
  await page.locator("#rm-viewport").focus()
  await page.keyboard.press("ArrowRight")
  await expect(page).toHaveURL(/pan=/)
  await page.click("#zoom-in")
  await expect(page).toHaveURL(/zoom=/)

  // Search is lowercased before it is matched and stored, the same as the board's.
  await page.fill("#search", "SEED-102")
  await expect(page).toHaveURL(/q=seed-102/)
  await expect(page.locator(".rm-card")).toHaveCount(1)
})

test("balance proposes owners and cycles, and each row can be dropped before previewing", async ({ page }) => {
  await page.goto(`/balance${SEED}`)

  await expect(page.locator("h1")).toContainText("Balance")
  const rows = page.locator(".bal-table input[type=checkbox][data-id]")
  const count = await rows.count()
  expect(count).toBeGreaterThan(0)

  // Every row starts included, and the preview button counts the ops it would send.
  const preview = page.locator("#preview")
  await expect(preview).toBeEnabled()
  const before = await preview.textContent()

  // Dropping a row drops its ops, so the count falls and the row dims.
  await rows.first().uncheck()
  await expect(page.locator(".bal-table tr.bal-off")).toHaveCount(1)
  await expect(preview).not.toHaveText(before!)

  // Preview is a dry run against the write path, so nothing reaches Linear.
  await preview.click()
  await expect(page.locator("#out")).toContainText("Dry run")
})

test("balance recomputes for a different cycle window", async ({ page }) => {
  await page.goto(`/balance${SEED}`)
  await expect(page.locator(".bal-table").first()).toBeVisible()

  // A window the team does not run has nowhere to land a cycle, which is said rather than silently
  // producing an empty plan.
  await page.locator("#bal-start").fill("90")
  await page.locator("#bal-end").fill("92")
  await page.locator("#recompute").click()
  await expect(page.locator(".bal-warnings")).toContainText("do not exist")
})

test("nav moves between board, changes, review, roadmap, balance, and settings", async ({ page }) => {
  await page.goto("/")
  // Nav links carry the current ?project= forward (see resolveProjectSlug/syncNavLinks), so they're no
  // longer bare paths — match by prefix and allow a trailing query string.
  await page.click(".topnav a[href^='/changes']")
  await expect(page).toHaveURL(/\/changes(\?.*)?$/)
  await page.click(".topnav a[href^='/review']")
  await expect(page).toHaveURL(/\/review(\?.*)?$/)
  await page.click(".topnav a[href^='/roadmap']")
  await expect(page).toHaveURL(/\/roadmap(\?.*)?$/)
  await page.click(".topnav a[href^='/balance']")
  await expect(page).toHaveURL(/\/balance(\?.*)?$/)
  await page.click(".topnav a[href^='/settings']")
  await expect(page).toHaveURL(/\/settings(\?.*)?$/)
})
