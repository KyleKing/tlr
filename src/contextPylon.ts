// The Pylon context source (ADR 0011): support tickets, read-only, behind the ContextSource port.
// Direct REST, no MCP at runtime, because an MCP connector does not survive a scheduled or hosted run.
//
// Two calls, both POST /issues/search:
//   linked    — filter on the custom field whose value is the tracker identifier ("DEV-1234", bare)
//   candidate — created_at time_range, plus Pylon's own full-text search when the caller supplies text
//
// Pylon filters a requester by contact id, not by email, so a ContextQuery.actor that is not a Pylon
// contact uuid is dropped rather than resolved with a second round trip.
//
// Which custom field records the link is a workspace's own choice, so it is configuration. The rate
// limit on /issues/search is 20 requests a minute, which the cache in front of this port is what keeps
// a batch run under.

import { type FetchLike, fetchWithRetry } from "@/httpRetry.ts"
import { describeSecret, getSecret } from "@/secrets.ts"
import type { ContextItem, ContextQuery, ContextSource } from "@/contextSource.ts"

export const PYLON_API_URL = "https://api.usepylon.com"
export const PYLON_LINK_FIELD_ENV = "TLR_PYLON_LINK_FIELD"
export const DEFAULT_LINK_FIELD = "linear_ticket"
const DEFAULT_LIMIT = 25

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PylonOptions = {
  token: string
  linkField?: string
  fetchImpl?: FetchLike
  apiUrl?: string
}

type PylonIssue = {
  id: string
  number?: number
  title?: string
  body_html?: string
  created_at: string
  link?: string
  requester?: { id?: string; email?: string } | null
}

type Filter = Record<string, unknown>

export function pylonSource(options: PylonOptions): ContextSource {
  const linkField = options.linkField ?? Deno.env.get(PYLON_LINK_FIELD_ENV) ?? DEFAULT_LINK_FIELD
  const apiUrl = options.apiUrl ?? PYLON_API_URL
  return {
    name: "pylon",
    async search(query) {
      const filter = query.linkedId
        ? { field: linkField, operator: "equals", value: query.linkedId.id }
        : netFilter(query)
      if (!filter) return []
      const body: Record<string, unknown> = { filter, limit: query.limit ?? DEFAULT_LIMIT }
      if (!query.linkedId && query.text) body.search_text = query.text
      const res = await fetchWithRetry(`${apiUrl}/issues/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, { fetchImpl: options.fetchImpl })
      if (!res.ok) throw new Error(`Pylon → ${res.status} ${res.statusText}`)
      const json = await res.json() as { data?: PylonIssue[] }
      return (json.data ?? []).map((issue) => toItem(issue, query.linkedId ? "linked" : "candidate"))
    },
  }
}

// A window is the only filter Pylon's issue search will run on its own; everything else narrows it.
function netFilter(query: ContextQuery): Filter | null {
  if (!query.window) return null
  const subfilters: Filter[] = [{
    field: "created_at",
    operator: "time_range",
    values: [query.window.start, query.window.end],
  }]
  if (query.actor && UUID.test(query.actor)) {
    subfilters.push({ field: "requester_id", operator: "equals", value: query.actor })
  }
  return subfilters.length === 1 ? subfilters[0] : { operator: "and", subfilters }
}

function toItem(issue: PylonIssue, matchKind: ContextItem["matchKind"]): ContextItem {
  return {
    source: "pylon",
    id: issue.id,
    url: issue.link ?? `https://app.usepylon.com/issues?issueNumber=${issue.number ?? issue.id}`,
    title: issue.title,
    body: textFromHtml(issue.body_html ?? ""),
    author: issue.requester?.email ?? undefined,
    createdAt: issue.created_at,
    matchKind,
  }
}

export function textFromHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** The configured Pylon source, or null when this machine holds no Pylon token. */
export async function pylonFromEnv(): Promise<ContextSource | null> {
  const status = await describeSecret("pylon")
  if (status.source === "unset") return null
  return pylonSource({ token: await getSecret("pylon") })
}
