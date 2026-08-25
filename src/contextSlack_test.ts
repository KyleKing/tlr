import { assertEquals, assertRejects } from "@std/assert"
import { slackSource, textFromSlack } from "@/contextSlack.ts"
import type { FetchLike } from "@/httpRetry.ts"
import recorded from "@/fixtures/slack-search-messages.json" with { type: "json" }

const WINDOW = { start: "2026-07-27T00:00:00Z", end: "2026-08-10T00:00:00Z" }

type Sent = { url: string; query: string; auth: string | undefined }

function replay(payload: unknown, sent: Sent[]): FetchLike {
  return (url, init) => {
    const form = new URLSearchParams(String(init.body))
    sent.push({
      url,
      query: form.get("query") ?? "",
      auth: new Headers(init.headers).get("authorization") ?? undefined,
    })
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
  }
}

Deno.test("a linked lookup quotes the identifier and drops what the fuzzy search added", async () => {
  const sent: Sent[] = []
  const source = slackSource({ token: "tok", channels: ["eng", "triage"], fetchImpl: replay(recorded.linked, sent) })
  const items = await source.search({ linkedId: { source: "linear", id: "DEV-1" } })

  assertEquals(sent[0].url, "https://slack.com/api/search.messages")
  assertEquals(sent[0].auth, "Bearer tok")
  assertEquals(sent[0].query, 'in:#eng in:#triage "DEV-1"')
  assertEquals(items.length, 1)
  assertEquals(items[0].matchKind, "linked")
  assertEquals(items[0].id, "C000000AAAA:1783632226.751039")
  assertEquals(items[0].title, "#redacted-eng")
  assertEquals(items[0].author, "redacted")
  assertEquals(items[0].createdAt, "2026-07-09T21:23:46.000Z")
  assertEquals(items[0].body, "Worth a look: DEV-1 & the auth change @someone made")
})

Deno.test("the wider net widens the window past Slack's exclusive bounds and skips an empty message", async () => {
  const sent: Sent[] = []
  const source = slackSource({ token: "tok", channels: [], fetchImpl: replay(recorded.candidate, sent) })
  const items = await source.search({ window: WINDOW, text: "export", limit: 5 })

  assertEquals(sent[0].query, "export after:2026-07-26 before:2026-08-11")
  assertEquals(items.map((i) => i.matchKind), ["candidate"])
  assertEquals(items[0].author, "U000000DDDD")
})

Deno.test("a Slack user id becomes a from: term and anything else is dropped", async () => {
  const sent: Sent[] = []
  const source = slackSource({ token: "tok", channels: [], fetchImpl: replay(recorded.candidate, sent) })
  await source.search({ window: WINDOW, actor: "U000000DDDD" })
  await source.search({ window: WINDOW, actor: "someone@example.invalid", text: "export" })

  assertEquals(sent[0].query, "from:<@U000000DDDD> after:2026-07-26 before:2026-08-11")
  assertEquals(sent[1].query, "export after:2026-07-26 before:2026-08-11")
})

Deno.test("a window with nothing to narrow it is the whole workspace, so it is not asked", async () => {
  const sent: Sent[] = []
  const source = slackSource({ token: "tok", channels: [], fetchImpl: replay(recorded.candidate, sent) })
  assertEquals(await source.search({ window: WINDOW }), [])
  assertEquals(await source.search({ text: "export" }), [])
  assertEquals(sent.length, 0)
})

Deno.test("ok:false surfaces as an error rather than an empty answer", async () => {
  const source = slackSource({ token: "bad", channels: [], fetchImpl: replay(recorded.badScope, []) })
  await assertRejects(
    () => source.search({ linkedId: { source: "linear", id: "DEV-1" } }),
    Error,
    "missing_scope",
  )
})

Deno.test("textFromSlack unwraps links, mentions, and the three escaped characters", () => {
  assertEquals(
    textFromSlack("see <https://example.invalid/x|the doc> and <https://example.invalid/y>"),
    "see the doc and https://example.invalid/y",
  )
  assertEquals(
    textFromSlack("<@U1|ann> pinged <#C1|triage> about a &lt;tag&gt; &amp; more"),
    "@ann pinged #triage about a <tag> & more",
  )
})
