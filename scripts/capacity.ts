// Refresh the capacity block in cpu.json from real sources.
//
//   deno task capacity                      # refresh all sources into web/data/cpu.json
//   deno run ... scripts/capacity.ts --source incident --dry-run
//   deno run ... scripts/capacity.ts --source gcal                    # live free/busy, OAuth
//   deno run ... scripts/capacity.ts --source gcal --calendar-file /tmp/cal.json  # named events instead
//   deno run ... scripts/capacity.ts --source history
//
// On-call comes from the Incident.io REST API (bearer token from the macOS keychain, service
// `tlr-incidentio`, account `api-key`, or the INCIDENT_IO_TOKEN env var). Out-of-office defaults to
// live Google Calendar free/busy (scripts/gcal-freebusy.ts's OAuth client, out-days flagged by the
// >=5-busy-hour-or-all-day heuristic in outDaysFromFreeBusy); passing --calendar-file instead uses a
// handoff file of named events (startDate, endDate, title) when a real reason is known. Velocity comes
// from each person's completed points in past cycles, already present in this same data file — no
// external fetch needed. All three feed the provenance-aware merges in web/lib/capacity.js: a value
// typed by hand (no source marker) is protected by default, and a source only refreshes what it wrote
// itself on an earlier run. The free/busy heuristic under-reports real time off when it isn't a
// calendar-blocking event (an onsite doesn't necessarily fill a calendar with meetings, and an all-day
// block set to Free/transparent is invisible to free/busy entirely) — that's why hand-typed protection
// is the default rather than "automation always wins". Add `locked: true` to a person or a person's
// cycle entry in cpu.json to also freeze a value a source previously wrote, if it's since been
// hand-confirmed and should stop drifting on refresh.

import {
  mergeCapacity,
  mergeVelocity,
  oncallByCycle,
  outDaysByCycle,
  outDaysFromFreeBusy,
  velocityByPerson,
} from "../web/lib/capacity.js"
import { CLIENT_PATH, fetchFreeBusy, loadClient, tokenFor } from "./gcal-freebusy.ts"

const INCIDENT_HOST = "https://api.incident.io"
const DEFAULT_DATA = new URL("../web/data/cpu.json", import.meta.url).pathname

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = { source: "all", data: DEFAULT_DATA }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") args.dryRun = true
    else if (a === "--reauth") args.reauth = true
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i]
  }
  return args as {
    source: string
    data: string
    dryRun?: boolean
    reauth?: boolean
    "calendar-file"?: string
  }
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

export type CapacityData = {
  cycles: { n: number; start: string; end: string }[]
  currentCycle?: number | null
  issues?: unknown[]
  capacity?: {
    defaultVelocity?: number
    config?: { workdaysPerCycle?: number; oncallPenalty?: number }
    roster?: Record<string, { email?: string }>
    people?: Record<string, unknown>
  }
}

export type RefreshCapacityOpts = {
  source?: string
  calendarFile?: string
  reauth?: boolean
}

// Refreshes data.capacity in place from the requested source(s) ("all" by default) and returns a log
// of what changed. Used by both the CLI (main, below) and the config panel's /api/refresh endpoint
// (scripts/serve.ts).
export async function refreshCapacity(data: CapacityData, opts: RefreshCapacityOpts = {}) {
  const source = opts.source ?? "all"
  const cycles = data.cycles
  const roster = data.capacity?.roster ?? {}
  const workdays = data.capacity?.config?.workdaysPerCycle ?? 5
  const { winStart, winEnd } = windowFor(cycles)
  let capacity = data.capacity ?? { defaultVelocity: 20, people: {} }
  const wantIncident = source === "all" || source === "incident"
  const wantGcal = source === "all" || source === "gcal"
  const wantHistory = source === "all" || source === "history"
  const log: string[] = []

  if (wantIncident) {
    const token = await incidentToken()
    const entries = await fetchOncallEntries(token, winStart, winEnd)
    const oncall = oncallByCycle(entries, cycles, roster)
    capacity = mergeCapacity(capacity, oncall, "incident.io")
    log.push(`incident.io: ${entries.length} shifts → on-call for ${Object.keys(oncall).join(", ") || "nobody"}`)
  }

  if (wantGcal) {
    const file = opts.calendarFile
    if (file) {
      const events = JSON.parse(await Deno.readTextFile(file))
      const outDays = outDaysByCycle(events, cycles, roster, workdays)
      capacity = mergeCapacity(capacity, outDays, "gcal")
      log.push(`gcal: ${events.length} events → out-days for ${Object.keys(outDays).join(", ") || "nobody"}`)
    } else {
      const rosterEntries = Object.values(roster) as { email?: string }[]
      const emails = [...new Set(rosterEntries.map((p) => p.email).filter(Boolean))] as string[]
      if (!emails.length) {
        log.push("gcal: no roster emails to query; skipping out-of-office refresh")
      } else {
        const client = await loadClient(CLIENT_PATH)
        const token = await tokenFor(client, opts.reauth)
        const calendars = await fetchFreeBusy(token, emails, `${winStart}T00:00:00Z`, `${winEnd}T00:00:00Z`)
        const outDays = outDaysFromFreeBusy(calendars, cycles, roster, workdays)
        capacity = mergeCapacity(capacity, outDays, "gcal")
        log.push(`gcal: free/busy for ${emails.length} — out-days for ${Object.keys(outDays).join(", ") || "nobody"}`)
      }
    }
  }

  if (wantHistory) {
    const velocity = velocityByPerson(data.issues ?? [], cycles, data.currentCycle ?? null)
    capacity = mergeVelocity(capacity, velocity)
    log.push(`history: past-cycle throughput → velocity for ${Object.keys(velocity).join(", ") || "nobody"}`)
  }

  data.capacity = capacity
  return log
}

async function main() {
  const args = parseArgs(Deno.args)
  const data = JSON.parse(await Deno.readTextFile(args.data))
  const log = await refreshCapacity(data, {
    source: args.source,
    calendarFile: args["calendar-file"],
    reauth: args.reauth,
  })
  for (const line of log) console.log(line)

  if (args.dryRun) {
    console.log("--dry-run: capacity block that would be written:")
    console.log(JSON.stringify(data.capacity, null, 2))
  } else {
    await Deno.writeTextFile(args.data, JSON.stringify(data, null, 2) + "\n")
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
