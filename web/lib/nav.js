// Wires the project picker that lives in the shared nav (base.vto), so every page — not just the
// board — can switch projects. Callers already have `projects` and `current` from their own project
// resolution (board.js) or from resolveProject (the other pages); this only owns the <select> and the
// access-warning banner, both rendered once in the layout.

export function wireProjectPicker(projects, current) {
  const el = document.getElementById("global-project-picker")
  if (!el) return
  if (projects.length <= 1) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.innerHTML = projects.map((p) => `<option value="${p.slug}">${p.name}</option>`).join("")
  if (current) el.value = current.slug
  el.onchange = () => {
    const url = new URL(location.href)
    url.searchParams.set("project", el.value)
    location.href = url.toString()
  }
  checkAccess(projects, current, el)
}

// Best-effort, non-blocking: ask the server whether the current Linear key can still see each
// project, and warn (never hide — the check itself can be wrong or the key transiently down) when the
// project currently on screen looks inaccessible.
async function checkAccess(projects, current, el) {
  const access = await fetch("/api/projects/access", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
  for (const opt of el.options) {
    const project = projects.find((p) => p.slug === opt.value)
    if (project && access[project.slug] === false) opt.textContent = `⚠ ${project.name}`
  }
  const banner = document.getElementById("access-warning")
  if (banner && current && access[current.slug] === false) {
    banner.hidden = false
    banner.textContent =
      `⚠ The current Linear key doesn't see "${current.name}" — it may have lost access, or this key belongs to a different workspace. Data shown may be stale.`
  }
}
