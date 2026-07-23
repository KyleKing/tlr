const ROOT = new URL("../web/", import.meta.url)

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
}

function contentType(path: string): string {
  const dot = path.lastIndexOf(".")
  return TYPES[path.slice(dot)] ?? "application/octet-stream"
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "")
  try {
    const file = await Deno.readFile(new URL(rel, ROOT))
    return new Response(file, { headers: { "content-type": contentType(rel) } })
  } catch {
    return new Response("Not found", { status: 404 })
  }
}

const port = Number(Deno.env.get("PORT") ?? 8000)
Deno.serve({ port }, handler)
console.log(`tlr demo on http://localhost:${port}`)
