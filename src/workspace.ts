// Which Linear workspace a project belongs to, and whether the key a run holds can see it at all.
//
// tlr talks to two workspaces: the real one (keychain account `api-key`) and a throwaway demo one
// (`demo-key`, reachable only under TLR_DEMO=1). Both write project data files into the same
// web/data directory and the same manifest, so the scheduled run under the live key finds the demo
// project, asks Linear for it, and gets nothing back. That reads identically to a project that was
// renamed or whose access was revoked, which must keep failing loudly — so the two are told apart
// before the fetch, by comparing the workspace the project was ingested from against the one the
// active key belongs to.
//
// Every Linear project URL carries its workspace as the first path segment
// (https://linear.app/<workspaceKey>/project/...), so a project ingested before `workspaceKey` was
// recorded still resolves without a re-ingest.

const LINEAR_API_URL = "https://api.linear.app/graphql"

const ORGANIZATION_QUERY = `query Workspace { organization { urlKey } }`

export type ProjectRef = { url?: string | null; workspaceKey?: string | null }

export function workspaceKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const match = url.match(/^https?:\/\/linear\.app\/([^/]+)\/project\//i)
  return match ? match[1] : null
}

/** The workspace a project was ingested from: what ingest recorded, else its Linear URL's own key. */
export function projectWorkspaceKey(project: ProjectRef | null | undefined): string | null {
  return project?.workspaceKey ?? workspaceKeyFromUrl(project?.url)
}

/**
 * Why a project cannot be fetched with the active key, or null when it can be (or when either side is
 * unknown). Unknown means proceed: a fetch that then fails is a real failure and must be reported.
 */
export function workspaceSkipReason(
  project: ProjectRef | null | undefined,
  activeWorkspaceKey: string | null,
): string | null {
  const projectKey = projectWorkspaceKey(project)
  if (!projectKey || !activeWorkspaceKey || projectKey === activeWorkspaceKey) return null
  return `belongs to the ${projectKey} workspace, not the active key's ${activeWorkspaceKey}`
}

type Fetcher = typeof fetch

/** The workspace the given Linear key belongs to. Throws on a transport, HTTP, or GraphQL failure. */
export async function fetchWorkspaceKey(key: string, fetchImpl: Fetcher = fetch): Promise<string> {
  const res = await fetchImpl(LINEAR_API_URL, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: ORGANIZATION_QUERY }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Linear → ${res.status} ${res.statusText}`)
  const json = await res.json() as { errors?: { message: string }[]; data?: { organization?: { urlKey?: string } } }
  if (json.errors?.length) throw new Error(json.errors.map((err) => err.message).join("; "))
  const urlKey = json.data?.organization?.urlKey
  if (!urlKey) throw new Error("Linear returned no workspace for this key")
  return urlKey
}
