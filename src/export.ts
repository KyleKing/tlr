// Deterministic SVG export of the planning board and the dependency timeline, for weekly-update
// artifacts. Pure string generation: no browser, no I/O, no clock, no random. Same snapshot in gives
// the same bytes out, so a re-export diffs cleanly and a test can assert on it.

import { liveIssues } from "../web/lib/issues.js"
import {
  bucketOf,
  buildBuckets,
  cycleLengthMs,
  cyclesBetween,
  dependencyWaves,
  personCycleCapacity,
} from "../web/lib/planning.js"
import type { Issue, Snapshot } from "@/seed.ts"

type Bucket = { key: string; label: string; kind: string; sub?: string }

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

// Heat fills by load-over-capacity ratio, matching web/app.js cellHTML thresholds.
const HEAT_OK = "rgba(22,163,74,.09)"
const HEAT_WARN = "rgba(217,119,6,.13)"
const HEAT_OVER = "rgba(220,38,38,.16)"

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function heatFill(load: number, capacity: number | null): string | null {
  if (!capacity || load <= 0) return null
  const ratio = load / capacity
  if (ratio <= 0.8) return HEAT_OK
  if (ratio <= 1.05) return HEAT_WARN
  return HEAT_OVER
}

// Effective points a person can deliver in a bucket. Cycles carry on-call and time-off deflation,
// milestones size off base velocity across their weeks. Null means capacity does not apply here.
function cellCapacity(
  person: string,
  b: Bucket,
  snapshot: Snapshot,
  bucketWeeks: Record<string, number>,
): number | null {
  if (person === "Unassigned" || b.sub === "past" || b.kind === "backlog") return null
  if (b.kind === "cycle") {
    return personCycleCapacity(person, parseInt(b.key.slice(1), 10), snapshot.capacity).points
  }
  const base = personCycleCapacity(person, null, snapshot.capacity).base
  return Math.round(base * (bucketWeeks[b.key] ?? 0))
}

function milestoneWeeks(snapshot: Snapshot): Record<string, number> {
  const cycleMs = cycleLengthMs(snapshot)
  const weeks: Record<string, number> = {}
  snapshot.milestones.forEach((m, idx) => {
    const prior = idx === 0 ? snapshot.asOf : snapshot.milestones[idx - 1].target
    const start = new Date(snapshot.asOf) > new Date(prior) ? snapshot.asOf : prior
    weeks[m.key] = Math.max(0.5, cyclesBetween(start, m.target, cycleMs))
  })
  return weeks
}

// Board people in the same order the web board uses: Unassigned last, then alphabetical.
function boardPeople(issues: Issue[]): string[] {
  return [...new Set(issues.map((i) => i.assignee))].sort((a, b) =>
    (Number(a === "Unassigned") - Number(b === "Unassigned")) || a.localeCompare(b)
  )
}

export function boardSvg(snapshot: Snapshot): string {
  const issues = liveIssues(snapshot.issues) as Issue[]
  const buckets = buildBuckets(snapshot) as Bucket[]
  const bucketWeeks = milestoneWeeks(snapshot)
  const people = boardPeople(issues)

  const nameW = 160
  const colW = 96
  const rowH = 40
  const headH = 44
  const titleH = 56
  const width = nameW + buckets.length * colW
  const gridTop = titleH + headH
  const height = gridTop + people.length * rowH + 16

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">`,
  )
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`)
  parts.push(
    `<text x="16" y="26" font-size="18" font-weight="700" fill="#111827">${esc(snapshot.project.name)}</text>`,
  )
  parts.push(
    `<text x="16" y="46" font-size="12" fill="#6b7280">Planning board as of ${esc(snapshot.asOf)}</text>`,
  )

  parts.push(
    `<text x="16" y="${titleH + 28}" font-size="12" font-weight="600" fill="#374151">Assignee</text>`,
  )
  buckets.forEach((b, ci) => {
    const cx = nameW + ci * colW + colW / 2
    parts.push(
      `<text x="${cx}" y="${titleH + 28}" font-size="12" font-weight="600" fill="#374151" text-anchor="middle">${
        esc(b.label)
      }</text>`,
    )
  })

  people.forEach((person, ri) => {
    const y = gridTop + ri * rowH
    parts.push(
      `<text x="16" y="${y + rowH / 2 + 4}" font-size="13" fill="#111827">${esc(person)}</text>`,
    )
    buckets.forEach((b, ci) => {
      const x = nameW + ci * colW
      const load = issues
        .filter((i) => i.assignee === person && bucketOf(i) === b.key)
        .reduce((sum, i) => sum + (i.estimate || 0), 0)
      const capacity = cellCapacity(person, b, snapshot, bucketWeeks)
      const fill = heatFill(load, capacity)
      if (fill) {
        parts.push(`<rect x="${x + 1}" y="${y + 1}" width="${colW - 2}" height="${rowH - 2}" fill="${fill}"/>`)
      }
      parts.push(
        `<rect x="${x}" y="${y}" width="${colW}" height="${rowH}" fill="none" stroke="#e5e7eb" stroke-width="1"/>`,
      )
      const label = capacity == null ? String(load) : `${load}/${capacity}`
      parts.push(
        `<text x="${x + colW / 2}" y="${y + rowH / 2 + 4}" font-size="12" fill="#374151" text-anchor="middle">${
          esc(label)
        }</text>`,
      )
    })
  })

  parts.push(`</svg>`)
  return parts.join("\n")
}

export function timelineSvg(snapshot: Snapshot): string {
  const issues = liveIssues(snapshot.issues) as Issue[]
  const byId = Object.fromEntries(issues.map((i) => [i.id, i]))
  const waves = dependencyWaves(issues) as string[][]

  const colW = 200
  const gap = 16
  const cardH = 62
  const cardGap = 10
  const top = 56
  const leftPad = 16
  const width = leftPad * 2 + Math.max(1, waves.length) * colW + Math.max(0, waves.length - 1) * gap
  const maxCards = waves.reduce((m, w) => Math.max(m, w.length), 0)
  const height = top + Math.max(1, maxCards) * (cardH + cardGap) + 16

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">`,
  )
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`)
  parts.push(
    `<text x="16" y="26" font-size="18" font-weight="700" fill="#111827">${esc(snapshot.project.name)}</text>`,
  )
  parts.push(
    `<text x="16" y="46" font-size="12" fill="#6b7280">Dependency timeline as of ${esc(snapshot.asOf)}</text>`,
  )

  waves.forEach((ids, wi) => {
    const x = leftPad + wi * (colW + gap)
    parts.push(
      `<text x="${x}" y="${top - 8}" font-size="12" font-weight="600" fill="#374151">Wave ${wi + 1}</text>`,
    )
    ids.forEach((id, ki) => {
      const issue = byId[id]
      const y = top + ki * (cardH + cardGap)
      parts.push(
        `<rect x="${x}" y="${y}" width="${colW}" height="${cardH}" rx="6" fill="#f9fafb" stroke="#d1d5db" stroke-width="1"/>`,
      )
      parts.push(
        `<text x="${x + 12}" y="${y + 20}" font-size="13" font-weight="700" fill="#111827">${esc(id)}</text>`,
      )
      parts.push(
        `<text x="${x + 12}" y="${y + 38}" font-size="11" fill="#6b7280">${
          esc(issue?.milestone ?? "no milestone")
        }</text>`,
      )
      parts.push(
        `<text x="${x + 12}" y="${y + 54}" font-size="11" fill="#374151">${
          esc(issue?.assignee ?? "Unassigned")
        }</text>`,
      )
    })
  })

  parts.push(`</svg>`)
  return parts.join("\n")
}
