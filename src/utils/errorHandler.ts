import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { extendLogContext } from "@/logContext.ts"

export interface ErrorContext {
  [key: string]: unknown
}

export interface ApiErrorOptions {
  message?: string
  statusCode?: ContentfulStatusCode
  context?: ErrorContext
  responseType?: "html" | "json" | "text"
}

export function handleApiError(
  error: unknown,
  c: Context,
  options: ApiErrorOptions = {},
): Response {
  const {
    message = "An error occurred",
    statusCode = 500,
    context = {},
    responseType = c.req.path.startsWith("/api/") ? "json" : "html",
  } = options

  const err = error as Error
  extendLogContext({
    errorUser: message,
    error: { name: err.name, message: err.message, stack: err.stack },
    request: { method: c.req.method, path: c.req.path },
    context,
  })

  if (responseType === "json") {
    return c.json({ error: message, details: err.message }, statusCode)
  }
  if (responseType === "text") {
    return c.text(`${message}: ${err.message}`, statusCode)
  }
  const html = `<div class="error"><h1>Error</h1><p>${err.message}</p></div>`
  return c.html(html, statusCode)
}
