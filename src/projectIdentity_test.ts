import { assertEquals } from "@std/assert"
import { isStableProjectKey, projectKey, resolveProjectKeys } from "@/projectIdentity.ts"

Deno.test("projectKey prefers the project id, then the slug id, then the name", () => {
  assertEquals(projectKey({ name: "Horse Tinder", id: "abc-123" }), "id:abc-123")
  assertEquals(projectKey({ name: "Horse Tinder", slugId: "C0FFEE001122" }), "slug:c0ffee001122")
  assertEquals(
    projectKey({ name: "Horse Tinder", url: "https://linear.app/acme/project/horse-tinder-c0ffee001122" }),
    "slug:c0ffee001122",
  )
  assertEquals(projectKey({ name: "  Horse   Tinder " }), "name:horse tinder")
})

Deno.test("projectKey is stable across a rename that keeps the slug id", () => {
  const before = projectKey({ name: "Horse Tinder", url: "https://linear.app/acme/project/horse-tinder-c0ffee001122" })
  const after = projectKey({
    name: "Pony Match",
    url: "https://linear.app/acme/project/pony-match-c0ffee001122/overview",
  })
  assertEquals(before, after)
})

Deno.test("projectKey falls back to the name when the url carries no slug id", () => {
  const key = projectKey({ name: "Horse Tinder (seed)", url: "https://linear.app/seed" })
  assertEquals(key, "name:horse tinder (seed)")
  assertEquals(isStableProjectKey(key), false)
})

Deno.test("resolveProjectKeys folds name-only rows into the stable key of the same project", () => {
  const assignments = resolveProjectKeys([
    { id: 1, capturedAt: 10, project: { name: "Horse Tinder", url: "https://linear.app/acme" } },
    { id: 2, capturedAt: 20, project: { name: "Horse Tinder", url: "https://linear.app/acme" } },
    { id: 3, capturedAt: 30, project: { name: "Horse Tinder", url: "https://linear.app/a/project/ht-c0ffee001122" } },
  ])
  assertEquals(assignments.map((a) => a.projectKey), [
    "slug:c0ffee001122",
    "slug:c0ffee001122",
    "slug:c0ffee001122",
  ])
})

Deno.test("resolveProjectKeys keeps two projects apart when they share a display name", () => {
  const assignments = resolveProjectKeys([
    { id: 1, capturedAt: 10, project: { name: "Platform", url: "https://linear.app/a/project/platform-aaaaaaaa1111" } },
    { id: 2, capturedAt: 20, project: { name: "Platform", url: "https://linear.app/a/project/platform-bbbbbbbb2222" } },
  ])
  assertEquals(assignments[0].projectKey, "slug:aaaaaaaa1111")
  assertEquals(assignments[1].projectKey, "slug:bbbbbbbb2222")
})
