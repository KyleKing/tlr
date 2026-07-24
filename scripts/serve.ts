// Dev server for the board, plus a small write API for the configuration panel: POST /api/config
// saves hand-edited capacity/roster values, POST /api/refresh re-runs the same Linear/Incident.io/
// Google Calendar fetches deno task issues and deno task capacity do from the CLI. That's why `deno
// task dev` carries their permissions too (--allow-run=security,open, unrestricted --allow-net,
// --allow-write scoped to ./web/data) rather than just --allow-read for static files.

import { Hono } from "hono"
import { serveStatic } from "hono/deno"
import { ingestProject, linearKey } from "./issues.ts"
import { type CapacityData, refreshCapacity } from "./capacity.ts"
import { renderPage } from "../web/templates/helpers.ts"

const DATA_ROOT = new URL("../web/data/", import.meta.url)

function safeDataFile(name: unknown): string | null {
  if (typeof name !== "string" || !/^[\w.-]+\.json$/.test(name)) return null
  return name
}

const app = new Hono()

// Configuration panel writes: the capacity block only, into the requesting project's own data file.
app.post("/api/config", async (c) => {
  const body = await c.req.json().catch(() => null)
  const dataFile = safeDataFile(body?.dataFile)
  if (!dataFile || typeof body?.capacity !== "object" || body.capacity === null) {
    return c.json({ error: "expected { dataFile: string, capacity: object }" }, 400)
  }

  const path = new URL(dataFile, DATA_ROOT)
  const data = await Deno.readTextFile(path).then(JSON.parse).catch(() => ({}))
  data.capacity = body.capacity
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2) + "\n")
  return c.json({ ok: true })
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

const port = Number(Deno.env.get("PORT") ?? 8000)
console.log(`tlr demo on http://localhost:${port}`)
Deno.serve({ port }, app.fetch)
