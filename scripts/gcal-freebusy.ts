// Spike: test Google Calendar free/busy over the Desktop OAuth flow.
//
//   deno task gcal:freebusy                       # roster emails from web/data/cpu.json, next 14 days
//   deno run ... scripts/gcal-freebusy.ts --emails a@x.com,b@y.com --days 30
//   deno run ... scripts/gcal-freebusy.ts --reauth # force a fresh consent
//
// This is the shortcut behind CapacitySource.outDays (ADR 0007), not the shipped path yet. It proves
// that a personal OAuth client can read teammates' free/busy the same way the Calendar webapp's
// "Find a time" view does, when the Workspace shares free/busy. Download a Desktop-app client JSON
// (SETUP.md, Google section) to web/data/gcal-client.json. The first run opens a browser once for
// consent and caches a refresh token in web/data/gcal-token.json (both gitignored); later runs are
// silent.

const CLIENT_PATH = new URL("../web/data/gcal-client.json", import.meta.url).pathname
const TOKEN_PATH = new URL("../web/data/gcal-token.json", import.meta.url).pathname
const DATA_PATH = new URL("../web/data/cpu.json", import.meta.url).pathname
const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URI = "https://oauth2.googleapis.com/token"
const FREEBUSY_URI = "https://www.googleapis.com/calendar/v3/freeBusy"
const SCOPE = "https://www.googleapis.com/auth/calendar.freebusy"

interface Client {
  client_id: string
  client_secret: string
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--reauth") args.reauth = true
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i]
  }
  return args as { emails?: string; days?: string; client?: string; reauth?: boolean }
}

async function loadClient(path: string): Promise<Client> {
  let raw: string
  try {
    raw = await Deno.readTextFile(path)
  } catch {
    throw new Error(
      `no client JSON at ${path}. Download a Desktop-app OAuth client (SETUP.md, Google section)\n` +
        `and save it there, or pass --client <path>.`,
    )
  }
  const json = JSON.parse(raw)
  const c = json.installed ?? json.web ?? json
  if (!c.client_id || !c.client_secret) throw new Error(`${path} has no client_id/client_secret`)
  return { client_id: c.client_id, client_secret: c.client_secret }
}

async function readRefreshToken(): Promise<string | null> {
  try {
    return JSON.parse(await Deno.readTextFile(TOKEN_PATH)).refresh_token ?? null
  } catch {
    return null
  }
}

function openBrowser(url: string) {
  try {
    new Deno.Command("open", { args: [url], stdout: "null", stderr: "null" }).spawn()
  } catch {
    // open is best-effort; the URL is printed regardless
  }
}

// Loopback OAuth: listen on an ephemeral localhost port, send the user to consent, catch the redirect.
async function consent(client: Client): Promise<string> {
  let resolveCode: (code: string) => void
  const codePromise = new Promise<string>((r) => (resolveCode = r))
  const ac = new AbortController()

  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal }, (req) => {
    const code = new URL(req.url).searchParams.get("code")
    if (code) resolveCode(code)
    return new Response(
      code ? "TLR: consent received. You can close this tab." : "TLR: no code in redirect.",
      { headers: { "content-type": "text/plain" } },
    )
  })
  const { port } = server.addr as Deno.NetAddr
  const redirectUri = `http://127.0.0.1:${port}`

  const authUrl = `${AUTH_URI}?` + new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  })
  console.log("Opening the consent screen in your browser. If it does not open, visit:\n")
  console.log(`  ${authUrl}\n`)
  openBrowser(authUrl)

  const code = await codePromise
  ac.abort()
  await server.finished

  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  })
  if (!res.ok) throw new Error(`token exchange → ${res.status} ${await res.text()}`)
  const tok = await res.json()
  if (!tok.refresh_token) {
    throw new Error("no refresh_token returned; re-run with --reauth to force a fresh consent")
  }
  await Deno.writeTextFile(TOKEN_PATH, JSON.stringify({ refresh_token: tok.refresh_token }, null, 2) + "\n")
  console.log(`cached refresh token in ${TOKEN_PATH}\n`)
  return tok.access_token as string
}

async function accessToken(client: Client, refresh: string): Promise<string> {
  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  })
  if (!res.ok) throw new Error(`token refresh → ${res.status} ${await res.text()}`)
  return (await res.json()).access_token as string
}

async function rosterEmails(): Promise<string[]> {
  try {
    const data = JSON.parse(await Deno.readTextFile(DATA_PATH))
    const roster = data.capacity?.roster ?? {}
    return [...new Set(Object.values(roster).map(String).filter(Boolean))]
  } catch {
    return []
  }
}

async function main() {
  const args = parseArgs(Deno.args)
  const client = await loadClient(args.client ?? CLIENT_PATH)

  const emails = args.emails ? args.emails.split(",").map((e) => e.trim()).filter(Boolean) : await rosterEmails()
  if (emails.length === 0) {
    throw new Error("no emails to query: pass --emails a@x,b@y or fill the roster (deno task roster)")
  }

  const refresh = args.reauth ? null : await readRefreshToken()
  const token = refresh ? await accessToken(client, refresh) : await consent(client)

  const days = Number(args.days ?? 14)
  const now = new Date()
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

  const res = await fetch(FREEBUSY_URI, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      items: emails.map((id) => ({ id })),
    }),
  })
  if (!res.ok) throw new Error(`freeBusy → ${res.status} ${await res.text()}`)
  const { calendars } = await res.json()

  console.log(`free/busy for the next ${days} days:\n`)
  for (const email of emails) {
    const cal = calendars?.[email]
    if (!cal) {
      console.log(`  ${email}: no data`)
      continue
    }
    if (cal.errors?.length) {
      console.log(`  ${email}: ${cal.errors.map((e: { reason: string }) => e.reason).join(", ")}`)
      continue
    }
    const busy = cal.busy ?? []
    console.log(`  ${email}: ${busy.length} busy block(s)`)
    for (const b of busy.slice(0, 10)) console.log(`    ${b.start} → ${b.end}`)
    if (busy.length > 10) console.log(`    … ${busy.length - 10} more`)
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    console.error(`gcal-freebusy: ${err instanceof Error ? err.message : err}`)
    Deno.exit(1)
  }
}
