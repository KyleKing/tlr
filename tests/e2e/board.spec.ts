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

// Regression: transformIssue used to leave a real `null` assignee instead of the "Unassigned" sentinel
// every render/sort path expects, so an issue ingested straight from Linear (where an unassigned issue
// really is null, not the string "Unassigned") crashed render()'s people sort with
// `a.localeCompare is not a function` — surfaced by the new error banner as "Refresh failed", not a
// silent hang. This exercises that shape end to end instead of only at the transformIssue unit level.
test("a null assignee (as a real Linear ingest produces) does not crash the board", async ({ page }) => {
  const data = {
    project: { name: "Null Assignee Co", start: "2026-07-01", target: "2026-11-30", url: "https://linear.app/" },
    cycles: [{ n: 48, start: "2026-07-20", end: "2026-07-27" }],
    asOf: "2026-07-23",
    currentCycle: 48,
    milestones: [],
    issues: [{
      id: "NUL-1",
      title: "Untriaged issue",
      url: "https://linear.app/",
      estimate: 2,
      assignee: null,
      status: "Backlog",
      statusType: "backlog",
      priority: null,
      priorityValue: null,
      labels: [],
      parentId: null,
      milestone: null,
      cycle: null,
    }],
    capacity: { config: { workdaysPerCycle: 5, oncallPenalty: 0.35 }, defaultVelocity: 20, roster: {}, people: {} },
  }
  // Leave /data/projects.json (the manifest) alone — only the project's own board data is this fixture.
  await page.route("**/data/**", (route) => {
    if (route.request().url().endsWith("projects.json")) return route.continue()
    return route.fulfill({ json: data })
  })
  // The Refresh button now re-ingests from Linear first (POST /api/refresh) before reloading the data
  // file; stub that success so this test isolates the null-assignee render bug, not live Linear access.
  await page.route("**/api/refresh", (route) => route.fulfill({ json: { ok: true, log: [] } }))
  await page.goto("/")

  await expect(page.locator("#grid tr").first()).toBeVisible()
  await expect(page.locator(".js-error")).toBeHidden()

  await page.click("#refresh")
  await expect(page.locator(".js-error")).toBeHidden()
})

test("Refresh re-ingests from Linear first, and a failure there shows up instead of looking like a no-op", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("#grid tr").first()).toBeVisible()

  let refreshCalled = false
  await page.route("**/api/refresh", (route) => {
    refreshCalled = true
    return route.fulfill({
      status: 500,
      json: { ok: false, log: ["issues: no Linear key configured"], error: "getSecret: no value for linear" },
    })
  })

  await page.click("#refresh")
  expect(refreshCalled).toBe(true)
  await expect(page.locator(".js-error-entry")).toContainText("getSecret: no value for linear")
  // the button resets instead of staying stuck on "Refreshing…"
  await expect(page.locator("#refresh")).toHaveText("Refresh")
})

test("a ticket can be edited in place from the board's hover card", async ({ page }) => {
  await page.goto("/?project=seeded-reliability")
  const ticket = page.locator("#grid [data-id]").first()
  await expect(ticket).toBeVisible()
  const id = await ticket.getAttribute("data-id")

  await ticket.hover()
  await page.click('#tip [data-act="edit"]')

  const form = page.locator("#tip form.editf")
  await expect(form).toBeVisible()
  await expect(form).toHaveAttribute("data-id", id ?? "")
  await expect(form.locator('input[name="title"]')).not.toHaveValue("")
  for (const name of ["milestone", "status", "cycle", "assignee"]) {
    await expect(form.locator(`select[name="${name}"]`)).toBeVisible()
  }

  // Preview is a dry run: it reports the change without writing.
  await form.locator('input[name="title"]').fill("An edited title")
  await form.locator('[data-act="preview"]').click()
  await expect(form.locator(".editf-out")).toContainText("title →")

  // Hovering a different ticket while editing doesn't clobber the open form (the tip is pinned) — fired
  // directly rather than a real pointer hover, since the tip (now form-sized) may cover other tickets.
  await page.locator("#grid [data-id]").nth(1).dispatchEvent("mouseenter")
  await expect(page.locator("#tip form.editf")).toBeVisible()

  // Cancel un-pins the tip: it hides, and a fresh hover works normally again.
  await form.locator('[data-act="cancel"]').click()
  await expect(page.locator("#tip")).toBeHidden()
  await ticket.hover()
  await expect(page.locator("#tip")).toBeVisible()
  await expect(page.locator("#tip form.editf")).toHaveCount(0)
})

test("on-call/out-days overrides are edited on the board, not in Settings", async ({ page }) => {
  await page.goto("/?project=seeded-reliability")
  await expect(page.locator("#grid tr").first()).toBeVisible()

  // Grace Hopper is on-call in Cycle 48 in the seed data (see src/seed.ts) — click that badge to edit.
  const badge = page.locator(".cf.oncall").first()
  await expect(badge).toBeVisible()
  await badge.click()

  const popup = page.locator("#ov-popup")
  await expect(popup).toBeVisible()
  await expect(popup.locator("#ov-oncall")).toBeChecked()

  // Turning it off and saving removes the badge.
  await popup.locator("#ov-oncall").uncheck()
  await popup.locator('[data-act="save"]').click()
  await expect(popup).toBeHidden()
  await expect(page.locator(".cf.oncall")).toHaveCount(0)

  // Right-click an eligible (but now override-free) cycle cell adds a fresh entry.
  const cell = page.locator("td[data-name]").first()
  await cell.click({ button: "right" })
  await expect(popup).toBeVisible()
  await popup.locator("#ov-outdays").fill("3")
  await popup.locator("#ov-reason").fill("Conference")
  await popup.locator('[data-act="save"]').click()
  await expect(popup).toBeHidden()
  await expect(page.locator(".cf.out").filter({ hasText: "Conference" })).toBeVisible()
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

test("filter state round-trips through the URL, so a reload keeps it", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("#grid tr").first()).toBeVisible()

  await page.click("#status-none")
  await page.click("#expand")
  await page.fill("#search", "risk")
  await expect(page).toHaveURL(/status=&expanded=1&q=risk/)

  await page.reload()
  await expect(page.locator("#search")).toHaveValue("risk")
  await expect(page.locator("#expand")).toHaveAttribute("aria-pressed", "true")
  for (const btn of await page.locator("#status-chips button").all()) {
    await expect(btn).toHaveAttribute("aria-pressed", "false")
  }

  // clearing the search and un-collapsing back to the default statuses drops those params entirely
  // instead of writing the default value out explicitly
  await page.click("#expand")
  await page.fill("#search", "")
  await expect(page).not.toHaveURL(/expanded=|q=/)
})

test("an uncaught client error surfaces in a visible, dismissible banner", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("#grid tr").first()).toBeVisible()

  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("injected test error")
    }, 0)
  })

  const banner = page.locator(".js-error-entry")
  await expect(banner).toBeVisible()
  await expect(banner).toContainText("injected test error")
  await expect(page.locator(".js-error-stack")).toContainText("injected test error")

  // Anchored to the bottom, not the top — it must never cover the nav or the access-warning banner.
  const box = await page.locator(".js-error").boundingBox()
  const viewport = page.viewportSize()
  expect(box?.y).toBeGreaterThan(0)
  if (box && viewport) expect(box.y + box.height).toBeCloseTo(viewport.height, 0)

  await page.click(".js-error-dismiss")
  await expect(banner).toHaveCount(0)
})

test("the board defaults to rows: buckets", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("#grid tr").first()).toBeVisible()

  await expect(page.locator("#grid")).toHaveClass(/transposed/)
  await expect(page.locator("#orient")).toContainText("Rows: buckets")
  await expect(page.locator(".rowhead").first()).toBeVisible()
})

test("the combined bucket filter is a searchable multi-select that narrows the board's rows", async ({ page }) => {
  // Pinned (unlike the other tests here): this one asserts on how many milestones carry a
  // default-visible issue, which depends on the specific project's data, not just "some project
  // loaded" — the default (first-in-manifest) project can be a real, locally-ingested one too, since
  // the manifest lives in the same web/data/ a real `deno task issues` run also writes to.
  await page.goto("/?project=seeded-reliability")
  await expect(page.locator("#grid tr").first()).toBeVisible()

  const rowCount = await page.locator(".rowhead.horizon").count()
  expect(rowCount).toBeGreaterThan(1)

  await page.click("#bsel-btn")
  await expect(page.locator("#bsel-panel")).toBeVisible()
  await expect(page.locator("#cycle-list li")).not.toHaveCount(0)

  const firstLabel = (await page.locator("#msel-list label span").first().textContent()) ?? ""
  await page.fill("#msel-search", firstLabel.slice(0, 4))
  await expect(page.locator("#msel-list li")).toHaveCount(1)

  await page.click("#msel-none")
  await page.click(`#msel-list input[type="checkbox"]`)
  await page.keyboard.press("Escape")

  await expect(page.locator("#bsel-btn")).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator(".rowhead.horizon")).toHaveCount(1)
})
