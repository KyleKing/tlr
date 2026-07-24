import { Hono } from "hono"
import { serveStatic } from "hono/deno"

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

app.use("*", serveStatic({ root: "./web" }))

const port = Number(Deno.env.get("PORT") ?? 8000)
console.log(`tlr demo on http://localhost:${port}`)
Deno.serve({ port }, app.fetch)
