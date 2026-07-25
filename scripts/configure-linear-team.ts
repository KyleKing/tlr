// Configure the demo workspace's TLR team settings (cycles, estimation, triage) to something more
// interesting than Linear's defaults, so local seed data (src/seed.ts) and the real ingested project
// describe the same world. Uses the demo-key account, so it can only reach the demo workspace, and
// refuses to run unless the org urlKey matches EXPECT_URLKEY — a guard so it can never touch a real
// workspace even if the wrong key were stored. Dry run by default; pass --write to apply.
//
// Idempotent by design: it reads the team's current settings, diffs them against DESIRED, and only
// mutates fields that actually differ. A second run against already-converged settings computes an
// empty diff and mutates nothing. Pointing this at a different demo team later (a fresh test project,
// or a reset) means changing TEAM_KEY alone — nothing else here names a team any other way.
//
// CAVEAT: no code in this repo has called Linear's teamUpdate mutation before, so the TeamUpdateInput
// field names/enum values below are unverified against the live API. Before the first real --write,
// confirm them with a one-off introspection query, e.g.:
//   deno run --allow-net=api.linear.app --allow-env --allow-run=security -e '...'
// or add a temporary console.log of:
//   { __type(name: "TeamUpdateInput") { inputFields { name type { name kind ofType { name } } } } }
// via the gql() helper below, and compare against this file's DESIRED keys before trusting the dry run.

import { linearKey } from "./issues.ts"

const EXPECT_URLKEY = "tlr-demo-workspace"
const TEAM_KEY = "TLR"

const DESIRED = {
  cyclesEnabled: true,
  cycleDuration: 2, // weeks — Linear's default is 1
  issueEstimationType: "fibonacci",
  issueEstimationAllowZero: true,
  issueEstimationExtended: false,
  triageEnabled: true,
}

type TeamSettings = { id: string; key: string } & typeof DESIRED

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

async function currentTeamSettings(key: string): Promise<TeamSettings> {
  const data = await gql<{ teams: { nodes: TeamSettings[] } }>(
    key,
    `{ teams(first: 50) { nodes {
      id key cyclesEnabled cycleDuration
      issueEstimationType issueEstimationAllowZero issueEstimationExtended
      triageEnabled
    } } }`,
  )
  const team = data.teams.nodes.find((t) => t.key === TEAM_KEY)
  if (!team) throw new Error(`team ${TEAM_KEY} not found in the demo workspace`)
  return team
}

function diff(current: TeamSettings): Partial<typeof DESIRED> {
  const patch: Partial<typeof DESIRED> = {}
  for (const k of Object.keys(DESIRED) as (keyof typeof DESIRED)[]) {
    if (current[k] !== DESIRED[k]) patch[k] = DESIRED[k] as never
  }
  return patch
}

async function applyTeamUpdate(key: string, teamId: string, patch: Partial<typeof DESIRED>): Promise<void> {
  await gql(
    key,
    `mutation($id: String!, $input: TeamUpdateInput!) { teamUpdate(id: $id, input: $input) { success } }`,
    { id: teamId, input: patch },
  )
}

async function main() {
  const write = Deno.args.includes("--write")
  const key = await linearKey("demo-key")
  await assertDemoWorkspace(key)

  const current = await currentTeamSettings(key)
  const patch = diff(current)

  if (!Object.keys(patch).length) {
    console.log(`${TEAM_KEY} already matches desired settings; nothing to do.`)
    return
  }

  console.log(`${write ? "APPLYING" : "DRY RUN (pass --write to apply)"} — ${TEAM_KEY} settings diff:`)
  for (const [k, v] of Object.entries(patch)) {
    console.log(`  ${k}: ${current[k as keyof TeamSettings]} → ${v}`)
  }

  if (!write) return

  await applyTeamUpdate(key, current.id, patch)
  console.log("done.")
}

if (import.meta.main) await main()
