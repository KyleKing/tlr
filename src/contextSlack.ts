// The Slack context source (ADR 0011): messages, read-only, behind the ContextSource port. Direct REST
// against search.messages, which needs a user token (`xoxp-`) with `search:read` — a bot token cannot
// search at all.
//
// Four things the search API does that this adapter is shaped around, each confirmed against the real
// workspace rather than read off the docs:
//   - `after:`/`before:` exclude the day they name, so a window widens by a day on each side
//   - a range that excludes everything is ignored rather than obeyed, and the search answers as if no
//     dates were given, so an empty window must never reach Slack
//   - several `in:` terms are OR, which is what makes a channel list a useful scope
//   - the identifier search is fuzzy, so a match is only "linked" once the text is confirmed to hold
//     the identifier; Slack returns near misses alongside real ones
//
// A window with no text and no actor is the whole workspace for two weeks, which is noise rather than
// context, so the wider net asks for one of the two before it will run.

import { type FetchLike, fetchWithRetry } from "@/httpRetry.ts"
import { describeSecret, getSecret } from "@/secrets.ts"
import type { ContextItem, ContextQuery, ContextSource } from "@/contextSource.ts"

export const SLACK_API_URL = "https://slack.com/api"
export const SLACK_CHANNELS_ENV = "TLR_SLACK_CHANNELS"
export const SLACK_SEARCH_PER_MINUTE = 20
const DEFAULT_LIMIT = 20
const DAY_MS = 24 * 60 * 60 * 1000

const SLACK_USER_ID = /^[UW][A-Z0-9]{4,}$/

export type SlackOptions = {
  token: string
  channels?: string[]
  fetchImpl?: FetchLike
  apiUrl?: string
}

type SlackMatch = {
  ts: string
  text?: string
  user?: string
  username?: string
  permalink?: string
  channel?: { id?: string; name?: string }
}

export function slackSource(options: SlackOptions): ContextSource {
  const channels = options.channels ?? channelsFromEnv()
  const apiUrl = options.apiUrl ?? SLACK_API_URL
  return {
    name: "slack",
    rateLimitPerMinute: SLACK_SEARCH_PER_MINUTE,
    async search(query) {
      const terms = query.linkedId ? [`"${query.linkedId.id}"`] : netTerms(query)
      if (!terms) return []
      const body = new URLSearchParams({
        query: [...channels.map((c) => `in:#${c}`), ...terms].join(" "),
        count: String(query.limit ?? DEFAULT_LIMIT),
        sort: "timestamp",
      })
      const res = await fetchWithRetry(`${apiUrl}/search.messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: body.toString(),
      }, { fetchImpl: options.fetchImpl })
      if (!res.ok) throw new Error(`Slack → ${res.status} ${res.statusText}`)
      const json = await res.json() as { ok?: boolean; error?: string; messages?: { matches?: SlackMatch[] } }
      // Slack answers 200 with ok:false for a bad token or a missing scope, which must not read as
      // "nobody said anything about this issue".
      if (!json.ok) throw new Error(`Slack → ${json.error ?? "unknown error"}`)
      const matches = (json.messages?.matches ?? []).map(toItem)
      const kept = matches.filter((item) => item.body.length > 0)
      if (!query.linkedId) return kept
      const needle = query.linkedId.id.toLowerCase()
      return kept.filter((item) => item.body.toLowerCase().includes(needle)).map((item) => ({
        ...item,
        matchKind: "linked" as const,
      }))
    },
  }
}

function channelsFromEnv(): string[] {
  return (Deno.env.get(SLACK_CHANNELS_ENV) ?? "").split(",").map((c) => c.trim().replace(/^#/, "")).filter(Boolean)
}

function netTerms(query: ContextQuery): string[] | null {
  if (!query.window) return null
  const terms: string[] = []
  if (query.text) terms.push(query.text)
  if (query.actor && SLACK_USER_ID.test(query.actor)) terms.push(`from:<@${query.actor}>`)
  if (!terms.length) return null
  const after = day(query.window.start, -1)
  const before = day(query.window.end, 1)
  if (after >= before) return null
  return [...terms, `after:${after}`, `before:${before}`]
}

function day(iso: string, offsetDays: number): string {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) throw new Error(`not a date: ${iso}`)
  return new Date(at + offsetDays * DAY_MS).toISOString().slice(0, 10)
}

function toItem(match: SlackMatch): ContextItem {
  const channel = match.channel?.name
  return {
    source: "slack",
    id: `${match.channel?.id ?? "unknown"}:${match.ts}`,
    url: match.permalink ?? "",
    title: channel ? `#${channel}` : undefined,
    body: textFromSlack(match.text ?? ""),
    author: match.username ?? match.user,
    createdAt: new Date(Number(match.ts.split(".")[0]) * 1000).toISOString(),
    matchKind: "candidate",
  }
}

/** Slack's own markup as plain text: links become their label, mentions their name, entities their character. */
export function textFromSlack(text: string): string {
  return text
    .replace(/<([@#!])([^|>]+)\|([^>]*)>/g, (_whole, sigil: string, id: string, label: string) => {
      const prefix = sigil === "#" ? "#" : "@"
      return `${prefix}${label || id}`
    })
    .replace(/<([@#])([^|>]+)>/g, "$1$2")
    .replace(/<([^|>]+)\|([^>]*)>/g, "$2")
    .replace(/<([^|>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim()
}

/** The configured Slack source, or null when this machine holds no Slack user token. */
export async function slackFromEnv(): Promise<ContextSource | null> {
  const status = await describeSecret("slack")
  if (status.source === "unset") return null
  return slackSource({ token: await getSecret("slack") })
}
