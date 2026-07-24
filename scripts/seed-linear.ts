// Seed the free/test Linear workspace with a throwaway "Horse Tinder" project so the write path has
// real issues (each with a Linear UUID) to edit. Uses the demo-key account, so it can only reach the
// demo workspace, and refuses to run unless the org urlKey matches EXPECT_URLKEY — a guard so it can
// never touch a real workspace even if the wrong key were stored. Dry run by default; pass --write to
// apply. A re-run archives the project's current issues first (reversible in Linear, scoped to this
// project), so the data stays fresh without piling up duplicates or hard-deleting anything.

import { linearKey } from "./issues.ts"

const EXPECT_URLKEY = "tlr-demo-workspace"
const TEAM_KEY = "TLR"
const PROJECT_NAME = "Horse Tinder"

type Fixture = {
  key: string
  title: string
  milestone: string | null
  estimate: number
  priority: number
  assign: boolean
  description: string
  blockedBy?: string
}

const MILESTONES: { key: string; name: string; targetDate: string }[] = [
  { key: "M1", name: "M1: Matchmaking engine", targetDate: "2026-08-15" },
  { key: "M2", name: "M2: Stable profiles", targetDate: "2026-09-15" },
  { key: "M3", name: "M3: Neigh-bors chat", targetDate: "2026-10-15" },
  { key: "M4", name: "M4: Trust and safety", targetDate: "2026-11-15" },
]

// A couple of descriptions are deliberate AI slop (stock phrases, checklists, dashes) so the Review
// page's slop flag and the fix-in-place flow have something real to catch.
const SLOP =
  "This ticket will comprehensively leverage a robust, seamless approach to delight our equine users; it delves into the core.\n- [ ] step one\n- [ ] step two"

const ISSUES: Fixture[] = [
  {
    key: "H1",
    title: "Swipe gestures for hoof-friendly screens",
    milestone: "M1",
    estimate: 3,
    priority: 2,
    assign: true,
    description: "Large tap targets and a forgiving swipe threshold for horses using their noses.",
  },
  {
    key: "H2",
    title: "Match algorithm: pair by breed and temperament",
    milestone: "M1",
    estimate: 5,
    priority: 1,
    assign: true,
    description: "Score candidates on breed compatibility, temperament, and shared disciplines.",
  },
  {
    key: "H3",
    title: "Geo-fence to nearby paddocks",
    milestone: "M1",
    estimate: 2,
    priority: 3,
    assign: false,
    description: "Only surface matches within a configurable trotting distance.",
  },
  {
    key: "H4",
    title: "Deduplicate stallion accounts",
    milestone: "M1",
    estimate: 3,
    priority: 2,
    assign: false,
    description: SLOP,
  },
  {
    key: "H5",
    title: "Upload and crop mane shots",
    milestone: "M2",
    estimate: 2,
    priority: 3,
    assign: true,
    description: "Photo upload with a crop tool tuned for tall aspect ratios.",
  },
  {
    key: "H6",
    title: "Profile fields: gait, discipline, favorite hay",
    milestone: "M2",
    estimate: 3,
    priority: 3,
    assign: false,
    description: "Structured profile fields so matching has signal to work with.",
  },
  {
    key: "H7",
    title: "Verified-vet badge",
    milestone: "M2",
    estimate: 5,
    priority: 2,
    assign: false,
    description: SLOP,
    blockedBy: "H6",
  },
  {
    key: "H8",
    title: "Real-time whinny messaging",
    milestone: "M3",
    estimate: 8,
    priority: 1,
    assign: true,
    description: "Websocket chat between matched horses, with typing indicators.",
  },
  {
    key: "H9",
    title: "Canned openers (icebreakers)",
    milestone: "M3",
    estimate: 1,
    priority: 4,
    assign: false,
    description: "A few starter messages for shy horses.",
  },
  {
    key: "H10",
    title: "Push notifications for new matches",
    milestone: "M3",
    estimate: 3,
    priority: 2,
    assign: false,
    description: "Notify on a new match or message.",
    blockedBy: "H8",
  },
  {
    key: "H11",
    title: "Report and block bad actors",
    milestone: "M4",
    estimate: 3,
    priority: 1,
    assign: true,
    description: "Let horses report and block accounts, with a moderation trail.",
  },
  {
    key: "H12",
    title: "Photo moderation queue",
    milestone: "M4",
    estimate: 5,
    priority: 2,
    assign: false,
    description: SLOP,
  },
  {
    key: "H13",
    title: "Age verification (foals excluded)",
    milestone: "M4",
    estimate: 2,
    priority: 1,
    assign: true,
    description: "Confirm horses are of age before matching.",
  },
  {
    key: "H14",
    title: "Dark mode for late-night browsing",
    milestone: null,
    estimate: 1,
    priority: 4,
    assign: false,
    description: "A dark theme for the barn at night.",
  },
  {
    key: "H15",
    title: "Analytics: swipe funnel",
    milestone: null,
    estimate: 2,
    priority: 3,
    assign: false,
    description: "Track swipes, matches, and first messages.",
  },
]

const API = "https://api.linear.app/graphql"

async function gql<T>(key: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Linear → ${res.status} ${res.statusText}`)
  const json = await res.json() as { errors?: { message: string }[]; data: T }
  if (json.errors?.length) throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join("; ")}`)
  return json.data
}

async function assertDemoWorkspace(key: string): Promise<void> {
  const { organization } = await gql<{ organization: { urlKey: string; name: string } }>(
    key,
    `{ organization { urlKey name } }`,
  )
  if (organization.urlKey !== EXPECT_URLKEY) {
    throw new Error(
      `refusing to write: org is "${organization.urlKey}", expected "${EXPECT_URLKEY}". ` +
        `The demo-key must point at the demo workspace.`,
    )
  }
}

async function teamId(key: string): Promise<{ id: string; viewerId: string }> {
  const data = await gql<{ teams: { nodes: { id: string; key: string }[] }; viewer: { id: string } }>(
    key,
    `{ teams(first: 50) { nodes { id key } } viewer { id } }`,
  )
  const team = data.teams.nodes.find((t) => t.key === TEAM_KEY)
  if (!team) throw new Error(`team ${TEAM_KEY} not found in the demo workspace`)
  return { id: team.id, viewerId: data.viewer.id }
}

type ExistingProject = { id: string; issues: { id: string }[]; milestones: { id: string; name: string }[] }

async function findProject(key: string, tId: string): Promise<ExistingProject | null> {
  const data = await gql<
    {
      team: {
        projects: {
          nodes: {
            id: string
            name: string
            issues: { nodes: { id: string }[] }
            projectMilestones: { nodes: { id: string; name: string }[] }
          }[]
        }
      }
    }
  >(
    key,
    `query($id: String!) {
      team(id: $id) {
        projects(first: 50) {
          nodes {
            id name
            issues(first: 250) { nodes { id } }
            projectMilestones(first: 50) { nodes { id name } }
          }
        }
      }
    }`,
    { id: tId },
  )
  const p = data.team.projects.nodes.find((n) => n.name === PROJECT_NAME)
  if (!p) return null
  return { id: p.id, issues: p.issues.nodes, milestones: p.projectMilestones.nodes }
}

async function createProject(key: string, tId: string): Promise<string> {
  const data = await gql<{ projectCreate: { project: { id: string } } }>(
    key,
    `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }`,
    { input: { name: PROJECT_NAME, teamIds: [tId], description: "A dating app for horses. Seed data for tlr." } },
  )
  return data.projectCreate.project.id
}

async function archiveIssue(key: string, id: string): Promise<void> {
  await gql(key, `mutation($id: String!) { issueArchive(id: $id) { success } }`, { id })
}

async function ensureMilestones(
  key: string,
  projectId: string,
  existing: { id: string; name: string }[],
): Promise<Map<string, string>> {
  const byName = new Map(existing.map((m) => [m.name, m.id]))
  const ids = new Map<string, string>()
  for (const m of MILESTONES) {
    const found = byName.get(m.name)
    if (found) {
      ids.set(m.key, found)
      continue
    }
    const data = await gql<{ projectMilestoneCreate: { projectMilestone: { id: string } } }>(
      key,
      `mutation($input: ProjectMilestoneCreateInput!) {
        projectMilestoneCreate(input: $input) { projectMilestone { id } }
      }`,
      { input: { name: m.name, projectId, targetDate: m.targetDate } },
    )
    ids.set(m.key, data.projectMilestoneCreate.projectMilestone.id)
  }
  return ids
}

async function createIssue(
  key: string,
  input: Record<string, unknown>,
): Promise<{ id: string; identifier: string }> {
  const data = await gql<{ issueCreate: { issue: { id: string; identifier: string } } }>(
    key,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
    { input },
  )
  return data.issueCreate.issue
}

async function createRelation(key: string, issueId: string, relatedIssueId: string): Promise<void> {
  await gql(
    key,
    `mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`,
    { input: { issueId, relatedIssueId, type: "blocks" } },
  )
}

function planText(): string {
  const lines = [
    `Project: ${PROJECT_NAME} (team ${TEAM_KEY})`,
    `Milestones: ${MILESTONES.map((m) => m.name).join(", ")}`,
  ]
  for (const i of ISSUES) {
    const bits = [i.milestone ?? "backlog", `${i.estimate}pt`, `P${i.priority}`, i.assign ? "assigned" : "unassigned"]
    lines.push(`  ${i.key} ${i.title} [${bits.join(", ")}]${i.blockedBy ? ` (blocked by ${i.blockedBy})` : ""}`)
  }
  return lines.join("\n")
}

async function main() {
  const write = Deno.args.includes("--write")
  const key = await linearKey("demo-key")
  await assertDemoWorkspace(key)

  if (!write) {
    console.log("DRY RUN (pass --write to apply)\n")
    console.log(planText())
    return
  }

  const { id: tId, viewerId } = await teamId(key)
  const existing = await findProject(key, tId)

  if (existing) {
    console.log(`pruning: archiving ${existing.issues.length} existing issue(s) in ${PROJECT_NAME}`)
    for (const i of existing.issues) await archiveIssue(key, i.id)
  }
  const projectId = existing?.id ?? await createProject(key, tId)
  const milestoneIds = await ensureMilestones(key, projectId, existing?.milestones ?? [])

  const created = new Map<string, string>()
  for (const f of ISSUES) {
    const input: Record<string, unknown> = {
      teamId: tId,
      projectId,
      title: f.title,
      description: f.description,
      estimate: f.estimate,
      priority: f.priority,
    }
    if (f.milestone) input.projectMilestoneId = milestoneIds.get(f.milestone)
    if (f.assign) input.assigneeId = viewerId
    const issue = await createIssue(key, input)
    created.set(f.key, issue.id)
    console.log(`created ${issue.identifier} ${f.title}`)
  }

  for (const f of ISSUES) {
    if (!f.blockedBy) continue
    const blocker = created.get(f.blockedBy)
    const blocked = created.get(f.key)
    if (blocker && blocked) await createRelation(key, blocker, blocked)
  }

  console.log(`\ndone: ${ISSUES.length} issues in ${PROJECT_NAME}. Refresh in tlr (demo mode) to ingest them.`)
}

if (import.meta.main) await main()
