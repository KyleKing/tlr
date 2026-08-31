// `tlr context --issue DEV-1234`: what every configured external system knows about one tracker
// issue, linked results first. Read-only, and never project-scoped — see ADR 0011.
//
// The two-tier query is here rather than in an adapter: ask each source for its own recorded link,
// and only widen to a time window when none reports one. What to do with the answer (whether an
// unlinked issue needs more information, which label to apply) belongs to the caller, not to tlr.
//
// `issueContextBatch` runs the same lookup over many issues. It selects nothing and decides nothing:
// the caller hands it the identifiers it wants answered, in the order it wants them answered.

import type { Cache } from "@/cache.ts"
import { type ContextItem, type ContextSource, gatherContext, paced } from "@/contextSource.ts"

export const DEFAULT_WINDOW_DAYS = 7

export type ContextInput = {
  issue: string
  tracker?: string
  /** The issue's own createdAt, which the window is centred on. Defaults to now. */
  createdAt?: string
  days?: number
  actor?: string
  text?: string
  limit?: number
}

export type ContextResult = {
  issue: string
  tracker: string
  window: { start: string; end: string }
  linked: number
  candidates: number
  items: ContextItem[]
  errors: { source: string; message: string }[]
}

const DAY_MS = 24 * 60 * 60 * 1000

// The anchor snaps down to its UTC day, so two issues filed hours apart ask the same question and the
// second is served from the cache. A window measured in days has no use for the finer precision.
export function windowAround(anchor: string, days: number): { start: string; end: string } {
  const at = new Date(anchor).getTime()
  if (Number.isNaN(at)) throw new Error(`not a date: ${anchor}`)
  const day = Math.floor(at / DAY_MS) * DAY_MS
  const span = days * DAY_MS
  return { start: new Date(day - span).toISOString(), end: new Date(day + span).toISOString() }
}

export async function issueContext(
  input: ContextInput,
  sources: ContextSource[],
  cache?: Cache,
): Promise<ContextResult> {
  const tracker = input.tracker ?? "linear"
  const window = windowAround(input.createdAt ?? new Date().toISOString(), input.days ?? DEFAULT_WINDOW_DAYS)
  const { items, errors } = await gatherContext(sources, {
    linkedId: { source: tracker, id: input.issue },
    net: { window, actor: input.actor, text: input.text, limit: input.limit },
    cache,
  })
  return {
    issue: input.issue,
    tracker,
    window,
    linked: items.filter((i) => i.matchKind === "linked").length,
    candidates: items.filter((i) => i.matchKind === "candidate").length,
    items,
    errors,
  }
}

export type BatchIssue = { issue: string; createdAt?: string | null }

export type BatchResult = {
  requested: number
  withLinked: number
  results: ContextResult[]
  errors: { source: string; message: string }[]
}

/**
 * The single-issue lookup run over a list, in order, sharing one cache. Each source is held to its own
 * published call budget, so a run over a whole cycle paces itself instead of earning a 429.
 */
export async function issueContextBatch(
  issues: BatchIssue[],
  input: Omit<ContextInput, "issue" | "createdAt">,
  sources: ContextSource[],
  cache?: Cache,
): Promise<BatchResult> {
  const limited = sources.map((s) => (s.rateLimitPerMinute ? paced(s, s.rateLimitPerMinute) : s))
  const results: ContextResult[] = []
  const errors = new Map<string, { source: string; message: string }>()
  for (const { issue, createdAt } of issues) {
    const result = await issueContext({ ...input, issue, createdAt: createdAt ?? undefined }, limited, cache)
    results.push(result)
    for (const err of result.errors) errors.set(`${err.source}\u0000${err.message}`, err)
  }
  return {
    requested: issues.length,
    withLinked: results.filter((r) => r.linked > 0).length,
    results,
    errors: [...errors.values()],
  }
}
