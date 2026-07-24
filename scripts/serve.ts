import { Hono } from "hono"
import { serveStatic } from "hono/deno"

const app = new Hono()

app.use("*", serveStatic({ root: "./web" }))

const port = Number(Deno.env.get("PORT") ?? 8000)
console.log(`tlr demo on http://localhost:${port}`)
Deno.serve({ port }, app.fetch)
