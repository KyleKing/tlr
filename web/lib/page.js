// Small shared helpers for the secondary pages (Changes, Review). The board's app.js has its own copy
// of this logic inline; these pages are lighter and only need project resolution and escaping.

import { pickProject } from "./issues.js"
import { wireProjectPicker } from "./nav.js"

// The project this page is about: honor ?project=<slug>, else the first in the manifest. Null when the
// manifest is empty (no projects configured yet). Also wires the shared nav's project picker, so every
// page that resolves a project this way gets the switcher for free.
export async function resolveProject() {
  const r = await fetch("/data/projects.json", { cache: "no-store" })
  const projects = r.ok ? await r.json() : []
  const slug = new URLSearchParams(location.search).get("project")
  const current = pickProject(projects, slug)
  wireProjectPicker(projects, current)
  return current
}

export function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}
