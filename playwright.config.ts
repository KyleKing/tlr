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
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: `PORT=${PORT} deno task dev`,
    url: BASE_URL,
    timeout: 10 * 1000,
  },
})
