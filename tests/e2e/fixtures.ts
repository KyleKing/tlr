import { expect, test as base } from "@playwright/test"

// Collects browser console messages so a failing test (or any console error) prints them,
// and so a clean run asserts zero console errors rather than only checking visible DOM state.
type Fixtures = {
  consoleMessages: string[]
  consoleErrors: string[]
}

export const test = base.extend<Fixtures>({
  consoleMessages: async ({ page }, use) => {
    const messages: string[] = []
    const handler = (msg: { type(): string; text(): string }) => {
      messages.push(`${msg.type()}: ${msg.text()}`)
    }
    page.on("console", handler)
    await use(messages)
    page.off("console", handler)
  },
  consoleErrors: async ({ consoleMessages }, use) => {
    const errors = consoleMessages.filter((m) => m.startsWith("error:"))
    await use(errors)
  },
})

test.afterEach(({ consoleErrors, consoleMessages }) => {
  const testFailed = test.info().status !== test.info().expectedStatus
  if (testFailed || consoleErrors.length) {
    console.log("--- Browser Console Messages ---")
    for (const msg of consoleMessages) console.log(msg)
    console.log("--------------------------------")
  }
  expect(consoleErrors).toHaveLength(0)
})

export { expect }
