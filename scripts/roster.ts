// Refresh the capacity.roster block in cpu.json from Linear.
//
//   deno task roster                 # resolve assignee names → emails, merge into web/data/cpu.json
//   deno run ... scripts/roster.ts --data web/data-sample.json --dry-run
//
// The issue export stores assignees as display names only. On-call (Incident.io) and out-days (Google
// Calendar) key on email, so a name → email map has to come from somewhere. This resolves it against
// the Linear GraphQL API (bearer key from the macOS keychain, service `tlr-linear`, account `api-key`,
// or the LINEAR_API_KEY env var) so the roster is never hand-maintained. Existing roster entries are
// kept; a name already carrying an email is left alone unless --force is passed.
//
// Every active Linear user goes in, not only this project's assignees. The roster is an identity
// directory: it resolves an Incident.io or Calendar identity to a display name, and someone on call
// who is missing from it has their on-call week silently ignored. It is not the set of people the
// forecast plans for, which is ownership of live work (planning.js's planningPeople), so a broad
// roster costs nothing in the forecast and covers anyone who joins the project later.

import { liveIssues } from "../web/lib/issues.js"
import { fetchWithRetry } from "@/httpRetry.ts"
import { getSecret } from "@/secrets.ts"

const LINEAR_API_URL = "https://api.linear.app/graphql"
const DEFAULT_DATA = new URL("../web/data/cpu.json", import.meta.url).pathname

const USERS_QUERY =
  `query Users($after: String) { users(first: 250, after: $after) { nodes { name displayName email active app guest } pageInfo { hasNextPage endCursor } } }`

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = { data: DEFAULT_DATA }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") args.dryRun = true
    else if (a === "--force") args.force = true
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i]
  }
  return args as { data: string; dryRun?: boolean; force?: boolean }
}

function linearKey(): Promise<string> {
  return getSecret("linear")
}

type LinearUser = { name: string; displayName: string; email: string; active: boolean; app: boolean; guest: boolean }

type UsersResponse = {
  errors?: { message: string }[]
  data: { users: { nodes: LinearUser[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
}

async function fetchUsers(key: string): Promise<LinearUser[]> {
  const users: LinearUser[] = []
  let after: string | null = null
  do {
    const res: Response = await fetchWithRetry(LINEAR_API_URL, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: USERS_QUERY, variables: { after } }),
    })
    if (!res.ok) throw new Error(`Linear users → ${res.status} ${res.statusText}`)
    const json: UsersResponse = await res.json()
    if (json.errors) {
      throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join("; ")}`)
    }
    const page = json.data.users
    users.push(...page.nodes)
    // A next page with no cursor to reach it would otherwise end the loop quietly, leaving every
    // assignee past the truncation point unresolved and their email blank. Fail the run instead.
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new Error(`Linear paginated ${users.length} users then reported another page with no cursor`)
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return users
}

// This project's live assignees. Kept because an assignee whose name Linear cannot resolve is worth
// reporting: they own work here and their on-call and out-days will never land.
export function assigneeNames(issues: { archived?: boolean; assignee?: string | null }[]): string[] {
  const names = new Set<string>()
  for (const i of liveIssues(issues)) {
    const a = i.assignee
    if (a && a !== "Unassigned") names.add(a)
  }
  return [...names].sort()
}

export type RosterData = {
  capacity?: { defaultVelocity?: number; people?: Record<string, unknown>; roster?: Record<string, { email: string }> }
  issues?: { archived?: boolean; assignee?: string | null }[]
}

export async function resolveRoster(key: string, data: RosterData, opts: { force?: boolean } = {}) {
  const capacity = data.capacity ?? (data.capacity = { defaultVelocity: 20, people: {} })
  const roster: Record<string, { email: string }> = capacity.roster ?? (capacity.roster = {})

  const users = await fetchUsers(key)
  const owners = new Set(assigneeNames(data.issues ?? []))

  const resolved: string[] = []
  for (const user of users) {
    // `app` marks Linear's integration and bot accounts (Slack, Sentry, Codex, incident.io), which
    // carry synthetic @*.linear.app addresses and are never on call or out of office. A guest is an
    // external collaborator, not an engineer to plan around.
    if (!user.active || user.app || user.guest) continue
    // Keyed by Linear's `name`, because that is what transformIssue stores as an issue's assignee and
    // what the board groups people by. displayName is a different string for some users, and keying on
    // it would file a person's on-call under a name no ticket carries.
    const name = user.name || user.displayName
    if (!name || !user.email) continue
    if (roster[name]?.email && !opts.force) continue
    roster[name] = { email: user.email }
    resolved.push(`${name} → ${user.email}`)
  }

  // An owner Linear did not return is the case worth shouting about: they hold work in this project,
  // so their on-call and out-days will never resolve until the name is reconciled by hand.
  const missing = [...owners].filter((name) => !roster[name]?.email).sort()
  for (const name of missing) roster[name] ??= { email: "" }

  return { total: users.filter((u) => u.active && !u.app && !u.guest).length, resolved, missing }
}

async function main() {
  const args = parseArgs(Deno.args)
  const data = JSON.parse(await Deno.readTextFile(args.data))
  const key = await linearKey()
  const { total, resolved, missing } = await resolveRoster(key, data, { force: args.force })

  console.log(`roster: ${total} active Linear members, ${resolved.length} written, ${missing.length} unresolved`)
  for (const r of resolved) console.log(`  ${r}`)
  if (missing.length) console.log(`  owns work here but unresolved (left blank): ${missing.join(", ")}`)

  if (args.dryRun) {
    console.log("--dry-run: roster block that would be written:")
    console.log(JSON.stringify(data.capacity.roster, null, 2))
  } else {
    await Deno.writeTextFile(args.data, `${JSON.stringify(data, null, 2)}\n`)
    console.log(`wrote ${args.data}`)
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    console.error(`roster: ${err instanceof Error ? err.message : err}`)
    Deno.exit(1)
  }
}
