// Refresh the capacity block in cpu.json from real sources.
//
//   deno task capacity                      # refresh both sources into web/data/cpu.json
//   deno run ... scripts/capacity.ts --source incident --dry-run
//   deno run ... scripts/capacity.ts --source gcal --calendar-file /tmp/cal.json
//
// On-call comes from the Incident.io REST API (bearer token from the macOS keychain, service
// `tlr-incidentio`, account `api-key`, or the INCIDENT_IO_TOKEN env var). Out-of-office comes from a
// calendar handoff file: a JSON array of { email | name, startDate, endDate, title } that the Google
// Calendar step writes. Both feed the provenance-aware merge in web/lib/capacity.js, so a refresh
// updates sourced data and leaves hand-entered values alone.

import { mergeCapacity, oncallByCycle, outDaysByCycle } from "../web/lib/capacity.js"

const INCIDENT_HOST = "https://api.incident.io"
const DEFAULT_DATA = new URL("../web/data/cpu.json", import.meta.url).pathname

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = { source: "all", data: DEFAULT_DATA }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") args.dryRun = true
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i]
  }
  return args as { source: string; data: string; dryRun?: boolean; "calendar-file"?: string }
}

async function incidentToken(): Promise<string> {
  const env = Deno.env.get("INCIDENT_IO_TOKEN")
  if (env) return env.trim()
  const cmd = new Deno.Command("security", {
    args: ["find-generic-password", "-s", "tlr-incidentio", "-a", "api-key", "-w"],
    stdout: "piped",
    stderr: "null",
  })
  const { code, stdout } = await cmd.output()
  if (code !== 0) {
    throw new Error(
      "no Incident.io token: set INCIDENT_IO_TOKEN or store one with\n" +
        "  security add-generic-password -s tlr-incidentio -a api-key -w",
    )
  }
  return new TextDecoder().decode(stdout).trim()
}

async function incidentGet(path: string, token: string) {
  const res = await fetch(`${INCIDENT_HOST}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
  if (!res.ok) throw new Error(`Incident.io ${path} → ${res.status} ${res.statusText}`)
  return res.json()
}

async function fetchOncallEntries(token: string, winStart: string, winEnd: string) {
  const schedules: { id: string }[] = []
  let after = ""
  do {
    const page = await incidentGet(`/v2/schedules${after ? `?after=${after}` : ""}`, token)
    schedules.push(...(page.schedules ?? []))
    after = page.pagination_meta?.after ?? ""
  } while (after)

  const entries: { email: string; name: string; startDate: string; endDate: string }[] = []
  for (const s of schedules) {
    const q = new URLSearchParams({
      schedule_id: s.id,
      entry_window_start: `${winStart}T00:00:00Z`,
      entry_window_end: `${winEnd}T00:00:00Z`,
    })
    const page = await incidentGet(`/v2/schedule_entries?${q}`, token)
    for (const e of page.schedule_entries?.final ?? []) {
      if (!e.user) continue
      entries.push({
        email: e.user.email ?? "",
        name: e.user.name ?? "",
        startDate: (e.start_at ?? "").slice(0, 10),
        endDate: (e.end_at ?? "").slice(0, 10),
      })
    }
  }
  return entries
}

function windowFor(cycles: { start: string; end: string }[]) {
  const starts = cycles.map((c) => c.start).sort()
  const ends = cycles.map((c) => c.end).sort()
  return { winStart: starts[0], winEnd: ends[ends.length - 1] }
}

async function main() {
  const args = parseArgs(Deno.args)
  const data = JSON.parse(await Deno.readTextFile(args.data))
  const cycles = data.cycles as { n: number; start: string; end: string }[]
  const roster = data.capacity?.roster ?? {}
  const workdays = data.capacity?.config?.workdaysPerCycle ?? 5
  const { winStart, winEnd } = windowFor(cycles)
  let capacity = data.capacity ?? { defaultVelocity: 20, people: {} }
  const wantIncident = args.source === "all" || args.source === "incident"
  const wantGcal = args.source === "all" || args.source === "gcal"

  if (wantIncident) {
    const token = await incidentToken()
    const entries = await fetchOncallEntries(token, winStart, winEnd)
    const oncall = oncallByCycle(entries, cycles, roster)
    capacity = mergeCapacity(capacity, oncall, "incident.io")
    console.log(`incident.io: ${entries.length} shifts → on-call for ${Object.keys(oncall).join(", ") || "nobody"}`)
  }

  if (wantGcal) {
    const file = args["calendar-file"]
    if (!file) {
      console.log("gcal: no --calendar-file given; skipping out-of-office refresh")
    } else {
      const events = JSON.parse(await Deno.readTextFile(file))
      const outDays = outDaysByCycle(events, cycles, roster, workdays)
      capacity = mergeCapacity(capacity, outDays, "gcal")
      console.log(`gcal: ${events.length} events → out-days for ${Object.keys(outDays).join(", ") || "nobody"}`)
    }
  }

  data.capacity = capacity
  const out = JSON.stringify(data, null, 2) + "\n"
  if (args.dryRun) {
    console.log("--dry-run: capacity block that would be written:")
    console.log(JSON.stringify(capacity, null, 2))
  } else {
    await Deno.writeTextFile(args.data, out)
    console.log(`wrote ${args.data}`)
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    console.error(`capacity: ${err instanceof Error ? err.message : err}`)
    Deno.exit(1)
  }
}
