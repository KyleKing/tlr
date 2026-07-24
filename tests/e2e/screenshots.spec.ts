import { test } from "@playwright/test"

// README screenshots, written to docs/images and committed by hand. Run on demand with
// `deno task screenshots`; the default e2e run ignores this file, so the images change only when
// asked. The dark scheme and fixed viewport come from the "screenshots" project config.
const OUT = "docs/images"

const pages: [path: string, name: string, ready: string][] = [
  ["/", "board", "#grid tr"],
  ["/changes", "changes", ".rsec"],
  ["/review", "review", ".rgroup"],
]

for (const [path, name, ready] of pages) {
  test(`screenshot: ${name}`, async ({ page }) => {
    await page.goto(path)
    await page.locator(ready).first().waitFor({ state: "visible" })
    await page.screenshot({ path: `${OUT}/${name}.png` })
  })
}
