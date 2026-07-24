// Local snapshot store backed by node:sqlite. Holds each capture as JSON plus a few queryable
// columns, and a small key-value table for the review pointer. All SQL is parameterized and errors
// propagate to the caller.

import { DatabaseSync } from "node:sqlite"
import type { Snapshot } from "@/seed.ts"

export const DEFAULT_DB_PATH = "./tlr.sqlite"
const REVIEW_POINTER_KEY = "reviewPointer"

export type SnapshotRow = {
  id: number
  capturedAt: number
  label: string | null
  projectName: string
  asOf: string
}

export type SavedSnapshot = { id: number; capturedAt: number; label: string | null }

export type SnapshotStore = {
  saveSnapshot(snapshot: Snapshot, capturedAt: number, label?: string): SavedSnapshot
  listSnapshots(): SnapshotRow[]
  loadSnapshot(id: number): Snapshot
  getReviewPointer(): number | null
  setReviewPointer(snapshotId: number): void
  close(): void
}

// Open (or create) a store at the given path. Call close() when done.
export function openStore(path: string = DEFAULT_DB_PATH): SnapshotStore {
  const db = new DatabaseSync(path)
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
  `)

  return {
    saveSnapshot(snapshot, capturedAt, label) {
      const stmt = db.prepare(
        "INSERT INTO snapshots (captured_at, label, project_name, as_of, json) VALUES (?, ?, ?, ?, ?)",
      )
      const info = stmt.run(
        capturedAt,
        label ?? null,
        snapshot.project.name,
        snapshot.asOf,
        JSON.stringify(snapshot),
      )
      return { id: Number(info.lastInsertRowid), capturedAt, label: label ?? null }
    },

    listSnapshots() {
      const rows = db.prepare(
        "SELECT id, captured_at, label, project_name, as_of FROM snapshots ORDER BY captured_at DESC, id DESC",
      ).all() as Record<string, unknown>[]
      return rows.map((r) => ({
        id: Number(r.id),
        capturedAt: Number(r.captured_at),
        label: (r.label as string | null) ?? null,
        projectName: r.project_name as string,
        asOf: r.as_of as string,
      }))
    },

    loadSnapshot(id) {
      const row = db.prepare("SELECT json FROM snapshots WHERE id = ?").get(id) as
        | { json: string }
        | undefined
      if (!row) throw new Error(`snapshot ${id} not found`)
      return JSON.parse(row.json) as Snapshot
    },

    getReviewPointer() {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(REVIEW_POINTER_KEY) as
        | { value: string }
        | undefined
      return row ? Number(row.value) : null
    },

    setReviewPointer(snapshotId) {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(REVIEW_POINTER_KEY, String(snapshotId))
    },

    close() {
      db.close()
    },
  }
}
