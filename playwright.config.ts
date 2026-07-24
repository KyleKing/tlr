import { defineConfig, devices } from "@playwright/test"

const PORT = "8081"
const BASE_URL = `http://localhost:${PORT}`

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: "./tests/e2e",

  fullyParallel: true,
  forbidOnly: !!Deno.env.get("CI"),
  retries: Deno.env.get("CI") ? 2 : 0,
  workers: Deno.env.get("CI") ? 1 : undefined,

  timeout: 5_000,
  expect: { timeout: 1_000 },

  reporter: Deno.env.get("CI") ? "github" : [["list"], ["html"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    // Captures the two seed snapshots into the store so the Changes and Review pages have a diff.
    { name: "setup", testMatch: /global\.setup\.ts/ },
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: /screenshots\.spec\.ts/,
    },
    // README screenshots, run on demand via `deno task screenshots`, never in the default e2e run, so
    // the committed images only change when asked. A fixed dark scheme keeps them from churning.
    {
      name: "screenshots",
      testMatch: /screenshots\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], colorScheme: "dark", viewport: { width: 1280, height: 800 } },
      dependencies: ["setup"],
    },
  ],

  // Seed fresh data and an isolated snapshot store on every run, so e2e is deterministic and never
  // touches a real local store or needs a live Linear connection.
  webServer: {
    command:
      `rm -f ./web/data/e2e.tlr.sqlite && deno task seed && PORT=${PORT} TLR_SNAPSHOT_DB=./web/data/e2e.tlr.sqlite deno task dev`,
    url: BASE_URL,
    timeout: 15 * 1000,
  },
})
