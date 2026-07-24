// Wires the project picker that lives in the shared nav (base.vto), so every page — not just the
// board — can switch projects. Callers already have `projects` and `current` from their own project
// resolution (board.js) or from resolveProject (the other pages); this only owns the <select> and the
// access-warning banner, both rendered once in the layout.

import { pickProject } from "./issues.js"

const PROJECT_KEY = "tlr.project"

// The project to use when the URL doesn't say: honor ?project=<slug> first, else the last one picked
// (localStorage), else the manifest's first entry. Persists whatever it lands on, so a refresh or a
// same-origin navigation that drops the query param still lands back on the right project instead of
// silently resetting to the first manifest entry.
export function resolveProjectSlug(projects, requestedSlug) {
  const project = pickProject(projects, requestedSlug ?? localStorage.getItem(PROJECT_KEY))
  if (project) localStorage.setItem(PROJECT_KEY, project.slug)
  return project
}

// Keeps ?project=<slug> on the Board/Changes/Review/Settings links, so switching pages doesn't drop
// the current project (the links are plain hrefs in the server-rendered layout).
function syncNavLinks(slug) {
  for (const a of document.querySelectorAll(".topnav a[href^='/']")) {
    const url = new URL(a.getAttribute("href"), location.origin)
    url.searchParams.set("project", slug)
    a.setAttribute("href", `${url.pathname}${url.search}`)
  }
}

export function wireProjectPicker(projects, current) {
  if (current) syncNavLinks(current.slug)
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
    localStorage.setItem(PROJECT_KEY, el.value)
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
