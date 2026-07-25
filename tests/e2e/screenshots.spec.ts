import { test } from "@playwright/test"

// README screenshots, written to docs/images and committed by hand. Run on demand with
// `deno task screenshots`; the default e2e run ignores this file, so the images change only when
// asked. The dark scheme and fixed viewport come from the "screenshots" project config.
const OUT = "docs/images"

// Target the seed project by slug so the shots are the seeded demo regardless of what other projects a
// real ingest has left in the shared manifest.
const SEED = "?project=seeded-reliability"

const pages: [path: string, name: string, ready: string][] = [
  [`/${SEED}`, "board", "#grid tr"],
  [`/changes${SEED}`, "changes", ".rsec"],
  [`/review${SEED}`, "review", ".rgroup"],
  [`/roadmap${SEED}`, "roadmap", ".rm-card"],
  [`/settings${SEED}`, "settings", ".cfg-nav-item"],
]

// Pin the clock so any "loaded HH:MM" / relative-age text renders the same every run. Without this the
// board shot churns on its load timestamp even when nothing visual changed. setFixedTime pins Date
// without faking timers, so fetches and the app still run normally.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-24T09:00:00"))
})

for (const [path, name, ready] of pages) {
  test(`screenshot: ${name}`, async ({ page }) => {
    await page.goto(path)
    await page.locator(ready).first().waitFor({ state: "visible" })
    // Open the editor so the Review shot shows the in-flow fix, not just the change list.
    if (name === "review") {
      await page.locator("button[data-edit]").first().click()
      await page.locator("#edit-modal form.editf").waitFor({ state: "visible" })
    }
    await page.screenshot({ path: `${OUT}/${name}.png` })
  })
}
