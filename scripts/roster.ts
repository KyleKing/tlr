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

const LINEAR_API_URL = "https://api.linear.app/graphql"
const DEFAULT_DATA = new URL("../web/data/cpu.json", import.meta.url).pathname

const USERS_QUERY =
  `query Users($after: String) { users(first: 250, after: $after) { nodes { name displayName email active } pageInfo { hasNextPage endCursor } } }`

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

async function linearKey(): Promise<string> {
  const env = Deno.env.get("LINEAR_API_KEY")
  if (env) return env.trim()
  const cmd = new Deno.Command("security", {
    args: ["find-generic-password", "-s", "tlr-linear", "-a", "api-key", "-w"],
    stdout: "piped",
    stderr: "null",
  })
  const { code, stdout } = await cmd.output()
  if (code !== 0) {
    throw new Error(
      "no Linear key: set LINEAR_API_KEY or store one with\n" +
        "  security add-generic-password -s tlr-linear -a api-key -w",
    )
  }
  return new TextDecoder().decode(stdout).trim()
}

type LinearUser = { name: string; displayName: string; email: string; active: boolean }

type UsersResponse = {
  errors?: { message: string }[]
  data: { users: { nodes: LinearUser[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
}

async function fetchUsers(key: string): Promise<LinearUser[]> {
  const users: LinearUser[] = []
  let after: string | null = null
  do {
    const res: Response = await fetch(LINEAR_API_URL, {
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
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return users
}

function assigneeNames(issues: { assignee?: string | null }[]): string[] {
  const names = new Set<string>()
  for (const i of issues) {
    const a = i.assignee
    if (a && a !== "Unassigned") names.add(a)
  }
  return [...names].sort()
}

function resolveEmail(name: string, users: LinearUser[]): string | null {
  const lower = name.toLowerCase()
  const hit = users.find((u) => u.name?.toLowerCase() === lower) ??
    users.find((u) => u.displayName?.toLowerCase() === lower)
  return hit?.email ?? null
}

export type RosterData = {
  capacity?: { defaultVelocity?: number; people?: Record<string, unknown>; roster?: Record<string, { email: string }> }
  issues?: { assignee?: string | null }[]
}

export async function resolveRoster(key: string, data: RosterData, opts: { force?: boolean } = {}) {
  const capacity = data.capacity ?? (data.capacity = { defaultVelocity: 20, people: {} })
  const roster: Record<string, { email: string }> = capacity.roster ?? (capacity.roster = {})

  const names = assigneeNames(data.issues ?? [])
  const users = await fetchUsers(key)

  const resolved: string[] = []
  const missing: string[] = []
  for (const name of names) {
    const existing = roster[name]?.email
    if (existing && !opts.force) continue
    const email = resolveEmail(name, users)
    if (email) {
      roster[name] = { email }
      resolved.push(`${name} → ${email}`)
    } else {
      if (!roster[name]) roster[name] = { email: "" }
      missing.push(name)
    }
  }

  return { total: names.length, resolved, missing }
}

async function main() {
  const args = parseArgs(Deno.args)
  const data = JSON.parse(await Deno.readTextFile(args.data))
  const key = await linearKey()
  const { total, resolved, missing } = await resolveRoster(key, data, { force: args.force })

  console.log(`roster: ${total} assignees, ${resolved.length} resolved, ${missing.length} unresolved`)
  for (const r of resolved) console.log(`  ${r}`)
  if (missing.length) console.log(`  unresolved (left blank): ${missing.join(", ")}`)

  if (args.dryRun) {
    console.log("--dry-run: roster block that would be written:")
    console.log(JSON.stringify(data.capacity.roster, null, 2))
  } else {
    await Deno.writeTextFile(args.data, JSON.stringify(data, null, 2) + "\n")
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
