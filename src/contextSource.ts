// The read-only enrichment port (ADR 0011): one interface over external systems that hold context
// about a tracker issue — a support ticket, a chat thread, a pull request. A context source never
// writes, never joins a snapshot, and is never queried by planning code.
//
// Nothing here is project-scoped. A support ticket belongs to no Linear project, so the cache keys on
// (source, query) alone — see src/cache.ts.

import { type Cache, openCache } from "@/cache.ts"

export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

export type ContextQuery = {
  /** The source's own record of the link — a custom field, an attachment, a PR body reference. */
  linkedId?: { source: string; id: string }
  text?: string
  window?: { start: string; end: string }
  /** Reporter email or handle, when known. */
  actor?: string
  limit?: number
}

export type ContextItem = {
  source: string
  id: string
  url: string
  title?: string
  body: string
  author?: string
  createdAt: string
  matchKind: "linked" | "candidate"
}

export interface ContextSource {
  readonly name: string
  search(query: ContextQuery): Promise<ContextItem[]>
}

/**
 * Wrap a source so identical queries are served from the cache. The wrapper owns the TTL, so an
 * adapter stays a plain fetch-and-map.
 */
export function cached(source: ContextSource, cache: Cache, ttlMs = DEFAULT_TTL_MS): ContextSource {
  return {
    name: source.name,
    async search(query) {
      const hit = cache.get<ContextItem[]>(source.name, query, ttlMs)
      if (hit) return hit
      const items = await source.search(query)
      cache.set(source.name, query, items)
      return items
    },
  }
}

export type GatherOptions = {
  linkedId?: { source: string; id: string }
  /** The wider net, used only for a source that reports no link. */
  net?: Omit<ContextQuery, "linkedId">
  cache?: Cache
  ttlMs?: number
}

/**
 * Ask every source about one issue, linked results first. A source that records the link is not asked
 * the wider question, because a confirmed link is the answer the caller wanted. A source that throws
 * is reported rather than failing the whole lookup.
 */
export async function gatherContext(
  sources: ContextSource[],
  options: GatherOptions,
): Promise<{ items: ContextItem[]; errors: { source: string; message: string }[] }> {
  const cache = options.cache ?? openCache(null)
  const errors: { source: string; message: string }[] = []
  const perSource = await Promise.all(sources.map(async (raw) => {
    const source = cached(raw, cache, options.ttlMs)
    try {
      const linked = options.linkedId ? await source.search({ linkedId: options.linkedId }) : []
      if (linked.length || !options.net) return linked
      return await source.search(options.net)
    } catch (err) {
      errors.push({ source: source.name, message: err instanceof Error ? err.message : String(err) })
      return []
    }
  }))
  const items = perSource.flat().sort(byLinkedThenRecent)
  return { items, errors }
}

function byLinkedThenRecent(a: ContextItem, b: ContextItem): number {
  if (a.matchKind !== b.matchKind) return a.matchKind === "linked" ? -1 : 1
  return b.createdAt.localeCompare(a.createdAt)
}

export type FixtureRecord = Omit<ContextItem, "matchKind"> & {
  /** Tracker identifiers this record names itself, as `${source}:${id}`. */
  links?: string[]
}

/**
 * A fixture-backed source with no network, for tests and for `context --fake`. Matching is
 * deliberately crude: an exact link, else substring text plus an inclusive date window.
 */
export function fixtureSource(name: string, records: FixtureRecord[]): ContextSource {
  return {
    name,
    search(query) {
      if (query.linkedId) {
        const key = `${query.linkedId.source}:${query.linkedId.id}`
        return Promise.resolve(records.filter((r) => r.links?.includes(key)).map((r) => toItem(r, "linked")))
      }
      const matched = records.filter((r) => matchesNet(r, query)).map((r) => toItem(r, "candidate"))
      return Promise.resolve(query.limit ? matched.slice(0, query.limit) : matched)
    },
  }
}

function matchesNet(record: FixtureRecord, query: ContextQuery): boolean {
  if (query.window && (record.createdAt < query.window.start || record.createdAt > query.window.end)) return false
  if (query.actor && record.author !== query.actor) return false
  if (query.text) {
    const haystack = `${record.title ?? ""} ${record.body}`.toLowerCase()
    const hit = query.text.toLowerCase().split(/\s+/).filter(Boolean).some((word) => haystack.includes(word))
    if (!hit) return false
  }
  return true
}

function toItem(record: FixtureRecord, matchKind: ContextItem["matchKind"]): ContextItem {
  const { links: _links, ...item } = record
  return { ...item, matchKind }
}
