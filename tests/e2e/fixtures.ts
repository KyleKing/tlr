import { expect, type Page, test as base } from "@playwright/test"

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

// A small, fully deterministic board: two rostered people at 20 points a cycle each (so team
// throughput is 40/week), two milestones, and 80 points of open work split between them. Every
// landing date the what-if tests assert on is arithmetic off these numbers, which the seeded project
// cannot promise — its capacity block is a real file the board's own override tests write to.
const issue = (id: string, over: Record<string, unknown>) => ({
  id,
  title: `Ticket ${id}`,
  description: "",
  url: "https://linear.app/",
  status: "Todo",
  statusType: "unstarted",
  priority: null,
  priorityValue: null,
  labels: [],
  parentId: null,
  ...over,
})

export const FORECAST_BOARD = {
  project: { name: "Forecast Co", start: "2026-07-01", target: "2026-11-30", url: "https://linear.app/" },
  asOf: "2026-07-23",
  currentCycle: 48,
  cycles: [
    { n: 47, start: "2026-07-13", end: "2026-07-20" },
    { n: 48, start: "2026-07-20", end: "2026-07-27" },
    { n: 49, start: "2026-07-27", end: "2026-08-03" },
  ],
  milestones: [
    { key: "M1", name: "M1: Engine", target: "2026-07-31", progress: 40 },
    { key: "M2", name: "M2: Profiles", target: "2026-08-31", progress: 10 },
  ],
  issues: [
    issue("FC-1", { estimate: 20, assignee: "Ada Lovelace", milestone: "M1", cycle: 48 }),
    issue("FC-2", { estimate: 20, assignee: "Bob Kahn", milestone: "M1", cycle: 49 }),
    issue("FC-3", { estimate: 40, assignee: "Ada Lovelace", milestone: "M2", cycle: null }),
  ],
  capacity: {
    config: { workdaysPerCycle: 5, oncallPenalty: 0.45 },
    defaultVelocity: 20,
    roster: { "Ada Lovelace": { email: "ada@example.com" }, "Bob Kahn": { email: "bob@example.com" } },
    people: {},
  },
}

// Serve `board` for the project's data file, leaving the projects.json manifest alone so the picker
// still loads. Keeps a board test off whatever real or seeded data the machine happens to hold.
export async function stubBoard(page: Page, board: unknown = FORECAST_BOARD) {
  await page.route("**/data/**", (route) => {
    if (route.request().url().endsWith("projects.json")) return route.continue()
    return route.fulfill({ json: board })
  })
}
