import vento from "vento/mod.ts"
import { autoTrim } from "./autoTrim.ts"

// Docs: https://vento.js.org/configuration
export const engine = vento({ autoescape: true })

export async function renderTemplate(name: string, data: Record<string, unknown> = {}): Promise<string> {
  const template = await engine.load(new URL(name, import.meta.url).pathname)
  const result = await template(data)
  return autoTrim(result.content)
}
