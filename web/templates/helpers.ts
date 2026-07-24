import type { Context } from "hono"
import { renderTemplate } from "./engine.ts"

export async function renderPage(
  pageTemplate: string,
  data: Record<string, unknown>,
  title: string,
  c: Context,
): Promise<Response> {
  const content = await renderTemplate(pageTemplate, data)
  const html = await renderTemplate("layouts/base.vto", { title, content })
  return c.html(html)
}
