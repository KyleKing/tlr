// Weekly-update report ("report backward"): turn a plan-level diff into the narrative a status update
// needs, split into shipped, moved, and at-risk. Pure, no I/O. weeklyReport() returns structured
// data; renderReport() turns it into markdown for pasting into an update. Input is a SnapshotDiff, so
// the report always reflects a real before/after, never a guess.

import type { MilestoneDiff, SnapshotDiff } from "@/diff.ts"

export type ReportItem = { id: string; milestone: string }

export type MilestoneMove = {
  key: string
  name: string
  targetSlipDays: number | null
  pointsDelta: number
  in: string[]
  out: string[]
}

export type WeeklyReport = {
  window: { from: string; to: string }
  shipped: ReportItem[]
  moved: MilestoneMove[]
  atRisk: MilestoneMove[]
  added: string[]
  removed: string[]
  totals: { pointsDelta: number; issueCountDelta: number }
}

function moved(m: MilestoneDiff): boolean {
  return (m.targetSlipDays ?? 0) !== 0 || m.issuesIn.length > 0 || m.issuesOut.length > 0
}

function atRisk(m: MilestoneDiff): boolean {
  return (m.targetSlipDays ?? 0) > 0 || m.pointsDelta > 0
}

function toMove(m: MilestoneDiff): MilestoneMove {
  return {
    key: m.key,
    name: m.name,
    targetSlipDays: m.targetSlipDays,
    pointsDelta: m.pointsDelta,
    in: m.issuesIn,
    out: m.issuesOut,
  }
}

export function weeklyReport(diff: SnapshotDiff): WeeklyReport {
  const shipped: ReportItem[] = []
  for (const m of diff.milestones) {
    for (const id of m.completed) shipped.push({ id, milestone: m.key })
  }
  shipped.sort((a, b) => a.id.localeCompare(b.id))

  return {
    window: { from: diff.project.asOfBefore, to: diff.project.asOfAfter },
    shipped,
    moved: diff.milestones.filter(moved).map(toMove),
    atRisk: diff.milestones.filter(atRisk).map(toMove),
    added: diff.issues.added,
    removed: diff.issues.removed,
    totals: {
      pointsDelta: diff.project.pointsDelta,
      issueCountDelta: diff.project.issueCountDelta,
    },
  }
}

function slipPhrase(days: number | null): string {
  if (!days) return ""
  return days > 0 ? ` (target slipped ${days}d)` : ` (target pulled in ${-days}d)`
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

// Two captures from the same day carry the same asOf date, and "2026-07-24 to 2026-07-24" reads as a
// bug rather than as a window shorter than a day. The window is only ever as precise as asOf.
function windowPhrase(window: WeeklyReport["window"]): string {
  return window.from === window.to ? window.from : `${window.from} to ${window.to}`
}

export function renderReport(report: WeeklyReport): string {
  const lines: string[] = []
  lines.push(`# Weekly update: ${windowPhrase(report.window)}`)
  lines.push("")

  lines.push("## Shipped")
  if (report.shipped.length === 0) lines.push("- Nothing marked complete this window.")
  else for (const s of report.shipped) lines.push(`- ${s.id} (${s.milestone})`)
  lines.push("")

  lines.push("## Moved")
  if (report.moved.length === 0) lines.push("- No milestone scope or target changed.")
  else {
    for (const m of report.moved) {
      const parts: string[] = []
      if (m.in.length) parts.push(`+${m.in.length} in`)
      if (m.out.length) parts.push(`-${m.out.length} out`)
      if (m.pointsDelta) parts.push(`${signed(m.pointsDelta)} pts`)
      const detail = parts.length ? ` — ${parts.join(", ")}` : ""
      lines.push(`- ${m.name}${slipPhrase(m.targetSlipDays)}${detail}`)
    }
  }
  lines.push("")

  lines.push("## At risk")
  if (report.atRisk.length === 0) lines.push("- No milestone is trending late from this diff.")
  else {
    for (const m of report.atRisk) {
      const why = (m.targetSlipDays ?? 0) > 0
        ? `target slipped ${m.targetSlipDays}d`
        : `scope grew ${signed(m.pointsDelta)} pts`
      lines.push(`- ${m.name} — ${why}`)
    }
  }
  lines.push("")

  const net: string[] = []
  if (report.added.length) net.push(`${report.added.length} added`)
  if (report.removed.length) net.push(`${report.removed.length} removed`)
  net.push(`${signed(report.totals.pointsDelta)} pts net`)
  lines.push(`_Scope: ${net.join(", ")}._`)

  return lines.join("\n")
}
