import type { Context } from "hono"
import { renderTemplate } from "./engine.ts"

type PageOptions = { script?: string; active?: string }

export async function renderPage(
  pageTemplate: string,
  data: Record<string, unknown>,
  title: string,
  c: Context,
  opts: PageOptions = {},
): Promise<Response> {
  const content = await renderTemplate(pageTemplate, data)
  const html = await renderTemplate("layouts/base.vto", {
    title,
    content,
    script: opts.script ?? "/app.js",
    active: opts.active ?? "board",
  })
  return c.html(html)
}
