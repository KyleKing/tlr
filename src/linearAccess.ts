// Checks whether the current Linear API key can still see specific projects (by slugId), so the
// project picker can warn instead of silently showing stale or 404ing data. Results are cached briefly
// per key+slug so switching projects or reloading the page doesn't refire the same Linear query every
// time — the picker calls this on every page load.

const LINEAR_API_URL = "https://api.linear.app/graphql"
const CACHE_TTL_MS = 5 * 60 * 1000

type CacheEntry = { accessible: boolean; at: number }
const cache = new Map<string, CacheEntry>()

// A Linear project URL looks like https://linear.app/<workspace>/project/<name-slug>-<slugId>, where
// slugId is Linear's own opaque id. A local project manifest's "slug" field isn't guaranteed to match
// that id (e.g. a hand-entered manifest entry), so callers should prefer the id parsed from the
// project's own url when one is available, and only fall back to the manifest's slug field.
export function slugIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const match = url.match(/-([0-9a-f]{6,})$/i)
  return match ? match[1] : null
}

const QUERY = `
  query ProjectAccess($slugId: String!) {
    projects(filter: { slugId: { eq: $slugId } }, first: 1) { nodes { id } }
  }
`

async function fetchAccess(key: string, slugId: string): Promise<boolean> {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { slugId } }),
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`Linear → ${res.status}`)
  const json = await res.json()
  return Boolean(json.data?.projects?.nodes?.length)
}

// Returns { [slugId]: accessible }, checking Linear only for slugs whose cache entry is missing or
// stale. A check that errors or times out is treated as inaccessible (fail closed) but not cached, so
// the next call retries rather than sticking with a possibly-transient failure.
export async function checkProjectsAccess(key: string, slugIds: string[]): Promise<Record<string, boolean>> {
  const now = Date.now()
  const result: Record<string, boolean> = {}
  await Promise.all(slugIds.map(async (slugId) => {
    const cacheKey = `${key}:${slugId}`
    const cached = cache.get(cacheKey)
    if (cached && now - cached.at < CACHE_TTL_MS) {
      result[slugId] = cached.accessible
      return
    }
    try {
      const accessible = await fetchAccess(key, slugId)
      cache.set(cacheKey, { accessible, at: now })
      result[slugId] = accessible
    } catch {
      result[slugId] = false
    }
  }))
  return result
}
