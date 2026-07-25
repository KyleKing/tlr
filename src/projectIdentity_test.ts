import { assertEquals } from "@std/assert"
import { isStableProjectKey, projectKey, resolveProjectKeys, slugToIdKeys } from "@/projectIdentity.ts"

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

// Captures taken before ingest recorded Linear's project id were keyed by the slugId in the URL, so
// the same project ran two histories once the id arrived. A row carrying both settles it.
Deno.test("resolveProjectKeys folds a slug key into the id key when a row links them", () => {
  const url = "https://linear.app/a/project/platform-aaaaaaaa1111"
  const assignments = resolveProjectKeys([
    { id: 1, capturedAt: 10, project: { name: "Platform", url } },
    { id: 2, capturedAt: 20, project: { name: "Platform", url } },
    { id: 3, capturedAt: 30, project: { name: "Platform", url, id: "uuid-1", slugId: "aaaaaaaa1111" } },
  ])
  assertEquals(assignments.map((a) => a.projectKey), ["id:uuid-1", "id:uuid-1", "id:uuid-1"])
})

Deno.test("resolveProjectKeys leaves a slug key alone when nothing links it to an id", () => {
  const assignments = resolveProjectKeys([
    { id: 1, capturedAt: 10, project: { name: "Platform", url: "https://linear.app/a/project/platform-aaaaaaaa1111" } },
    {
      id: 2,
      capturedAt: 20,
      project: { name: "Other", url: "https://linear.app/a/project/other-bbbbbbbb2222", id: "uuid-2" },
    },
  ])
  assertEquals(assignments[0].projectKey, "slug:aaaaaaaa1111")
  assertEquals(assignments[1].projectKey, "id:uuid-2")
})

Deno.test("slugToIdKeys only links a slug it has seen beside an id", () => {
  const links = slugToIdKeys([
    { id: 1, capturedAt: 10, project: { name: "A", url: "https://linear.app/a/project/a-aaaaaaaa1111" } },
    { id: 2, capturedAt: 20, project: { name: "B", url: "https://linear.app/a/project/b-bbbbbbbb2222", id: "uuid-b" } },
  ])
  assertEquals([...links], [["slug:bbbbbbbb2222", "id:uuid-b"]])
})
