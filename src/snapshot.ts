// Local snapshot store backed by node:sqlite. Holds each capture as JSON plus a few queryable
// columns, and a small key-value table for the review pointers. All SQL is parameterized and errors
// propagate to the caller.
//
// Each project carries its own review pointer under `reviewPointer:<project_key>`, so switching
// projects does not restart another project's review queue. The bare `reviewPointer` key is the
// pre-per-project one: a project with no pointer of its own falls back to it, and it is still the key
// a no-argument read or write uses.
//
// The store runs in WAL mode with a busy timeout, and exposes transaction() so a caller doing a
// read-modify-write (the dedupe in captureSnapshot) can hold the write lock across the whole
// sequence instead of racing another capture.
//
// Snapshots are grouped into a history by project_key, not by the display name, so renaming the
// project in Linear does not fork the history. See src/projectIdentity.ts.

import { DatabaseSync } from "node:sqlite"
import {
  isStableProjectKey,
  projectKey,
  type ProjectKeyRow,
  resolveProjectKeys,
  slugToIdKeys,
} from "@/projectIdentity.ts"
import type { Snapshot } from "@/seed.ts"

export const DEFAULT_DB_PATH = "./tlr.sqlite"
const BUSY_TIMEOUT_MS = 10_000
const DEFAULT_HISTORY_LIMIT = 24
const REVIEW_POINTER_KEY = "reviewPointer"

export type SnapshotRow = {
  id: number
  capturedAt: number
  label: string | null
  projectName: string
  projectKey: string
  asOf: string
  bytes: number
}

export type SavedSnapshot = { id: number; capturedAt: number; label: string | null }

export type SnapshotStore = {
  saveSnapshot(snapshot: Snapshot, capturedAt: number, label?: string): SavedSnapshot
  listSnapshots(): SnapshotRow[]
  listProjectSnapshots(projectKey: string): SnapshotRow[]
  loadSnapshot(id: number): Snapshot
  loadHistoryBefore(projectKey: string, capturedAt: number, limit?: number): Snapshot[]
  deleteSnapshots(ids: number[]): number
  projectKeyForName(name: string): string | null
  rekeyProject(fromKey: string, toKey: string): number
  getReviewPointer(projectKey?: string): number | null
  setReviewPointer(snapshotId: number, projectKey?: string): void
  listReviewPointers(): number[]
  transaction<T>(fn: () => T): T
  vacuum(): void
  close(): void
}

type Row = Record<string, unknown>

function toRow(r: Row): SnapshotRow {
  return {
    id: Number(r.id),
    capturedAt: Number(r.captured_at),
    label: (r.label as string | null) ?? null,
    projectName: r.project_name as string,
    projectKey: (r.project_key as string | null) ?? `name:${r.project_name}`,
    asOf: r.as_of as string,
    bytes: Number(r.bytes ?? 0),
  }
}

const ROW_COLUMNS = "id, captured_at, label, project_name, project_key, as_of, length(json) AS bytes"

function pointerKey(projectKey?: string): string {
  return projectKey ? `${REVIEW_POINTER_KEY}:${projectKey}` : REVIEW_POINTER_KEY
}

function readMeta(db: DatabaseSync, key: string): number | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
  return row ? Number(row.value) : null
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
  return cols.some((c) => c.name === column)
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at INTEGER NOT NULL,
      label TEXT,
      project_name TEXT NOT NULL,
      as_of TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_identity (
      project_name TEXT PRIMARY KEY,
      project_key TEXT NOT NULL
    );
  `)
  if (!hasColumn(db, "snapshots", "project_key")) {
    db.exec("ALTER TABLE snapshots ADD COLUMN project_key TEXT")
  }
  db.exec("CREATE INDEX IF NOT EXISTS snapshots_project_key ON snapshots (project_key, captured_at DESC)")
  backfillProjectKeys(db)
  mergeForkedProjectKeys(db)
}

const PROJECT_BLOCK_SQL = `
  SELECT id, captured_at, project_name,
         json_extract(json, '$.project.url') AS url,
         json_extract(json, '$.project.id') AS project_id,
         json_extract(json, '$.project.slugId') AS slug_id
    FROM snapshots
`

function projectKeyRows(db: DatabaseSync, where: string): ProjectKeyRow[] {
  return (db.prepare(`${PROJECT_BLOCK_SQL} ${where}`).all() as Row[]).map((r) => ({
    id: Number(r.id),
    capturedAt: Number(r.captured_at),
    project: {
      name: r.project_name as string,
      url: (r.url as string | null) ?? null,
      id: (r.project_id as string | null) ?? null,
      slugId: (r.slug_id as string | null) ?? null,
    },
  }))
}

// Repair a history forked across two keys for one project. Captures taken before ingest recorded
// Linear's project id were keyed by the slugId in the URL, and once the id arrived the same project
// started a second history under `id:`. Both keys are stable, so the original backfill left them
// apart, and the Changes and Review pages saw only whichever half the current key pointed at.
//
// Only rows carrying both an id and a slug can prove the link, so a store with no such row is left
// alone. The scan is skipped entirely unless both kinds of key are present.
function mergeForkedProjectKeys(db: DatabaseSync): void {
  const counts = db.prepare(`
    SELECT SUM(project_key LIKE 'slug:%') AS slugs, SUM(project_key LIKE 'id:%') AS ids FROM snapshots
  `).get() as { slugs: number | null; ids: number | null }
  if (!counts?.slugs || !counts?.ids) return

  const rows = projectKeyRows(db, "")
  const links = slugToIdKeys(rows)
  if (!links.size) return

  const setKey = db.prepare("UPDATE snapshots SET project_key = ? WHERE project_key = ?")
  // A pointer follows its history. Keeping the newer of the two means a merge never rewinds the review
  // queue over changes already cleared.
  const pointers = db.prepare("SELECT key, value FROM meta WHERE key LIKE ?").all(
    `${REVIEW_POINTER_KEY}:%`,
  ) as { key: string; value: string }[]
  const setPointer = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
  const dropPointer = db.prepare("DELETE FROM meta WHERE key = ?")
  const dropIdentity = db.prepare("DELETE FROM project_identity WHERE project_key = ?")
  const setIdentity = db.prepare(
    "INSERT INTO project_identity (project_name, project_key) VALUES (?, ?) ON CONFLICT(project_name) DO UPDATE SET project_key = ?",
  )
  const nameOf = new Map(rows.map((r) => [r.project.id ? `id:${r.project.id}` : "", r.project.name]))

  db.exec("BEGIN IMMEDIATE")
  try {
    for (const [from, to] of links) {
      setKey.run(to, from)
      const oldPointer = pointers.find((p) => p.key === `${REVIEW_POINTER_KEY}:${from}`)
      if (oldPointer) {
        const current = pointers.find((p) => p.key === `${REVIEW_POINTER_KEY}:${to}`)
        const winner = current && Number(current.value) > Number(oldPointer.value) ? current.value : oldPointer.value
        setPointer.run(`${REVIEW_POINTER_KEY}:${to}`, winner, winner)
        dropPointer.run(oldPointer.key)
      }
      dropIdentity.run(from)
      const name = nameOf.get(to)
      if (name) setIdentity.run(name, to, to)
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

// One-time repair of rows captured before project_key existed. Reads only the project block out of
// each row's JSON, never the issues, so an unpruned store does not pay for the whole history here.
function backfillProjectKeys(db: DatabaseSync): void {
  const rows = projectKeyRows(db, "WHERE project_key IS NULL")
  if (!rows.length) return
  const namesById = new Map(rows.map((r) => [r.id, r.project.name]))

  const setKey = db.prepare("UPDATE snapshots SET project_key = ? WHERE id = ?")
  const bind = db.prepare(
    "INSERT INTO project_identity (project_name, project_key) VALUES (?, ?) ON CONFLICT(project_name) DO NOTHING",
  )
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const assignment of resolveProjectKeys(rows)) {
      setKey.run(assignment.projectKey, assignment.id)
      bind.run(namesById.get(assignment.id)!, assignment.projectKey)
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

// Open (or create) a store at the given path. Call close() when done.
export function openStore(path: string = DEFAULT_DB_PATH): SnapshotStore {
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  migrate(db)

  let depth = 0

  const store: SnapshotStore = {
    saveSnapshot(snapshot, capturedAt, label) {
      return store.transaction(() => {
        const key = bindProjectKey(db, store, snapshot)
        const stmt = db.prepare(
          "INSERT INTO snapshots (captured_at, label, project_name, project_key, as_of, json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        const info = stmt.run(
          capturedAt,
          label ?? null,
          snapshot.project.name,
          key,
          snapshot.asOf,
          JSON.stringify(snapshot),
        )
        return { id: Number(info.lastInsertRowid), capturedAt, label: label ?? null }
      })
    },

    listSnapshots() {
      const rows = db.prepare(
        `SELECT ${ROW_COLUMNS} FROM snapshots ORDER BY captured_at DESC, id DESC`,
      ).all() as Row[]
      return rows.map(toRow)
    },

    listProjectSnapshots(key) {
      const rows = db.prepare(
        `SELECT ${ROW_COLUMNS} FROM snapshots WHERE project_key = ? ORDER BY captured_at DESC, id DESC`,
      ).all(key) as Row[]
      return rows.map(toRow)
    },

    loadSnapshot(id) {
      const row = db.prepare("SELECT json FROM snapshots WHERE id = ?").get(id) as
        | { json: string }
        | undefined
      if (!row) throw new Error(`snapshot ${id} not found`)
      return JSON.parse(row.json) as Snapshot
    },

    loadHistoryBefore(key, capturedAt, limit = DEFAULT_HISTORY_LIMIT) {
      const rows = db.prepare(
        `SELECT json FROM snapshots WHERE project_key = ? AND captured_at < ?
         ORDER BY captured_at DESC, id DESC LIMIT ?`,
      ).all(key, capturedAt, limit) as { json: string }[]
      return rows.map((r) => JSON.parse(r.json) as Snapshot)
    },

    deleteSnapshots(ids) {
      if (!ids.length) return 0
      const pointers = new Set(store.listReviewPointers())
      const deletable = ids.filter((id) => !pointers.has(id))
      if (!deletable.length) return 0
      const placeholders = deletable.map(() => "?").join(", ")
      const info = db.prepare(`DELETE FROM snapshots WHERE id IN (${placeholders})`).run(...deletable)
      return Number(info.changes)
    },

    projectKeyForName(name) {
      const row = db.prepare("SELECT project_key FROM project_identity WHERE project_name = ?").get(name) as
        | { project_key: string }
        | undefined
      if (row) return row.project_key
      const fromSnapshot = db.prepare(
        "SELECT project_key FROM snapshots WHERE project_name = ? ORDER BY captured_at DESC LIMIT 1",
      ).get(name) as { project_key: string | null } | undefined
      return fromSnapshot?.project_key ?? null
    },

    rekeyProject(fromKey, toKey) {
      return store.transaction(() => {
        const info = db.prepare("UPDATE snapshots SET project_key = ? WHERE project_key = ?").run(toKey, fromKey)
        db.prepare("UPDATE project_identity SET project_key = ? WHERE project_key = ?").run(toKey, fromKey)
        return Number(info.changes)
      })
    },

    getReviewPointer(key) {
      const own = readMeta(db, pointerKey(key))
      if (own !== null || key === undefined) return own
      return readMeta(db, REVIEW_POINTER_KEY)
    },

    setReviewPointer(snapshotId, key) {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(pointerKey(key), String(snapshotId))
    },

    listReviewPointers() {
      const rows = db.prepare(
        "SELECT value FROM meta WHERE key = ? OR key LIKE ?",
      ).all(REVIEW_POINTER_KEY, `${REVIEW_POINTER_KEY}:%`) as Row[]
      return rows.map((r) => Number(r.value)).filter(Number.isInteger)
    },

    transaction(fn) {
      if (depth > 0) return fn()
      db.exec("BEGIN IMMEDIATE")
      depth += 1
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      } finally {
        depth -= 1
      }
    },

    vacuum() {
      db.exec("VACUUM")
    },

    close() {
      db.close()
    },
  }

  return store
}

// Resolve the key this snapshot's project should be stored under, and record the name -> key binding.
// A project that only ever yielded a name key gets folded into its stable key the first time one
// appears, so history captured before the URL carried a slugId does not sit in a separate bucket.
function bindProjectKey(db: DatabaseSync, store: SnapshotStore, snapshot: Snapshot): string {
  const project = snapshot.project
  const derived = projectKey(project)
  const bound = store.projectKeyForName(project.name)

  if (!isStableProjectKey(derived)) return bound ?? bindName(db, project.name, derived)
  if (bound && bound !== derived && !isStableProjectKey(bound)) store.rekeyProject(bound, derived)
  db.prepare(
    "INSERT INTO project_identity (project_name, project_key) VALUES (?, ?) " +
      "ON CONFLICT(project_name) DO UPDATE SET project_key = excluded.project_key",
  ).run(project.name, derived)
  return derived
}

function bindName(db: DatabaseSync, name: string, key: string): string {
  db.prepare(
    "INSERT INTO project_identity (project_name, project_key) VALUES (?, ?) ON CONFLICT(project_name) DO NOTHING",
  ).run(name, key)
  return key
}
