import { assert, assertAlmostEquals, assertEquals } from "@std/assert"
import {
  blockingEdges,
  cardHeight,
  geodesicDistances,
  groupKeyOf,
  layerDag,
  relationshipsLayout,
} from "../web/lib/relationships.js"
import { similarityMatrix, topNeighbors } from "../web/lib/similarity.js"

type Issue = Record<string, unknown>
// web/lib is untyped ES modules by design (adr/0009), so layout output is annotated at the boundary.
// deno-lint-ignore no-explicit-any
type Any = any

const issue = (id: string, over: Issue = {}): Issue => ({
  id,
  title: `work item ${id}`,
  description: "",
  estimate: 3,
  assignee: "Ada Lovelace",
  status: "Todo",
  statusType: "unstarted",
  labels: [],
  parentId: null,
  milestone: "M1",
  cycle: 49,
  blocks: [],
  blockedBy: [],
  ...over,
})

const chain = () => [
  issue("A", { blocks: ["B"] }),
  issue("B", { blockedBy: ["A"], blocks: ["C"] }),
  issue("C", { blockedBy: ["B"] }),
  issue("D"),
]

Deno.test("card height encodes estimate and stays within bounds", () => {
  const small = cardHeight(issue("A", { estimate: 1 }))
  const large = cardHeight(issue("A", { estimate: 13 }))
  assert(large > small, "a heavier ticket is taller")
  assert(small >= 54 && large <= 88, "height stays inside the legible range")
  assertEquals(cardHeight(issue("A", { estimate: null })), cardHeight(issue("A", { estimate: 2 })))
})

Deno.test("layerDag separates unrelated work instead of calling it wave 0", () => {
  const { layers, isolated, depth } = layerDag(chain())
  assertEquals(layers.length, 3)
  assertEquals(layers.map((l) => l.map((i: Issue) => i.id)), [["A"], ["B"], ["C"]])
  assertEquals(isolated.map((i: Issue) => i.id), ["D"])
  assertEquals(depth.get("C"), 2)
})

Deno.test("layerDag ignores a blocker that is not on the plane", () => {
  const { layers, isolated } = layerDag([issue("A", { blockedBy: ["GONE"] })])
  assertEquals(layers.length, 0)
  assertEquals(isolated.map((i: Issue) => i.id), ["A"])
})

Deno.test("blocking edges point forward and drop dangling blockers", () => {
  const edges = blockingEdges(chain())
  assertEquals(edges, [{ from: "A", to: "B", kind: "block" }, { from: "B", to: "C", kind: "block" }])
  assertEquals(blockingEdges([issue("A", { blockedBy: ["GONE"] })]), [])
})

Deno.test("sequence layout advances x with depth and never overlaps two cards", () => {
  const laid = relationshipsLayout("sequence", chain())
  const at = (id: string) => laid.nodes.find((n: Any) => n.id === id)!
  assert(at("B").x > at("A").x, "a blocked ticket sits to the right of its blocker")
  assert(at("C").x > at("B").x)
  const slots = new Set(laid.nodes.map((n: Any) => `${Math.round(n.x)},${Math.round(n.y)}`))
  assertEquals(slots.size, laid.nodes.length)
})

Deno.test("grouping layout bands by the chosen key, largest group first", () => {
  const issues = [
    issue("A", { milestone: "M1" }),
    issue("B", { milestone: "M1" }),
    issue("C", { milestone: "M2" }),
    issue("D", { milestone: null }),
  ]
  const laid = relationshipsLayout("grouping", issues, { groupBy: "milestone" })
  assertEquals(laid.regions.map((r: Any) => r.key), ["M1", "M2", "No milestone"])
  const y = (id: string) => laid.nodes.find((n: Any) => n.id === id)!.y
  assertEquals(y("A"), y("B"))
  assert(y("C") > y("A"), "a later band sits below the first")
})

Deno.test("group keys fall back rather than dropping an issue", () => {
  assertEquals(groupKeyOf(issue("A", { milestone: null }), "milestone"), "No milestone")
  assertEquals(groupKeyOf(issue("A", { cycle: null }), "cycle"), "No cycle")
  assertEquals(groupKeyOf(issue("A", { labels: [] }), "label"), "No label")
  assertEquals(groupKeyOf(issue("A", { parentId: null }), "parent"), "No parent")
  assertEquals(groupKeyOf(issue("A", { cycle: 49 }), "cycle"), "Cycle 49")
})

Deno.test("an empty plane has size and does not throw", () => {
  const laid = relationshipsLayout("sequence", [])
  assertEquals(laid.nodes.length, 0)
  assertEquals(laid.width, 80)
  assertEquals(laid.height, 80)
})

Deno.test("similarity scores shared text and labels above unrelated work", () => {
  const issues = [
    issue("A", { title: "Expire the session token on the sign-in path", labels: ["auth"] }),
    issue("B", { title: "Rotate the session token on the sign-in path", labels: ["auth"] }),
    issue("C", { title: "Crop the uploaded avatar on the profile page", labels: ["profiles"] }),
  ]
  const sim = similarityMatrix(issues)
  const n = issues.length
  assert(sim[0 * n + 1] > sim[0 * n + 2], "same-topic pair scores above a cross-topic pair")
  assertAlmostEquals(sim[0 * n + 0], 1)
  assertEquals(sim[0 * n + 1], sim[1 * n + 0], "the matrix is symmetric")
})

Deno.test("top neighbours are ranked, capped, and explained", () => {
  const issues = [
    issue("A", { title: "Expire the session token on sign-in", labels: ["auth"] }),
    issue("B", { title: "Rotate the session token on sign-in", labels: ["auth"] }),
    issue("C", { title: "Revoke the session token on sign-in", labels: ["auth"] }),
    issue("D", { title: "Crop the avatar", labels: ["profiles"], milestone: "M9" }),
  ]
  const rows = topNeighbors(issues, similarityMatrix(issues), 2)
  const a = rows.find((r: Any) => r.id === "A")!
  assert(a.neighbors.length <= 2, "k is respected")
  assert(a.neighbors.every((x: Any) => x.id !== "D"), "an unrelated ticket stays below the floor")
  assert(a.neighbors[0].why.includes("auth"), "the reason names the shared label")
})

Deno.test("an issue with nothing like it returns no neighbours", () => {
  const issues = [issue("A", { title: "Expire the session token" }), issue("B", { title: "Crop the avatar" })]
  const rows = topNeighbors(issues, similarityMatrix(issues), 5, 0.9)
  assertEquals(rows.every((r: Any) => r.neighbors.length === 0), true)
})

Deno.test("geodesic distance is symmetric and finite even across components", () => {
  const issues = [
    issue("A", { title: "session token sign-in", labels: ["auth"] }),
    issue("B", { title: "session token sign-in rotate", labels: ["auth"] }),
    issue("C", { title: "completely unrelated avatar cropping", labels: ["profiles"] }),
  ]
  const n = issues.length
  const dist = geodesicDistances(issues, similarityMatrix(issues))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      assert(Number.isFinite(dist[i * n + j]), "no unreachable pair leaks Infinity into the layout")
      assertAlmostEquals(dist[i * n + j], dist[j * n + i])
    }
  }
  assertEquals(dist[0], 0)
})

Deno.test("similarity layout is deterministic across runs", () => {
  const issues = [
    issue("A", { title: "session token sign-in", labels: ["auth"] }),
    issue("B", { title: "session token rotate sign-in", labels: ["auth"] }),
    issue("C", { title: "avatar crop upload profile", labels: ["profiles"] }),
    issue("D", { title: "avatar upload profile resize", labels: ["profiles"] }),
  ]
  const build = () => {
    const sim = similarityMatrix(issues)
    return relationshipsLayout("similarity", issues, {
      coords: issues.map((it, i) => ({ id: it.id as string, x: i, y: i % 2 })),
      neighbors: topNeighbors(issues, sim, 3),
    })
  }
  const a = build()
  const b = build()
  assertEquals(
    a.nodes.map((n: Any) => [n.id, Math.round(n.x), Math.round(n.y)]),
    b.nodes.map((n: Any) => [n.id, Math.round(n.x), Math.round(n.y)]),
  )
})
