// A visible, in-page error surface. Deno's server log only sees requests that actually reach it — a
// client-side exception (a bad JSON shape, a thrown error inside render logic, a network failure that
// never completes) has nothing to log there and was previously silent: the page just did nothing.
// Installs global handlers for uncaught errors and rejected promises, and exports showError() for
// code that already catches an error but still wants it visible (not just in devtools).

function ensureBanner() {
  let el = document.getElementById("js-error")
  if (el) return el
  el = document.createElement("div")
  el.id = "js-error"
  el.className = "js-error"
  el.hidden = true
  document.body.prepend(el)
  return el
}

// message plus the full stack (when available), so "it's broken" comes with enough to act on
// without opening devtools. Errors stack (most recent on top) instead of replacing each other.
export function showError(err, context) {
  const banner = ensureBanner()
  banner.hidden = false
  const label = context ? `${context}: ` : ""
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error && err.stack ? err.stack : null
  const entry = document.createElement("div")
  entry.className = "js-error-entry"
  entry.innerHTML = `<div class="js-error-head"><span>⚠ ${label}${escapeHtml(message)}</span>` +
    `<button type="button" class="js-error-dismiss" aria-label="Dismiss">✕</button></div>` +
    (stack ? `<pre class="js-error-stack">${escapeHtml(stack)}</pre>` : "")
  entry.querySelector(".js-error-dismiss").onclick = () => {
    entry.remove()
    if (!banner.children.length) banner.hidden = true
  }
  banner.prepend(entry)
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}

export function installGlobalErrorHandlers() {
  globalThis.addEventListener("error", (e) => showError(e.error ?? e.message, "Unhandled error"))
  globalThis.addEventListener("unhandledrejection", (e) => showError(e.reason, "Unhandled rejection"))
}

installGlobalErrorHandlers()
