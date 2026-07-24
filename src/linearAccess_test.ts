import { assertEquals } from "@std/assert"
import { checkProjectsAccess, slugIdFromUrl } from "@/linearAccess.ts"

Deno.test("slugIdFromUrl pulls the trailing id off a Linear project url", () => {
  assertEquals(
    slugIdFromUrl("https://linear.app/tlr-demo-workspace/project/horse-tinder-3a88da188507"),
    "3a88da188507",
  )
  assertEquals(
    slugIdFromUrl("https://linear.app/coverbasedev/project/product-reliability-2026-1c60eac693e8"),
    "1c60eac693e8",
  )
  assertEquals(slugIdFromUrl(null), null)
  assertEquals(slugIdFromUrl(""), null)
})

function stubFetch(responder: (slugId: string) => boolean | "error") {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    calls++
    const { variables } = JSON.parse(init!.body as string)
    const outcome = responder(variables.slugId)
    if (outcome === "error") return Promise.resolve(new Response("", { status: 500 }))
    return Promise.resolve(
      new Response(JSON.stringify({ data: { projects: { nodes: outcome ? [{ id: "1" }] : [] } } }), { status: 200 }),
    )
  }) as typeof fetch
  return { restore: () => (globalThis.fetch = original), calls: () => calls }
}

Deno.test("checkProjectsAccess reports found vs not-found projects", async () => {
  const stub = stubFetch((slugId) => slugId === "yes-slug")
  try {
    const result = await checkProjectsAccess("key-a", ["yes-slug", "no-slug"])
    assertEquals(result, { "yes-slug": true, "no-slug": false })
  } finally {
    stub.restore()
  }
})

Deno.test("checkProjectsAccess treats a failed request as inaccessible without caching it", async () => {
  const stub = stubFetch(() => "error")
  try {
    const first = await checkProjectsAccess("key-b", ["flaky-slug"])
    assertEquals(first, { "flaky-slug": false })
    assertEquals(stub.calls(), 1)
    await checkProjectsAccess("key-b", ["flaky-slug"])
    assertEquals(stub.calls(), 2)
  } finally {
    stub.restore()
  }
})

Deno.test("checkProjectsAccess caches a successful result across calls", async () => {
  const stub = stubFetch(() => true)
  try {
    await checkProjectsAccess("key-c", ["cached-slug"])
    assertEquals(stub.calls(), 1)
    const second = await checkProjectsAccess("key-c", ["cached-slug"])
    assertEquals(second, { "cached-slug": true })
    assertEquals(stub.calls(), 1)
  } finally {
    stub.restore()
  }
})
