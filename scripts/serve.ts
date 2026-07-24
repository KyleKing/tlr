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

function safeDataFile(name: unknown): string | null {
  if (typeof name !== "string" || !/^[\w.-]+\.json$/.test(name)) return null
  return name
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
    await Deno.writeTextFile(path, JSON.stringify(data, null, 2) + "\n")
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
      const key = await linearKey()
      const result = await ingestProject(key, projectQuery, data, dataFile)
      data = result.data
      log.push(...result.log)
    } else {
      log.push("issues: no project name to refresh — pass { project } or set data.project.name first")
    }

    log.push(...(await refreshCapacity(data)))

    await Deno.writeTextFile(path, JSON.stringify(data, null, 2) + "\n")
    return c.json({ ok: true, log })
  } catch (err) {
    return c.json({ ok: false, log, error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.get("/", (c) => renderPage("pages/board.vto", {}, "tlr — planning board (spike)", c))

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
