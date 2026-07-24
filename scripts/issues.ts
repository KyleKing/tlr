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

import {
  buildCycles,
  buildMilestones,
  currentCycleNumber,
  mergeIngest,
  milestoneKey,
  transformIssue,
  upsertProjectManifest,
} from "../web/lib/issues.js"
import { resolveRoster } from "./roster.ts"

const LINEAR_API_URL = "https://api.linear.app/graphql"
const DEFAULT_DATA = new URL("../web/data/cpu.json", import.meta.url).pathname
const MANIFEST_PATH = new URL("../web/data/projects.json", import.meta.url).pathname

const PROJECT_QUERY = `
  query Projects($filter: ProjectFilter) {
    projects(filter: $filter, first: 50) {
      nodes {
        id
        name
        url
        slugId
        startDate
        targetDate
        projectMilestones(first: 50) { nodes { id name targetDate progress } }
        teams(first: 1) { nodes { cycles(first: 12) { nodes { number startsAt endsAt } } } }
      }
    }
  }
`

const ISSUES_QUERY = `
  query ProjectIssues($projectId: String!, $after: String) {
    issues(filter: { project: { id: { eq: $projectId } } }, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        identifier
        title
        url
        description
        estimate
        priority
        state { name type }
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
type ProjectNode = {
  id: string
  name: string
  url: string
  slugId: string
  startDate: string
  targetDate: string
  projectMilestones: { nodes: ProjectMilestoneNode[] }
  teams: { nodes: { cycles: { nodes: CycleNode[] } }[] }
}
type ProjectsResponse = { projects: { nodes: ProjectNode[] } }

type IssueNode = {
  identifier: string
  title: string
  url: string
  description: string | null
  estimate: number | null
  priority: number | null
  state: { name: string; type: string } | null
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
// Each has its own env override (LINEAR_API_KEY / LINEAR_DEMO_API_KEY) so CI can inject without a keychain.
export async function linearKey(account: "api-key" | "demo-key" = "api-key"): Promise<string> {
  const envName = account === "demo-key" ? "LINEAR_DEMO_API_KEY" : "LINEAR_API_KEY"
  const env = Deno.env.get(envName)
  if (env) return env.trim()
  const cmd = new Deno.Command("security", {
    args: ["find-generic-password", "-s", "tlr-linear", "-a", account, "-w"],
    stdout: "piped",
    stderr: "null",
  })
  const { code, stdout } = await cmd.output()
  if (code !== 0) {
    throw new Error(
      `no Linear key: set ${envName} or store one with\n` +
        `  security add-generic-password -s tlr-linear -a ${account} -w`,
    )
  }
  return new TextDecoder().decode(stdout).trim()
}

async function gql<T>(key: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res: Response = await fetch(LINEAR_API_URL, {
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
  return nodes.find((p) =>
    p.name.toLowerCase() === query.toLowerCase() || p.slugId.toLowerCase() === query.toLowerCase()
  ) ??
    nodes[0]
}

async function fetchAllIssues(key: string, projectId: string): Promise<IssueNode[]> {
  const issues: IssueNode[] = []
  let after: string | null = null
  do {
    const page: IssuesResponse["issues"] = (await gql<IssuesResponse>(key, ISSUES_QUERY, { projectId, after })).issues
    issues.push(...page.nodes)
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
  const cycles = buildCycles(project.teams.nodes[0]?.cycles.nodes ?? [])
  const asOf = new Date().toISOString().slice(0, 10)

  const fresh = {
    project: { name: project.name, start: project.startDate, target: project.targetDate, url: project.url },
    cycles,
    currentCycle: currentCycleNumber(cycles, asOf),
    milestones,
    issues: rawIssues.map((i) => transformIssue(i, milestoneKeyById)),
    asOf,
  }

  const log = [`issues: ${project.name} — ${fresh.issues.length} issues, ${milestones.length} milestones`]
  const merged = mergeIngest(existingData ?? {}, fresh)

  const roster = await resolveRoster(key, merged)
  log.push(`roster: ${roster.total} assignees, ${roster.resolved.length} resolved, ${roster.missing.length} unresolved`)
  for (const r of roster.resolved) log.push(`  ${r}`)
  if (roster.missing.length) log.push(`  unresolved (left blank): ${roster.missing.join(", ")}`)

  const manifest = await Deno.readTextFile(MANIFEST_PATH).then(JSON.parse).catch(() => [])
  const updatedManifest = upsertProjectManifest(manifest, { slug: project.slugId, name: project.name, dataFile })
  await Deno.writeTextFile(MANIFEST_PATH, `${JSON.stringify(updatedManifest, null, 2)}\n`)
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
    console.log(`issues: ${project.name} — ${rawIssues.length} issues, ${milestones.length} milestones`)
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
