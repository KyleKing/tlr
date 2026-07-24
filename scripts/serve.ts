// Dev server for the board, plus a small write API for the configuration panel: POST /api/config
// saves hand-edited capacity/roster values, POST /api/refresh re-runs the same Linear/Incident.io/
// Google Calendar fetches deno task issues and deno task capacity do from the CLI. That's why `deno
// task dev` carries their permissions too (--allow-run=security,open, unrestricted --allow-net,
// --allow-write scoped to ./web/data) rather than just --allow-read for static files.

import { Hono } from "hono"
import { serveStatic } from "hono/deno"
import { logger as honoLogger } from "hono/logger"
import { configure, getConsoleSink, getLogger } from "@logtape/logtape"
import { extendLogContext, getLogContext, initializeContext } from "@/logContext.ts"
import { getEnvConfig } from "@/utils/env.ts"
import { handleApiError } from "@/utils/errorHandler.ts"
import { ingestProject, linearKey } from "./issues.ts"
import { type CapacityData, refreshCapacity } from "./capacity.ts"
import { renderPage } from "../web/templates/helpers.ts"
import { openStore } from "@/snapshot.ts"
import { diffSnapshots } from "@/diff.ts"
import { weeklyReport } from "@/report.ts"
import { reviewSince } from "@/review.ts"
import { applyOps, type Op } from "@/ops.ts"
import { applyIssueEdits, isWritableOp } from "@/linear_write.ts"
import { checkProjectsAccess, slugIdFromUrl } from "@/linearAccess.ts"
import type { Snapshot } from "@/seed.ts"

const config = getEnvConfig()

await configure({
  sinks: {
    console: getConsoleSink({
      formatter: (record) => {
        const logEntry = {
          timestamp: new Date(record.timestamp).toISOString(),
          level: record.level,
          category: record.category,
          message: record.message,
          ...record.properties,
          ...(getLogContext() || {}),
        }
        return JSON.stringify(logEntry)
      },
    }),
  },
  loggers: [
    { category: ["app"], sinks: ["console"], lowestLevel: config.LOG_LEVEL },
    { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
  ],
})

const DATA_ROOT = new URL("../web/data/", import.meta.url)
// Overridable so e2e can point at a throwaway store instead of the real local one.
const SNAPSHOT_DB = Deno.env.get("TLR_SNAPSHOT_DB") ?? new URL("tlr.sqlite", DATA_ROOT).pathname
// Demo mode uses the free/test workspace key and shows a banner; live mode uses the real key.
const DEMO = config.DEMO
const KEY_ACCOUNT = DEMO ? "demo-key" : "api-key"

function safeDataFile(name: unknown): string | null {
  if (typeof name !== "string" || !/^[\w.-]+\.json$/.test(name)) return null
  return name
}

// Writes JSON to `path` atomically (write a sibling temp file, then rename over the target) so a
// concurrent reader — the board's own polling, another write in flight, a snapshot capture — never
// observes a half-written file. A plain writeTextFile can otherwise be read mid-write and throw
// "Unexpected end of JSON input", which is a real risk here: three different POST handlers write the
// same project data file, and nothing serializes them against each other or against a GET.
async function writeJsonAtomic(path: URL, data: unknown): Promise<void> {
  const tmp = new URL(`${path.href}.${crypto.randomUUID()}.tmp`)
  await Deno.writeTextFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await Deno.rename(tmp, path)
}

// The comparable shape of a snapshot: what a plan-level diff would notice. Used to skip a capture that
// would be identical to the latest one already stored for the project.
function snapshotSignature(s: Snapshot): string {
  return JSON.stringify({ asOf: s.asOf, milestones: s.milestones, issues: s.issues })
}

// Capture a snapshot into the local store, unless the project's latest stored snapshot is identical.
// Returns the saved row, or null when nothing changed. Opens and closes its own store handle.
function captureSnapshot(snapshot: Snapshot, label?: string): { id: number; skipped: boolean } {
  const store = openStore(SNAPSHOT_DB)
  try {
    const latest = store.listSnapshots().find((r) => r.projectName === snapshot.project.name)
    if (latest && snapshotSignature(store.loadSnapshot(latest.id)) === snapshotSignature(snapshot)) {
      return { id: latest.id, skipped: true }
    }
    const saved = store.saveSnapshot(snapshot, Date.now(), label)
    return { id: saved.id, skipped: false }
  } finally {
    store.close()
  }
}

// The two most recent snapshots for a project, oldest first, or null when there are fewer than two.
function recentPair(projectName: string): { before: Snapshot; after: Snapshot } | null {
  const store = openStore(SNAPSHOT_DB)
  try {
    const rows = store.listSnapshots().filter((r) => r.projectName === projectName)
    if (rows.length < 2) return null
    const after = store.loadSnapshot(rows[0].id)
    const before = store.loadSnapshot(rows[1].id)
    return { before, after }
  } finally {
    store.close()
  }
}

// A specific pair by snapshot id, oldest first regardless of the order given — so picking two entries
// from a list (in either order) always diffs forward in time. Null on a bad id or a project mismatch.
function pairById(
  projectName: string,
  fromId: number,
  toId: number,
): { before: Snapshot; after: Snapshot } | null {
  const store = openStore(SNAPSHOT_DB)
  try {
    const rows = store.listSnapshots().filter((r) => r.projectName === projectName)
    const ids = new Set(rows.map((r) => r.id))
    if (!ids.has(fromId) || !ids.has(toId) || fromId === toId) return null
    const [olderId, newerId] = fromId < toId ? [fromId, toId] : [toId, fromId]
    return { before: store.loadSnapshot(olderId), after: store.loadSnapshot(newerId) }
  } finally {
    store.close()
  }
}

const app = new Hono()
const logger = getLogger(["app"])

app.use("*", honoLogger())

// Request-scoped log context: every request runs inside its own AsyncLocalStorage scope so
// handleApiError and any downstream code can attach fields to a single canonical log line.
app.use("*", async (c, next) => {
  const startTime = performance.now()

  await initializeContext(async () => {
    extendLogContext({
      host: c.req.header("Host"),
      ipAddress: c.req.header("X-Forwarded-For"),
      method: c.req.method,
      path: c.req.path,
      requestId: crypto.randomUUID(),
      url: c.req.url,
      userAgent: c.req.header("User-Agent"),
    })

    await next()

    extendLogContext({
      status: c.res.status,
      duration: performance.now() - startTime,
      responseContentType: c.res.headers.get("Content-Type"),
    })

    if (c.res.status >= 500) {
      logger.error("Request completed")
    } else if (c.res.status >= 400) {
      logger.warning("Request completed")
    } else {
      logger.info("Request completed")
    }
  })
})

app.onError((err, c) => handleApiError(err, c, { message: "Request error" }))

// Configuration panel writes: the capacity block only, into the requesting project's own data file.
app.post("/api/config", async (c) => {
  const body = await c.req.json().catch(() => null)
  const dataFile = safeDataFile(body?.dataFile)
  if (!dataFile || typeof body?.capacity !== "object" || body.capacity === null) {
    return c.json({ error: "expected { dataFile: string, capacity: object }" }, 400)
  }

  try {
    const path = new URL(dataFile, DATA_ROOT)
    const data = await Deno.readTextFile(path).then(JSON.parse).catch(() => ({}))
    data.capacity = body.capacity
    await writeJsonAtomic(path, data)
    return c.json({ ok: true })
  } catch (err) {
    return handleApiError(err, c, { message: "Failed to save configuration", context: { dataFile } })
  }
})

// "Refresh all" button: re-fetches issues/roster from Linear (deno task issues), then on-call/out-days/
// velocity (deno task capacity), for the requesting project's data file. project defaults to the file's
// existing data.project.name.
app.post("/api/refresh", async (c) => {
  const body = await c.req.json().catch(() => null)
  const dataFile = safeDataFile(body?.dataFile)
  if (!dataFile) return c.json({ error: "expected { dataFile: string }" }, 400)

  type BoardData = CapacityData & { project?: { name?: string } }
  const path = new URL(dataFile, DATA_ROOT)
  let data: BoardData = await Deno.readTextFile(path).then(JSON.parse).catch(() => ({ cycles: [] }))
  const log: string[] = []

  try {
    const projectQuery = typeof body?.project === "string" ? body.project : data.project?.name
    if (projectQuery) {
      const key = await linearKey(KEY_ACCOUNT)
      const result = await ingestProject(key, projectQuery, data, dataFile)
      data = result.data
      log.push(...result.log)
    } else {
      log.push("issues: no project name to refresh — pass { project } or set data.project.name first")
    }

    log.push(...(await refreshCapacity(data)))

    await writeJsonAtomic(path, data)

    if (data.project?.name && Array.isArray((data as { issues?: unknown }).issues)) {
      const capture = captureSnapshot(data as unknown as Snapshot, "refresh")
      log.push(capture.skipped ? "snapshot: unchanged, not captured" : `snapshot: captured #${capture.id}`)
    }
    return c.json({ ok: true, log })
  } catch (err) {
    return c.json({ ok: false, log, error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// Explicit snapshot capture of a data file, for building history offline (no Linear key). The live
// path captures on refresh above; this is the manual/seed path and the same dedupe applies.
app.post("/api/snapshot", async (c) => {
  const body = await c.req.json().catch(() => null)
  const dataFile = safeDataFile(body?.dataFile)
  if (!dataFile) return c.json({ error: "expected { dataFile: string }" }, 400)
  try {
    const snapshot = await Deno.readTextFile(new URL(dataFile, DATA_ROOT)).then(JSON.parse) as Snapshot
    if (!snapshot?.project?.name || !Array.isArray(snapshot.issues)) {
      return c.json({ error: "data file is not a snapshot" }, 400)
    }
    const capture = captureSnapshot(snapshot, typeof body?.label === "string" ? body.label : "manual")
    return c.json({ ok: true, ...capture })
  } catch (err) {
    return handleApiError(err, c, { message: "Failed to capture snapshot", context: { dataFile } })
  }
})

// Apply reviewed fixes to a ticket. This is the one write path to Linear, and only from the UI. Body
// is { dataFile, ops, confirm? }. Without confirm it is a dry run: ops are validated in memory and the
// resulting change previewed, nothing leaves the process. With confirm it writes each op to the mode's
// workspace (demo or live), then mirrors the edits that succeeded into the local data file so the board
// matches Linear. Ops outside the v1 writable set (title, description, estimate, priority) are refused
// rather than applied locally, so the file never drifts from Linear.
app.post("/api/edit", async (c) => {
  const body = await c.req.json().catch(() => null)
  const dataFile = safeDataFile(body?.dataFile)
  if (!dataFile || !Array.isArray(body?.ops)) return c.json({ error: "expected { dataFile: string, ops: [] }" }, 400)

  const ops = body.ops as Op[]
  const confirm = body?.confirm === true
  const path = new URL(dataFile, DATA_ROOT)

  try {
    const snapshot = await Deno.readTextFile(path).then(JSON.parse) as Snapshot
    if (!snapshot?.project?.name || !Array.isArray(snapshot.issues)) {
      return c.json({ error: "data file is not a snapshot" }, 400)
    }

    const writable = ops.filter(isWritableOp)
    const unsupported = ops.filter((op) => !isWritableOp(op)).map((op) => ({ op, reason: "field not editable yet" }))
    const { applied, skipped } = applyOps(snapshot, writable)
    const preview = [...skipped, ...unsupported]

    if (!confirm) {
      return c.json({ mode: DEMO ? "demo" : "live", dryRun: true, willApply: applied, skipped: preview })
    }

    const key = await linearKey(KEY_ACCOUNT)
    const results = await applyIssueEdits(key, applied, snapshot.issues)
    const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id))
    const okOps = applied.filter((op) => okIds.has(op.id))
    if (okOps.length) {
      const updated = applyOps(snapshot, okOps).after
      await writeJsonAtomic(path, updated)
    }
    return c.json({ mode: DEMO ? "demo" : "live", dryRun: false, results, skipped: preview })
  } catch (err) {
    return handleApiError(err, c, { message: "Failed to apply edit", context: { dataFile } })
  }
})

// Stored snapshots for a project, newest first.
app.get("/api/snapshots", (c) => {
  const project = c.req.query("project")
  if (!project) return c.json({ error: "expected ?project=<name>" }, 400)
  const store = openStore(SNAPSHOT_DB)
  try {
    return c.json(store.listSnapshots().filter((r) => r.projectName === project))
  } finally {
    store.close()
  }
})

// Weekly-update narrative from the diff of two snapshots: the project's two most recent by default,
// or a specific ?from=<id>&to=<id> pair so the Changes page can browse snapshot history, not just the
// latest window.
app.get("/api/report", (c) => {
  const project = c.req.query("project")
  if (!project) return c.json({ error: "expected ?project=<name>" }, 400)
  const from = c.req.query("from")
  const to = c.req.query("to")
  const pair = from && to ? pairById(project, Number(from), Number(to)) : recentPair(project)
  if (!pair) return c.json({ report: null, reason: "need at least two snapshots" })
  return c.json({ report: weeklyReport(diffSnapshots(pair.before, pair.after)) })
})

// Review queue (added, removed, moved, re-estimated, status, slop) between a project's two most recent
// snapshots. Read-only: the review pointer is not advanced here.
app.get("/api/review", (c) => {
  const project = c.req.query("project")
  if (!project) return c.json({ error: "expected ?project=<name>" }, 400)
  const pair = recentPair(project)
  if (!pair) return c.json({ window: null, items: [], reason: "need at least two snapshots" })
  return c.json(reviewSince(pair.before, pair.after))
})

// Which workspace writes land in, so the client can label buttons and confirm before a live mutation.
app.get("/api/mode", (c) => c.json({ demo: DEMO, workspace: DEMO ? "demo" : "live" }))

// Whether the current key can still see each locally-ingested project, so the picker can warn on a
// revoked or wrong-workspace key instead of silently showing stale data. Best-effort: an unset key or
// a Linear outage yields an empty map rather than failing the request. Skipped entirely under the e2e
// harness (TLR_SNAPSHOT_DB set) — e2e never has, or should reach for, a live Linear connection.
app.get("/api/projects/access", async (c) => {
  if (Deno.env.get("TLR_SNAPSHOT_DB")) return c.json({})
  const manifest: { slug: string; dataFile: string }[] = await Deno.readTextFile(
    new URL("projects.json", DATA_ROOT),
  ).then(JSON.parse).catch(() => [])
  const key = await linearKey(KEY_ACCOUNT).catch(() => null)
  if (!key || !manifest.length) return c.json({})

  // Prefer the slugId parsed from the project's own Linear url (from its data file) over the
  // manifest's own slug field, which isn't guaranteed to be Linear's real id (see slugIdFromUrl).
  const slugIdByManifestSlug = new Map<string, string>()
  for (const entry of manifest) {
    const data = await Deno.readTextFile(new URL(entry.dataFile, DATA_ROOT)).then(JSON.parse).catch(() => null)
    slugIdByManifestSlug.set(entry.slug, slugIdFromUrl(data?.project?.url) ?? entry.slug)
  }

  const access = await checkProjectsAccess(key, [...slugIdByManifestSlug.values()])
  const bySlugId: Record<string, boolean> = {}
  for (const [manifestSlug, slugId] of slugIdByManifestSlug) bySlugId[manifestSlug] = access[slugId] ?? false
  return c.json(bySlugId)
})

app.get(
  "/",
  (c) =>
    renderPage("pages/board.vto", {}, "tlr — planning board", c, { active: "board", script: "/app.js", demo: DEMO }),
)
app.get(
  "/changes",
  (c) =>
    renderPage("pages/changes.vto", {}, "tlr — changes", c, { active: "changes", script: "/changes.js", demo: DEMO }),
)
app.get(
  "/review",
  (c) => renderPage("pages/review.vto", {}, "tlr — review", c, { active: "review", script: "/review.js", demo: DEMO }),
)
app.get(
  "/settings",
  (c) =>
    renderPage("pages/settings.vto", {}, "tlr — settings", c, {
      active: "settings",
      script: "/settings.js",
      demo: DEMO,
    }),
)

app.use("*", serveStatic({ root: "./web" }))

app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404))

Deno.serve({
  port: config.PORT,
  hostname: config.HOST,
  onListen: ({ hostname, port }) => {
    console.log(`tlr demo on http://${hostname}:${port}`)
    console.log(`Environment: ${config.NODE_ENV}`)
  },
}, app.fetch)
