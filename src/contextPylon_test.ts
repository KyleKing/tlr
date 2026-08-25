import { assertEquals, assertRejects } from "@std/assert"
import { pylonSource, textFromHtml } from "@/contextPylon.ts"
import type { FetchLike } from "@/httpRetry.ts"
import recorded from "@/fixtures/pylon-issues-search.json" with { type: "json" }

const WINDOW = { start: "2026-07-27T00:00:00Z", end: "2026-08-10T00:00:00Z" }

type Sent = { url: string; body: Record<string, unknown>; auth: string | undefined }

function replay(payload: unknown, sent: Sent[], status = 200): FetchLike {
  return (url, init) => {
    sent.push({
      url,
      body: JSON.parse(String(init.body)),
      auth: new Headers(init.headers).get("authorization") ?? undefined,
    })
    return Promise.resolve(new Response(JSON.stringify(payload), { status }))
  }
}

Deno.test("a linked lookup filters the configured custom field and maps the reply", async () => {
  const sent: Sent[] = []
  const source = pylonSource({ token: "tok", linkField: "tracker_ticket", fetchImpl: replay(recorded.linked, sent) })
  const items = await source.search({ linkedId: { source: "linear", id: "DEV-1" } })

  assertEquals(sent[0].url, "https://api.usepylon.com/issues/search")
  assertEquals(sent[0].auth, "Bearer tok")
  assertEquals(sent[0].body.filter, { field: "tracker_ticket", operator: "equals", value: "DEV-1" })
  assertEquals(items.length, 1)
  assertEquals(items[0].matchKind, "linked")
  assertEquals(items[0].source, "pylon")
  assertEquals(items[0].url, "https://app.usepylon.com/issues?issueNumber=1676")
  assertEquals(items[0].author, "redacted@example.invalid")
  assertEquals(items[0].createdAt, "2026-07-30T08:15:05Z")
  assertEquals(items[0].body, "Redacted body.\nTracked in the tracker: DEV-1")
})

Deno.test("the wider net sends a created_at range and drops an actor Pylon cannot filter on", async () => {
  const sent: Sent[] = []
  const source = pylonSource({ token: "tok", fetchImpl: replay(recorded.candidate, sent) })
  const items = await source.search({ window: WINDOW, actor: "someone@example.invalid", text: "export", limit: 5 })

  assertEquals(sent[0].body.filter, {
    field: "created_at",
    operator: "time_range",
    values: [WINDOW.start, WINDOW.end],
  })
  assertEquals(sent[0].body.search_text, "export")
  assertEquals(sent[0].body.limit, 5)
  assertEquals(items.map((i) => i.matchKind), ["candidate"])
  assertEquals(items[0].author, undefined)
})

Deno.test("a contact uuid actor becomes a requester filter", async () => {
  const sent: Sent[] = []
  const actor = "0b2f6a1c-1111-4a3b-9f2e-000000000001"
  const source = pylonSource({ token: "tok", fetchImpl: replay(recorded.candidate, sent) })
  await source.search({ window: WINDOW, actor })

  assertEquals(sent[0].body.filter, {
    operator: "and",
    subfilters: [
      { field: "created_at", operator: "time_range", values: [WINDOW.start, WINDOW.end] },
      { field: "requester_id", operator: "equals", value: actor },
    ],
  })
})

Deno.test("no window and no link means no call at all", async () => {
  const sent: Sent[] = []
  const source = pylonSource({ token: "tok", fetchImpl: replay(recorded.candidate, sent) })
  assertEquals(await source.search({ text: "export" }), [])
  assertEquals(sent.length, 0)
})

Deno.test("a rejected token surfaces as an error rather than an empty answer", async () => {
  const source = pylonSource({ token: "bad", fetchImpl: replay({}, [], 401) })
  await assertRejects(() => source.search({ linkedId: { source: "linear", id: "DEV-1" } }), Error, "401")
})

Deno.test("textFromHtml keeps line structure and unescapes entities", () => {
  assertEquals(textFromHtml("<p>one</p><p>two &amp; three</p>"), "one\ntwo & three")
})
