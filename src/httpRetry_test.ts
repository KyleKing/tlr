import { assertEquals, assertRejects } from "@std/assert"
import {
  backoffDelayMs,
  fetchWithRetry,
  isRetryableError,
  isRetryableStatus,
  MAX_BACKOFF_MS,
  parseRetryAfter,
} from "@/httpRetry.ts"

Deno.test("isRetryableStatus covers 429 and 5xx only", () => {
  assertEquals(isRetryableStatus(429), true)
  assertEquals(isRetryableStatus(500), true)
  assertEquals(isRetryableStatus(503), true)
  assertEquals(isRetryableStatus(400), false)
  assertEquals(isRetryableStatus(401), false)
  assertEquals(isRetryableStatus(403), false)
  assertEquals(isRetryableStatus(404), false)
  assertEquals(isRetryableStatus(200), false)
})

Deno.test("backoffDelayMs doubles per attempt and stays deterministic", () => {
  assertEquals(backoffDelayMs(1), 500)
  assertEquals(backoffDelayMs(2), 1000)
  assertEquals(backoffDelayMs(3), 2000)
  assertEquals(backoffDelayMs(99), MAX_BACKOFF_MS)
})

Deno.test("backoffDelayMs prefers the server's Retry-After, capped", () => {
  assertEquals(backoffDelayMs(1, 4000), 4000)
  assertEquals(backoffDelayMs(1, 120_000), MAX_BACKOFF_MS)
})

Deno.test("parseRetryAfter reads seconds and rejects nonsense", () => {
  assertEquals(parseRetryAfter("2"), 2000)
  assertEquals(parseRetryAfter(" 3 "), 3000)
  assertEquals(parseRetryAfter("0"), null)
  assertEquals(parseRetryAfter("-1"), null)
  assertEquals(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT"), null)
  assertEquals(parseRetryAfter(null), null)
})

Deno.test("isRetryableError accepts transport failures and timeouts, not domain errors", () => {
  assertEquals(isRetryableError(new TypeError("connection reset")), true)
  assertEquals(isRetryableError(new DOMException("signal timed out", "TimeoutError")), true)
  assertEquals(isRetryableError(new Error("Linear GraphQL: bad query")), false)
})

function responder(statuses: number[], headers: Record<string, string> = {}) {
  const calls: number[] = []
  const fetchImpl = (_url: string, _init: RequestInit) => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)]
    calls.push(status)
    return Promise.resolve(new Response("{}", { status, headers }))
  }
  return { calls, fetchImpl }
}

function recorder() {
  const delays: number[] = []
  const sleep = (ms: number) => {
    delays.push(ms)
    return Promise.resolve()
  }
  return { delays, sleep }
}

Deno.test("fetchWithRetry returns the first non-retryable response without sleeping", async () => {
  const { calls, fetchImpl } = responder([401])
  const { delays, sleep } = recorder()
  const res = await fetchWithRetry("https://example.test", {}, { fetchImpl, sleep })
  assertEquals(res.status, 401)
  assertEquals(calls.length, 1)
  assertEquals(delays, [])
})

Deno.test("fetchWithRetry retries a 500 and returns the eventual success", async () => {
  const { calls, fetchImpl } = responder([500, 200])
  const { delays, sleep } = recorder()
  const res = await fetchWithRetry("https://example.test", {}, { fetchImpl, sleep })
  assertEquals(res.status, 200)
  assertEquals(calls, [500, 200])
  assertEquals(delays, [500])
})

Deno.test("fetchWithRetry honours Retry-After on a 429 and gives up after the attempt budget", async () => {
  const { calls, fetchImpl } = responder([429], { "retry-after": "2" })
  const { delays, sleep } = recorder()
  const res = await fetchWithRetry("https://example.test", {}, { fetchImpl, sleep })
  assertEquals(res.status, 429)
  assertEquals(calls.length, 3)
  assertEquals(delays, [2000, 2000])
})

Deno.test("fetchWithRetry retries a transport failure then rethrows the last one", async () => {
  const { delays, sleep } = recorder()
  let calls = 0
  const fetchImpl = () => {
    calls++
    return Promise.reject(new TypeError("connection reset"))
  }
  await assertRejects(() => fetchWithRetry("https://example.test", {}, { fetchImpl, sleep }), TypeError)
  assertEquals(calls, 3)
  assertEquals(delays, [500, 1000])
})

Deno.test("fetchWithRetry does not retry an error it cannot attribute to the transport", async () => {
  const { delays, sleep } = recorder()
  let calls = 0
  const fetchImpl = () => {
    calls++
    return Promise.reject(new Error("boom"))
  }
  await assertRejects(() => fetchWithRetry("https://example.test", {}, { fetchImpl, sleep }), Error, "boom")
  assertEquals(calls, 1)
  assertEquals(delays, [])
})
