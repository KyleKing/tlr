import { test } from "@playwright/test"

// README screenshots, written to docs/images and committed by hand. Run on demand with
// `deno task screenshots`; the default e2e run ignores this file, so the images change only when
// asked. The dark scheme and fixed viewport come from the "screenshots" project config.
const OUT = "docs/images"

const pages: [path: string, name: string, ready: string][] = [
  ["/", "board", "#grid tr"],
  ["/changes", "changes", ".rsec"],
  ["/review", "review", ".rgroup"],
  ["/settings", "settings", ".cfg-nav-item"],
]

for (const [path, name, ready] of pages) {
  test(`screenshot: ${name}`, async ({ page }) => {
    await page.goto(path)
    await page.locator(ready).first().waitFor({ state: "visible" })
    // Open the first edit form so the Review shot shows the in-flow fix, not just the change list.
    if (name === "review") {
      await page.locator("button[data-edit]").first().click()
      await page.locator("form.editf").first().waitFor({ state: "visible" })
    }
    await page.screenshot({ path: `${OUT}/${name}.png` })
  })
}
