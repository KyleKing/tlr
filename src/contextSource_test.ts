import { assert, assertEquals } from "@std/assert"
import { openCache } from "@/cache.ts"
import { type ContextSource, fixtureSource, gatherContext } from "@/contextSource.ts"

const RECORDS = [
  {
    source: "fake",
    id: "1",
    url: "https://example.test/1",
    title: "Export times out",
    body: "Tracked in the tracker",
    author: "reporter@example.test",
    createdAt: "2026-08-01T00:00:00Z",
    links: ["linear:DEV-1"],
  },
  {
    source: "fake",
    id: "2",
    url: "https://example.test/2",
    title: "Slow export",
    body: "Same week, nobody linked it",
    author: "other@example.test",
    createdAt: "2026-08-03T00:00:00Z",
  },
  {
    source: "fake",
    id: "3",
    url: "https://example.test/3",
    title: "Billing question",
    body: "Unrelated and outside the window",
    author: "reporter@example.test",
    createdAt: "2026-05-01T00:00:00Z",
  },
]

const WINDOW = { start: "2026-07-25T00:00:00Z", end: "2026-08-08T00:00:00Z" }

Deno.test("a linked id returns only what the source itself recorded", async () => {
  const items = await fixtureSource("fake", RECORDS).search({ linkedId: { source: "linear", id: "DEV-1" } })
  assertEquals(items.map((i) => i.id), ["1"])
  assertEquals(items[0].matchKind, "linked")
})

Deno.test("the wider net is bounded by window, actor, and text", async () => {
  const source = fixtureSource("fake", RECORDS)
  assertEquals((await source.search({ window: WINDOW })).map((i) => i.id), ["1", "2"])
  assertEquals((await source.search({ window: WINDOW, actor: "other@example.test" })).map((i) => i.id), ["2"])
  assertEquals((await source.search({ text: "billing" })).map((i) => i.id), ["3"])
  const candidates = await source.search({ window: WINDOW })
  for (const item of candidates) assertEquals(item.matchKind, "candidate")
})

Deno.test("gatherContext skips the wider net for a source that reports a link", async () => {
  const source = fixtureSource("fake", RECORDS)
  const queries: unknown[] = []
  const spy: ContextSource = {
    name: source.name,
    search(query) {
      queries.push(query)
      return source.search(query)
    },
  }
  const { items } = await gatherContext([spy], {
    linkedId: { source: "linear", id: "DEV-1" },
    net: { window: WINDOW },
  })
  assertEquals(items.map((i) => i.id), ["1"])
  assertEquals(queries.length, 1)
})

Deno.test("gatherContext falls back to the net, orders linked first, and caches", async () => {
  const cache = openCache(null)
  let calls = 0
  const backing = fixtureSource("fake", RECORDS)
  const counting: ContextSource = {
    name: "fake",
    search(query) {
      calls++
      return backing.search(query)
    },
  }
  const linked = fixtureSource("other", [{ ...RECORDS[1], source: "other", links: ["linear:DEV-9"] }])
  const options = { linkedId: { source: "linear", id: "DEV-9" }, net: { window: WINDOW }, cache }

  const first = await gatherContext([counting, linked], options)
  assertEquals(first.items.map((i) => `${i.source}:${i.matchKind}`), [
    "other:linked",
    "fake:candidate",
    "fake:candidate",
  ])
  assertEquals(calls, 2)

  const second = await gatherContext([counting, linked], options)
  assertEquals(second.items, first.items)
  assertEquals(calls, 2)
})

Deno.test("one failing source does not sink the rest", async () => {
  const broken: ContextSource = {
    name: "broken",
    search: () => Promise.reject(new Error("429 from upstream")),
  }
  const { items, errors } = await gatherContext([broken, fixtureSource("fake", RECORDS)], {
    net: { window: WINDOW },
  })
  assertEquals(items.map((i) => i.id), ["2", "1"])
  assertEquals(errors.length, 1)
  assertEquals(errors[0].source, "broken")
  assert(errors[0].message.includes("429"))
})
