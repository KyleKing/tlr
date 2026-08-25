import { assertEquals } from "@std/assert"
import { buildTeamSnapshot } from "./issues.ts"

const TEAM = {
  id: "team-uuid-dev",
  key: "DEV",
  name: "Product Development",
  issueEstimationType: "fibonacci",
  issueEstimationAllowZero: false,
  issueEstimationExtended: false,
  cycles: { nodes: [{ number: 48, startsAt: "2026-07-20T00:00:00.000Z", endsAt: "2026-07-27T00:00:00.000Z" }] },
  states: { nodes: [{ id: "s-todo", name: "Todo", type: "unstarted", position: 1 }] },
}

function issueFixture(over: Partial<Record<string, unknown>> & { identifier: string }) {
  const id = over.identifier
  return {
    id: `uuid-${id}`,
    archivedAt: null,
    title: id as string,
    url: `https://linear.app/team/issue/${id}`,
    description: null,
    estimate: null,
    priority: null,
    state: { name: "Todo", type: "unstarted" },
    team: { key: "DEV" },
    assignee: null,
    cycle: { number: 48 },
    labels: { nodes: [] },
    parent: null,
    project: null,
    projectMilestone: null,
    relations: { nodes: [] },
    ...over,
  }
}

Deno.test("buildTeamSnapshot keys the project block off the team, not a project id", () => {
  // deno-lint-ignore no-explicit-any
  const snapshot = buildTeamSnapshot(TEAM as any, [])
  assertEquals(snapshot.project, { name: "DEV", teamId: "team-uuid-dev" })
  assertEquals(snapshot.milestones, [])
  assertEquals(snapshot.teams.map((t: { key: string }) => t.key), ["DEV"])
})

Deno.test("buildTeamSnapshot carries each issue's own project, including one with none", () => {
  const snapshot = buildTeamSnapshot(
    // deno-lint-ignore no-explicit-any
    TEAM as any,
    [
      issueFixture({ identifier: "DEV-1", project: { name: "Horse Tinder" } }),
      issueFixture({ identifier: "DEV-2", project: null }),
    ],
  )
  assertEquals(snapshot.issues.map((i) => [i.id, i.project]), [
    ["DEV-1", "Horse Tinder"],
    ["DEV-2", null],
  ])
})
