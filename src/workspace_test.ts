import { assert, assertEquals, assertRejects } from "@std/assert"
import { fetchWorkspaceKey, projectWorkspaceKey, workspaceKeyFromUrl, workspaceSkipReason } from "@/workspace.ts"

const LIVE = "https://linear.app/coverbasedev/project/product-reliability-2026-1c60eac693e8"
const DEMO = "https://linear.app/tlr-demo-workspace/project/horse-tinder-3a88da188507"

Deno.test("workspaceKeyFromUrl reads the workspace out of a Linear project URL", () => {
  assertEquals(workspaceKeyFromUrl(LIVE), "coverbasedev")
  assertEquals(workspaceKeyFromUrl(DEMO), "tlr-demo-workspace")
})

Deno.test("workspaceKeyFromUrl returns null for anything that is not a project URL", () => {
  assertEquals(workspaceKeyFromUrl("https://linear.app/seed"), null)
  assertEquals(workspaceKeyFromUrl("https://example.com/coverbasedev/project/x-1"), null)
  assertEquals(workspaceKeyFromUrl(null), null)
  assertEquals(workspaceKeyFromUrl(undefined), null)
})

// The migration path: a project ingested before workspaceKey existed still resolves from its own URL,
// so the scheduled run skips it correctly with no re-ingest.
Deno.test("projectWorkspaceKey prefers the recorded key and falls back to the URL", () => {
  assertEquals(projectWorkspaceKey({ url: LIVE, workspaceKey: "recorded" }), "recorded")
  assertEquals(projectWorkspaceKey({ url: DEMO }), "tlr-demo-workspace")
  assertEquals(projectWorkspaceKey(null), null)
})

Deno.test("workspaceSkipReason names the mismatch between a project and the active key", () => {
  const reason = workspaceSkipReason({ url: DEMO }, "coverbasedev")
  assert(reason?.includes("tlr-demo-workspace"))
  assert(reason?.includes("coverbasedev"))
})

// Fail open: a project the active key really cannot see any more must still reach the fetch and fail
// loudly, so the check only ever fires when both workspaces are known and differ.
Deno.test("workspaceSkipReason stays silent when the workspaces match or either is unknown", () => {
  assertEquals(workspaceSkipReason({ url: LIVE }, "coverbasedev"), null)
  assertEquals(workspaceSkipReason({ url: LIVE }, null), null)
  assertEquals(workspaceSkipReason({ url: "https://linear.app/seed" }, "coverbasedev"), null)
})

function stubFetch(payload: unknown, status = 200): typeof fetch {
  return (() => Promise.resolve(new Response(JSON.stringify(payload), { status }))) as typeof fetch
}

Deno.test("fetchWorkspaceKey reads the organization urlKey", async () => {
  const key = await fetchWorkspaceKey("k", stubFetch({ data: { organization: { urlKey: "coverbasedev" } } }))
  assertEquals(key, "coverbasedev")
})

Deno.test("fetchWorkspaceKey throws on a GraphQL error, an HTTP error, and an empty answer", async () => {
  await assertRejects(() => fetchWorkspaceKey("k", stubFetch({ errors: [{ message: "denied" }] })), Error, "denied")
  await assertRejects(() => fetchWorkspaceKey("k", stubFetch({}, 401)), Error, "401")
  await assertRejects(() => fetchWorkspaceKey("k", stubFetch({ data: { organization: {} } })), Error, "no workspace")
})
