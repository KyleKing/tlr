// `tlr context --issue DEV-1234`: what every configured external system knows about one tracker
// issue, linked results first. Read-only, and never project-scoped — see ADR 0011.
//
// The two-tier query is here rather than in an adapter: ask each source for its own recorded link,
// and only widen to a time window when none reports one. What to do with the answer (whether an
// unlinked issue needs more information, which label to apply) belongs to the caller, not to tlr.

import type { Cache } from "@/cache.ts"
import { type ContextItem, type ContextSource, gatherContext } from "@/contextSource.ts"

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

export function windowAround(anchor: string, days: number): { start: string; end: string } {
  const at = new Date(anchor).getTime()
  if (Number.isNaN(at)) throw new Error(`not a date: ${anchor}`)
  const span = days * 24 * 60 * 60 * 1000
  return { start: new Date(at - span).toISOString(), end: new Date(at + span).toISOString() }
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
