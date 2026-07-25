// Stable identity for a project across captures. Pure, no I/O.
//
// A snapshot's project block carries a display name that a human can rename in Linear at any time, so
// the name alone cannot key a history. Linear's project URL ends in `<name-slug>-<slugId>`, and the
// slugId survives a rename, so it is the best rename-stable key available from data already captured.
// When ingest starts recording `id`/`slugId` directly, those win without a migration.

export type ProjectRef = { name: string; url?: string | null; id?: string | null; slugId?: string | null }

const SLUG_ID = /-([0-9a-f]{8,32})$/i

export function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

function slugIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const segments = url.split(/[?#]/)[0].replace(/\/+$/, "").split("/")
  for (const segment of segments.reverse()) {
    const match = SLUG_ID.exec(segment)
    if (match) return match[1].toLowerCase()
  }
  return null
}

// A key of the form `<kind>:<value>`. Only `name:` keys are unstable across a rename.
export function projectKey(project: ProjectRef): string {
  if (project.id) return `id:${project.id}`
  const slug = project.slugId ?? slugIdFromUrl(project.url)
  if (slug) return `slug:${slug.toLowerCase()}`
  return `name:${normalizeProjectName(project.name)}`
}

export function isStableProjectKey(key: string): boolean {
  return !key.startsWith("name:")
}

export type ProjectKeyRow = { id: number; capturedAt: number; project: ProjectRef }

export type ProjectKeyAssignment = { id: number; projectKey: string }

// Decide the key for each row, folding rows that only yield a name key into the stable key of the
// newest row sharing that name. Two rows with different stable keys stay apart even when the display
// name matches, because that is two projects, not one renamed project.
export function resolveProjectKeys(rows: ProjectKeyRow[]): ProjectKeyAssignment[] {
  const canonical = new Map<string, string>()
  const newest = new Map<string, number>()
  for (const row of rows) {
    const key = projectKey(row.project)
    if (!isStableProjectKey(key)) continue
    const name = normalizeProjectName(row.project.name)
    if ((newest.get(name) ?? -Infinity) >= row.capturedAt) continue
    newest.set(name, row.capturedAt)
    canonical.set(name, key)
  }
  return rows.map((row) => {
    const key = projectKey(row.project)
    if (isStableProjectKey(key)) return { id: row.id, projectKey: key }
    return { id: row.id, projectKey: canonical.get(normalizeProjectName(row.project.name)) ?? key }
  })
}
