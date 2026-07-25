// Refresh project, cycles, milestones, and issues in a board data file from Linear.
//
//   deno task issues "Project name"                      # write web/data/cpu.json
//   deno task issues "Project name" --data web/data/other.json --dry-run
//
// Fetches the project (and its team's cycles and its milestones) by name or slug, then every issue
// on the project, and replaces the project/cycles/currentCycle/milestones/issues blocks in the data
// file. Also resolves any new assignee names to emails in capacity.roster (see scripts/roster.ts's
// resolveRoster), so a single run keeps the roster current without a separate step. capacity.people,
// teamVelocity, and teamCapacityPerCycle are left alone — `deno task capacity` owns those. Bearer key
// from the macOS keychain, service `tlr-linear`, account `api-key`, or the LINEAR_API_KEY env var.
//
// Fetches cycles from every team on the project, not just the first: a project can span multiple
// teams (e.g. this one has both Customer Ops and Product Development), and taking only teams(first: 1)
// silently picked the wrong team's cycles whenever the actual issues lived on a different one. Each
// team's cycles connection is also ordered oldest-first, so `last: N` (not `first: N`) is required to
// get the N most recent cycles — on a long-running team, `first: 12` would return the earliest 12
// cycles ever created, none of which overlap any current issue's cycle.

import {
  buildCycles,
  buildMilestones,
  buildTeams,
  currentCycleNumber,
  dedupeByDataFile,
  mergeIngest,
  milestoneKey,
  projectEstimateScale,
  transformIssue,
  upsertProjectManifest,
} from "../web/lib/issues.js"
import { resolveRoster } from "./roster.ts"
import { writeJsonAtomic } from "@/capture.ts"
import { fetchWithRetry } from "@/httpRetry.ts"
import { getSecret } from "@/secrets.ts"
import { workspaceKeyFromUrl } from "@/workspace.ts"

const LINEAR_API_URL = "https://api.linear.app/graphql"
const DEFAULT_DATA = new URL("../web/data/cpu.json", import.meta.url).pathname
const MANIFEST_URL = new URL("../web/data/projects.json", import.meta.url)
const MANIFEST_PATH = MANIFEST_URL.pathname

// first: 10 (not 50) on the outer projects connection — fetching every team's cycles and states for
// each candidate makes this query's complexity scale with outer * teams * (cycles + states), and
// Linear rejects anything over its complexity budget ("Query too complex"). Measured against the real
// workspace at 10 matched projects with both nested connections and it is accepted; widening any of
// the three limits is what to reconsider first if it ever is not.
const PROJECT_QUERY = `
  query Projects($filter: ProjectFilter) {
    projects(filter: $filter, first: 10) {
      nodes {
        id
        name
        url
        slugId
        startDate
        targetDate
        projectMilestones(first: 50) { nodes { id name targetDate progress } }
        teams(first: 10) {
          nodes {
            id
            key
            name
            issueEstimationType
            issueEstimationAllowZero
            issueEstimationExtended
            cycles(last: 12) { nodes { number startsAt endsAt } }
            states(first: 50) { nodes { id name type position } }
          }
        }
      }
    }
  }
`

// includeArchived: true because Linear's issues connection hides archived issues by default, which
// makes an archived ticket byte-identical to one deleted or moved off the project. The diff has to be
// able to tell those apart, so ingest fetches both and marks each issue with archivedAt.
const ISSUES_QUERY = `
  query ProjectIssues($projectId: ID!, $after: String) {
    issues(filter: { project: { id: { eq: $projectId } } }, first: 100, after: $after, includeArchived: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        archivedAt
        title
        url
        description
        estimate
        priority
        state { name type }
        team { key }
        assignee { name }
        cycle { number }
        labels(first: 20) { nodes { name } }
        parent { identifier }
        projectMilestone { id }
        relations(first: 20) { nodes { type relatedIssue { identifier } } }
      }
    }
  }
`

type ProjectMilestoneNode = { id: string; name: string; targetDate: string; progress: number | null }
type CycleNode = { number: number; startsAt: string; endsAt: string }
type StateNode = { id: string; name: string; type: string; position: number }
type TeamNode = {
  id: string
  key: string
  name: string
  issueEstimationType: string
  issueEstimationAllowZero: boolean
  issueEstimationExtended: boolean
  cycles: { nodes: CycleNode[] }
  states: { nodes: StateNode[] }
}
type ProjectNode = {
  id: string
  name: string
  url: string
  slugId: string
  startDate: string
  targetDate: string
  projectMilestones: { nodes: ProjectMilestoneNode[] }
  teams: { nodes: TeamNode[] }
}
type ProjectsResponse = { projects: { nodes: ProjectNode[] } }

type IssueNode = {
  id: string
  identifier: string
  archivedAt: string | null
  title: string
  url: string
  description: string | null
  estimate: number | null
  priority: number | null
  state: { name: string; type: string } | null
  team: { key: string } | null
  assignee: { name: string } | null
  cycle: { number: number } | null
  labels: { nodes: { name: string }[] }
  parent: { identifier: string } | null
  projectMilestone: { id: string } | null
  relations: { nodes: { type: string; relatedIssue: { identifier: string } }[] }
}
type IssuesResponse = {
  issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: IssueNode[] }
}

type GqlResponse<T> = { errors?: { message: string }[]; data: T }

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = { data: DEFAULT_DATA }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") args.dryRun = true
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i]
    else positional.push(a)
  }
  return { ...(args as { data: string; dryRun?: boolean }), project: positional[0] }
}

// account "api-key" is the real workspace; "demo-key" is the free/test workspace used in demo mode.
export function linearKey(account: "api-key" | "demo-key" = "api-key"): Promise<string> {
  return getSecret(account === "demo-key" ? "linear-demo" : "linear")
}

async function gql<T>(key: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res: Response = await fetchWithRetry(LINEAR_API_URL, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Linear → ${res.status} ${res.statusText}`)
  const json: GqlResponse<T> = await res.json()
  if (json.errors) throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join("; ")}`)
  return json.data
}

async function findProject(key: string, query: string): Promise<ProjectNode> {
  let nodes = (await gql<ProjectsResponse>(key, PROJECT_QUERY, { filter: { name: { containsIgnoreCase: query } } }))
    .projects.nodes
  if (!nodes.length) {
    nodes = (await gql<ProjectsResponse>(key, PROJECT_QUERY, { filter: { slugId: { containsIgnoreCase: query } } }))
      .projects.nodes
  }
  if (!nodes.length) throw new Error(`no Linear project matches "${query}"`)
  if (nodes.length === 1) return nodes[0]

  // Guessing here is the expensive mistake: ingest writes project.name, the data file, and the
  // manifest entry, so picking the wrong candidate overwrites the real project's history under its
  // own name. An exact match settles it; anything else is the caller's to disambiguate.
  const exact = nodes.find((p) =>
    p.name.toLowerCase() === query.toLowerCase() || p.slugId.toLowerCase() === query.toLowerCase()
  )
  if (exact) return exact
  const candidates = nodes.map((p) => `${p.name} (${p.slugId})`).join(", ")
  throw new Error(`"${query}" matches ${nodes.length} Linear projects: ${candidates} — pass an exact name or slug`)
}

async function fetchAllIssues(key: string, projectId: string): Promise<IssueNode[]> {
  const issues: IssueNode[] = []
  let after: string | null = null
  do {
    const page: IssuesResponse["issues"] = (await gql<IssuesResponse>(key, ISSUES_QUERY, { projectId, after })).issues
    issues.push(...page.nodes)
    // A next page with no cursor to reach it would otherwise end the loop quietly, and a truncated
    // issue list captured as a snapshot reads as a mass deletion. Fail the ingest instead.
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new Error(`Linear paginated ${issues.length} issues then reported another page with no cursor`)
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return issues
}

// Fetches projectQuery's issues/cycles/milestones from Linear, merges them into existingData, resolves
// the roster, and upserts the projects.json manifest entry for dataFile (its basename). Returns the
// merged data (not yet written) and a human-readable log. Used by both the CLI (main, below) and the
// config panel's /api/refresh endpoint (scripts/serve.ts).
export async function ingestProject(key: string, projectQuery: string, existingData: unknown, dataFile: string) {
  const project = await findProject(key, projectQuery)
  const rawIssues = await fetchAllIssues(key, project.id)

  const milestones = buildMilestones(project.projectMilestones.nodes)
  const milestoneKeyById = new Map(project.projectMilestones.nodes.map((m) => [m.id, milestoneKey(m.name)]))
  const issues = rawIssues.map((i) => transformIssue(i, milestoneKeyById))
  const asOf = new Date().toISOString().slice(0, 10)

  // Cycle numbers are only unique per team, so pooling cycles across a multi-team project can produce
  // two different teams' cycles with overlapping date windows (same "current" week, different number) —
  // currentCycleNumber can't tell those apart. Keeping only cycle numbers the project's own issues
  // actually reference resolves the ambiguity in favor of whichever team is doing the work, and matches
  // the board's own behavior of hiding any cycle bucket with no issues in it anyway.
  const referencedCycles = new Set(issues.map((i) => i.cycle).filter((n) => n != null))
  const cycles = buildCycles(project.teams.nodes.flatMap((t) => t.cycles.nodes)).filter((c) =>
    referencedCycles.has(c.n)
  )

  // id and slugId ride along so src/projectIdentity.ts keys the snapshot history off Linear's own
  // identifiers instead of parsing a slugId back out of the URL or falling through to the display
  // name, which forks the history the moment someone renames the project. workspaceKey records which
  // Linear workspace answered, so a run holding the other key can skip the project instead of
  // reporting it missing (src/workspace.ts).
  const teams = buildTeams(project.teams.nodes)
  const fresh = {
    project: {
      id: project.id,
      name: project.name,
      slugId: project.slugId,
      start: project.startDate,
      target: project.targetDate,
      url: project.url,
      workspaceKey: workspaceKeyFromUrl(project.url),
    },
    teams,
    // The project-wide estimate scale, for a caller that wants one list and does not care which team a
    // ticket sits on. teams[].estimation is the exact source; this is the flattened convenience view.
    estimateScale: projectEstimateScale(teams),
    cycles,
    currentCycle: currentCycleNumber(cycles, asOf),
    milestones,
    issues,
    asOf,
  }

  const log = [
    `issues: ${project.name} — ${fresh.issues.length} issues, ${milestones.length} milestones, ` +
    `${fresh.teams.length} teams`,
  ]
  const merged = mergeIngest(existingData ?? {}, fresh)

  const roster = await resolveRoster(key, merged)
  log.push(`roster: ${roster.total} assignees, ${roster.resolved.length} resolved, ${roster.missing.length} unresolved`)
  for (const r of roster.resolved) log.push(`  ${r}`)
  if (roster.missing.length) log.push(`  unresolved (left blank): ${roster.missing.join(", ")}`)

  const manifest = await Deno.readTextFile(MANIFEST_PATH).then(JSON.parse).catch(() => [])
  const updatedManifest = dedupeByDataFile(
    upsertProjectManifest(manifest, { slug: project.slugId, name: project.name, dataFile }),
  )
  await writeJsonAtomic(MANIFEST_URL, updatedManifest)
  log.push(`wrote ${MANIFEST_PATH}`)

  return { data: merged, project, log }
}

async function main() {
  const args = parseArgs(Deno.args)
  if (!args.project) throw new Error("usage: deno task issues <project name or slug> [--data path] [--dry-run]")

  const key = await linearKey()

  if (args.dryRun) {
    const project = await findProject(key, args.project)
    const rawIssues = await fetchAllIssues(key, project.id)
    const milestones = buildMilestones(project.projectMilestones.nodes)
    const teams = buildTeams(project.teams.nodes)
    console.log(`issues: ${project.name} — ${rawIssues.length} issues, ${milestones.length} milestones`)
    for (const team of teams) {
      console.log(
        `  team ${team.key}: ${team.states.length} states, estimates ${team.estimation.type}` +
          `${team.estimation.allowZero ? " +zero" : ""}${team.estimation.extended ? " +extended" : ""}`,
      )
    }
    console.log("--dry-run: not writing")
    return
  }

  const existing = await Deno.readTextFile(args.data).then(JSON.parse).catch(() => ({}))
  const { data, log } = await ingestProject(key, args.project, existing, args.data.split("/").pop()!)
  for (const line of log) console.log(line)

  await Deno.writeTextFile(args.data, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`wrote ${args.data}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    console.error(`issues: ${err instanceof Error ? err.message : err}`)
    Deno.exit(1)
  }
}
