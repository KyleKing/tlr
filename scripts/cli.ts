// The tlr CLI: a read-and-preview surface over the same pure analysis the board uses, so Claude Code
// (or a person) can pull aggregated facts Linear does not give you before making batch edits. Every
// command prints JSON to stdout (SVG for `export`), so the output pipes cleanly into another tool.
//
// Commands:
//   scan   --text "<t>" | --file <path> | --project <file>   slop score for text, or every issue
//   context --issue DEV-1234 [--created <iso>] [--days n]   what external systems know about an issue
//   context --project <file> [--issues a,b] [--days n]       the same lookup over many issues at once
//   capacity --project <file>                                 per-person load vs capacity per cycle
//   standup  --project <file> [--cycle n] [--out a,b]         weekly roll-up: closed, carry-in, hops, next-cycle fit
//   balance  --project <file> [--weekly n] [--start c] [--end c] [--weeks n]  propose assignee+cycle
//   timeline --project <file>                                 dependency waves and chain risks
//   diff   --a <file> --b <file> | --from <id> --to <id>      plan-level change between two snapshots
//   report --a <file> --b <file> | --from <id> --to <id>      weekly-update narrative from a diff
//   forecast --project <file>                                 realistic landing date per milestone
//   review --a <file> --b <file> | --db <path>                what changed worth a look since last review
//   plan   --project <file> --text "<guidance>"              parse guidance to ops and preview the diff
//   snapshot --project <file> [--label <l>] [--db <path>]     capture a snapshot into the local store
//   snapshots [--db <path>]                                   list stored snapshots, newest first
//   export --project <file> [--timeline] [--out <path>]       SVG of the board (or timeline)
//
// A --project/--a/--b value with no slash is looked up under web/data; otherwise it is a path.

import { scanIssues, scanText } from "@/commands/scan.ts"
import { issueContext, issueContextBatch } from "@/commands/context.ts"
import { projectCapacity } from "@/commands/capacity.ts"
import { balance } from "@/commands/balance.ts"
import { projectTimeline } from "@/commands/timeline.ts"
import { standup } from "@/commands/standup.ts"
import { diffSnapshots } from "@/diff.ts"
import { renderReport, weeklyReport } from "@/report.ts"
import { milestoneForecast } from "@/forecast.ts"
import { reviewSince } from "@/review.ts"
import { openStore } from "@/snapshot.ts"
import { planFromText } from "@/plan.ts"
import { applyOps } from "@/ops.ts"
import { boardSvg, timelineSvg } from "@/export.ts"
import { openCache } from "@/cache.ts"
import { configuredSources } from "@/contextRegistry.ts"
import { type ContextSource, type FixtureRecord, fixtureSource } from "@/contextSource.ts"
import type { Snapshot } from "@/seed.ts"

const DATA_ROOT = new URL("../web/data/", import.meta.url)

type Flags = { _: string[]; [k: string]: string | boolean | string[] }

function parseFlags(args: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next === undefined || next.startsWith("--")) flags[key] = true
      else {
        flags[key] = next
        i++
      }
    } else flags._.push(a)
  }
  return flags
}

function resolveDataPath(nameOrPath: string): URL {
  if (nameOrPath.includes("/")) return new URL(nameOrPath, `file://${Deno.cwd()}/`)
  return new URL(nameOrPath, DATA_ROOT)
}

// Which issues a batch answers is the caller's choice, so this only resolves what it was handed: the
// snapshot supplies each identifier's own createdAt, and an issue whose capture predates that field
// falls back to --created, then to now. A snapshot taken before ingest recorded createdAt gives every
// issue the same window, which is a re-ingest away from being right.
async function batchIssues(file: string | undefined, named: string[] | undefined, fallback: string | undefined) {
  const filed = new Map<string, string | null | undefined>()
  if (file) { for (const i of (await loadData(file)).issues) filed.set(i.id, i.createdAt) }
  const ids = named ?? [...filed.keys()]
  if (!ids.length) fail("context found no issues to look up")
  return ids.map((issue) => ({ issue, createdAt: filed.get(issue) ?? fallback }))
}

async function loadData(nameOrPath: string): Promise<Snapshot> {
  return JSON.parse(await Deno.readTextFile(resolveDataPath(nameOrPath))) as Snapshot
}

function out(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

function fail(message: string): never {
  console.error(`tlr: ${message}`)
  Deno.exit(1)
}

const str = (f: Flags, k: string): string | undefined => (typeof f[k] === "string" ? f[k] as string : undefined)

async function run(cmd: string | undefined, f: Flags): Promise<void> {
  switch (cmd) {
    case "scan": {
      const text = str(f, "text")
      const file = str(f, "file")
      const project = str(f, "project")
      if (text !== undefined) return out(scanText(text))
      if (file) return out(scanText(await Deno.readTextFile(resolveDataPath(file))))
      return out(scanIssues(await loadData(project ?? "data-sample.json")))
    }
    case "standup": {
      const n = (k: string) => (str(f, k) !== undefined ? Number(str(f, k)) : undefined)
      const away = str(f, "out")
      return out(standup(await loadData(str(f, "project") ?? "data-sample.json"), {
        cycle: n("cycle"),
        lookback: n("lookback"),
        target: n("target"),
        out: away ? away.split(",").map((p) => p.trim()).filter(Boolean) : undefined,
      }))
    }
    case "capacity":
      return out(projectCapacity(await loadData(str(f, "project") ?? "data-sample.json")))
    case "timeline":
      return out(projectTimeline(await loadData(str(f, "project") ?? "data-sample.json")))
    case "balance": {
      const snap = await loadData(str(f, "project") ?? "data-sample.json")
      const num = (k: string) => (str(f, k) !== undefined ? Number(str(f, k)) : undefined)
      const start = num("start")
      const weeks = num("weeks")
      return out(balance(snap, {
        weeklyPerPerson: num("weekly"),
        start,
        end: num("end") ?? (start !== undefined && weeks !== undefined ? start + weeks - 1 : undefined),
        maxLeadCycles: num("lead"),
      }))
    }
    case "diff": {
      const { before, after } = await twoSnapshots(f)
      return out(diffSnapshots(before, after))
    }
    case "report": {
      const { before, after } = await twoSnapshots(f)
      const report = weeklyReport(diffSnapshots(before, after))
      return out(f.json ? report : renderReport(report))
    }
    case "forecast": {
      const weekly = str(f, "weekly") !== undefined ? Number(str(f, "weekly")) : undefined
      return out(milestoneForecast(await loadData(str(f, "project") ?? "data-sample.json"), weekly))
    }
    case "review": {
      const { before, after, history, window } = await twoSnapshots(f, true)
      const review = reviewSince(before, after, history)
      if (window) {
        if (window.advance) window.store.setReviewPointer(window.toId, window.projectKey)
        window.store.close()
      }
      return out(review)
    }
    case "plan": {
      const before = await loadData(str(f, "project") ?? "data-sample.json")
      const text = str(f, "text") ?? fail('plan needs --text "<guidance>"')
      const { ops, unparsed } = planFromText(text, before)
      const { after, applied, skipped } = applyOps(before, ops)
      return out({ ops, unparsed, applied, skipped, diff: diffSnapshots(before, after) })
    }
    case "snapshot": {
      const snap = await loadData(str(f, "project") ?? "data-sample.json")
      const store = openStore(str(f, "db"))
      const row = store.saveSnapshot(snap, Date.now(), str(f, "label"))
      store.close()
      return out(row)
    }
    case "snapshots": {
      const store = openStore(str(f, "db"))
      const rows = store.listSnapshots()
      store.close()
      return out(rows)
    }
    case "export": {
      const snap = await loadData(str(f, "project") ?? "data-sample.json")
      const svg = f.timeline ? timelineSvg(snap) : boardSvg(snap)
      const outPath = str(f, "out")
      if (outPath) {
        await Deno.writeTextFile(outPath, svg)
        return out({ wrote: outPath, bytes: svg.length })
      }
      return out(svg)
    }
    case "context": {
      const batchFile = str(f, "project")
      const named = str(f, "issues")?.split(",").map((n) => n.trim()).filter(Boolean)
      const issue = batchFile || named ? undefined : str(f, "issue") ?? fail("context needs --issue <identifier>")
      const names = str(f, "sources")
      const { sources, unconfigured } = await configuredSources(
        names ? names.split(",").map((n) => n.trim()).filter(Boolean) : undefined,
      )
      const fixture = str(f, "fixture")
      if (fixture) sources.push(await fixtureFromFile(fixture))
      const num = (k: string) => (str(f, k) !== undefined ? Number(str(f, k)) : undefined)
      const cachePath = str(f, "cache")
      const cache = openCache(f["no-cache"] === true ? null : cachePath)
      const shared = {
        tracker: str(f, "tracker"),
        days: num("days"),
        actor: str(f, "actor"),
        text: str(f, "text"),
        limit: num("limit"),
      }
      try {
        if (issue !== undefined) {
          const result = await issueContext({ ...shared, issue, createdAt: str(f, "created") }, sources, cache)
          return out({ ...result, unconfigured })
        }
        const batch = await issueContextBatch(
          await batchIssues(batchFile, named, str(f, "created")),
          shared,
          sources,
          cache,
        )
        return out({ ...batch, unconfigured })
      } finally {
        cache.close()
      }
    }
    default:
      fail(`unknown command "${cmd ?? ""}". run with no args to see usage.`)
  }
}

// Resolve the before/after snapshots for diff and review, from two files (--a/--b) or from the store
// (--from/--to, or the review pointer and latest for review). In review mode the window is scoped to
// the newest capture's own project, and earlier captures of it come back as `history` so a ticket that
// left and returned reads as a return rather than as new.
async function twoSnapshots(
  f: Flags,
  reviewMode = false,
): Promise<{
  before: Snapshot
  after: Snapshot
  history: Snapshot[]
  window?: { store: ReturnType<typeof openStore>; toId: number; advance: boolean; projectKey: string }
}> {
  const a = str(f, "a")
  const b = str(f, "b")
  if (a && b) return { before: await loadData(a), after: await loadData(b), history: [] }

  const store = openStore(str(f, "db"))
  const rows = store.listSnapshots()
  if (reviewMode && !str(f, "from")) {
    if (rows.length === 0) fail("no snapshots stored. run `tlr snapshot --project <file>` first.")
    const latest = rows[0]
    const mine = rows.filter((r) => r.projectKey === latest.projectKey)
    const pointer = store.getReviewPointer(latest.projectKey)
    const anchor = mine.find((r) => r.id === pointer) ?? mine[mine.length - 1]
    const before = store.loadSnapshot(anchor.id)
    const after = store.loadSnapshot(latest.id)
    const history = store.loadHistoryBefore(latest.projectKey, anchor.capturedAt)
    return {
      before,
      after,
      history,
      window: { store, toId: latest.id, advance: f["no-advance"] !== true, projectKey: latest.projectKey },
    }
  }
  const fromId = Number(str(f, "from"))
  const toId = Number(str(f, "to"))
  if (!fromId || !toId) fail("diff needs --a/--b files, or --from/--to snapshot ids (see `tlr snapshots`).")
  const before = store.loadSnapshot(fromId)
  const after = store.loadSnapshot(toId)
  store.close()
  return { before, after, history: [] }
}

async function fixtureFromFile(path: string): Promise<ContextSource> {
  const records = JSON.parse(await Deno.readTextFile(resolveDataPath(path))) as FixtureRecord[]
  return fixtureSource(records[0]?.source ?? "fixture", records)
}

function usage(): void {
  console.log(
    [
      "tlr <command> [flags]",
      "",
      "  scan      --text <t> | --file <path> | --project <file>",
      "  context   --issue <id> [--created <iso>] [--days <n>] [--actor <who>] [--text <t>] [--sources <a,b>]",
      "  capacity  --project <file>",
      "  standup   --project <file> [--cycle <n>] [--lookback <n>] [--target <0-1>] [--out <name,name>]",
      "  balance   --project <file> [--weekly <n>] [--start <cycle>] [--end <cycle>] [--weeks <n>] [--lead <cycles>]",
      "  timeline  --project <file>",
      "  diff      --a <file> --b <file> | --from <id> --to <id>",
      "  report    --a <file> --b <file> | --from <id> --to <id> [--json]",
      "  forecast  --project <file> [--weekly <n>]",
      "  review    --a <file> --b <file> | --db <path> [--no-advance]",
      "  plan      --project <file> --text <guidance>",
      "  snapshot  --project <file> [--label <l>] [--db <path>]",
      "  snapshots [--db <path>]",
      "  export    --project <file> [--timeline] [--out <path>]",
      "",
      "A --project/--a/--b value with no slash is read from web/data.",
    ].join("\n"),
  )
}

export { parseFlags, run }

if (import.meta.main) {
  const [cmd, ...rest] = Deno.args
  if (!cmd || cmd === "help" || cmd === "--help") {
    usage()
    Deno.exit(0)
  }
  await run(cmd, parseFlags(rest))
}
