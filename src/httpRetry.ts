// A bounded retry around a single HTTP call, for the Linear reads the scheduled run makes with no
// terminal watching. Two failure modes matter: a connection that hangs (the run holds the snapshot
// lock until someone notices) and a transient 429 or 5xx (the run fails for a reason that would have
// cleared on its own a second later).
//
// Only transport failures and 429/5xx are retried. An auth failure, a malformed query, or any other
// 4xx is the caller's fault and repeating it just burns rate limit, so those come straight back.
//
// The delay schedule is a pure function of the attempt number and the Retry-After header, with no
// random jitter, so a test asserts exact delays. A single-process daily run has no thundering herd to
// spread out, which is the only thing jitter buys.

export const DEFAULT_ATTEMPTS = 3
export const DEFAULT_TIMEOUT_MS = 15_000
export const BASE_BACKOFF_MS = 500
export const MAX_BACKOFF_MS = 30_000

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>
export type Sleep = (ms: number) => Promise<void>

export type RetryOptions = {
  attempts?: number
  fetchImpl?: FetchLike
  sleep?: Sleep
  timeoutMs?: number
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

// Retry-After in seconds (Linear sends the delta form), as milliseconds. A missing, malformed, or
// non-positive value means "no opinion", not "retry immediately".
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null
  const seconds = Number(value.trim())
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.min(seconds * 1000, MAX_BACKOFF_MS)
}

// How long to wait before the attempt after `attempt` (1-based): 500ms, 1s, 2s, … capped, unless the
// server named its own delay, which always wins because it is the only informed number available.
export function backoffDelayMs(attempt: number, retryAfterMs: number | null = null): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, MAX_BACKOFF_MS)
  const exponential = BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1)
  return Math.min(exponential, MAX_BACKOFF_MS)
}

// A transport-level failure (DNS, reset connection, the per-attempt timeout firing) as opposed to a
// response the server actually sent. Every one of these is worth one more try.
export function isRetryableError(err: unknown): boolean {
  return err instanceof TypeError || err instanceof DOMException || (err instanceof Error && err.name === "AbortError")
}

const wait: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// fetch with a per-attempt timeout and a bounded retry. Returns the last response even when it is a
// failing one, so the caller keeps its own status handling; throws only when every attempt threw.
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions = {}): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? wait

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (attempt === attempts || !isRetryableStatus(res.status)) return res
      await sleep(backoffDelayMs(attempt, parseRetryAfter(res.headers.get("retry-after"))))
    } catch (err) {
      if (attempt === attempts || !isRetryableError(err)) throw err
      lastError = err
      await sleep(backoffDelayMs(attempt))
    }
  }
  throw lastError
}
