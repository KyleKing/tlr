// Milestone slip forecast: a realistic landing date per milestone, labeled as a forecast, never a
// real date. Pure, no I/O, no clock. Model: milestones deliver in target-date order, each starting
// when the one before it finishes (or the snapshot's asOf, whichever is later). A milestone's weeks
// of work is its remaining (not-yet-completed) points divided by the team's weekly throughput, where
// throughput sums each rostered person's base velocity per one-week cycle. The result is compared to
// the stated target to give a slip in days.

import { personCycleCapacity } from "../web/lib/planning.js"
import type { Issue, Snapshot } from "@/seed.ts"

export type MilestoneForecast = {
  key: string
  name: string
  target: string
  remainingPoints: number
  completedPoints: number
  weeksNeeded: number
  landing: string
  slipDays: number
  status: "ahead" | "on-track" | "at-risk"
}

export type Forecast = {
  asOf: string
  teamWeeklyPoints: number
  milestones: MilestoneForecast[]
}

const DAY_MS = 24 * 3600 * 1000
const WEEK_MS = 7 * DAY_MS

// Points still to deliver in a milestone: open work only. Canceled work is dropped, not counted as
// remaining or completed.
function remainingIn(issues: Issue[], key: string): number {
  return issues
    .filter((i) => i.milestone === key && i.statusType !== "completed" && i.statusType !== "canceled")
    .reduce((sum, i) => sum + (i.estimate || 0), 0)
}

function completedIn(issues: Issue[], key: string): number {
  return issues
    .filter((i) => i.milestone === key && i.statusType === "completed")
    .reduce((sum, i) => sum + (i.estimate || 0), 0)
}

// Team throughput in points per one-week cycle: each rostered person's base velocity. Base, not the
// on-call/PTO-deflated per-cycle number, because a milestone window spans many cycles and averages out.
function teamWeekly(snapshot: Snapshot): number {
  const roster = Object.keys(snapshot.capacity?.roster ?? {})
  const people = roster.length
    ? roster
    : [...new Set(snapshot.issues.map((i) => i.assignee))].filter((p) => p !== "Unassigned")
  return people.reduce((sum, p) => sum + personCycleCapacity(p, null, snapshot.capacity).base, 0)
}

function addWeeks(fromISO: string, weeks: number): string {
  return new Date(new Date(fromISO).getTime() + weeks * WEEK_MS).toISOString().slice(0, 10)
}

function classify(slipDays: number): MilestoneForecast["status"] {
  if (slipDays <= -3) return "ahead"
  if (slipDays <= 3) return "on-track"
  return "at-risk"
}

export function milestoneForecast(snapshot: Snapshot): Forecast {
  const weekly = teamWeekly(snapshot)
  const ordered = [...snapshot.milestones].sort((a, b) => a.target.localeCompare(b.target))

  let cursor = snapshot.asOf
  const milestones: MilestoneForecast[] = ordered.map((m) => {
    const remainingPoints = remainingIn(snapshot.issues, m.key)
    const completedPoints = completedIn(snapshot.issues, m.key)
    const weeksNeeded = weekly > 0 ? remainingPoints / weekly : 0
    const start = new Date(cursor) > new Date(snapshot.asOf) ? cursor : snapshot.asOf
    const landing = addWeeks(start, weeksNeeded)
    cursor = landing
    const slipDays = Math.round((new Date(landing).getTime() - new Date(m.target).getTime()) / DAY_MS)
    return {
      key: m.key,
      name: m.name,
      target: m.target,
      remainingPoints,
      completedPoints,
      weeksNeeded: Math.round(weeksNeeded * 10) / 10,
      landing,
      slipDays,
      status: classify(slipDays),
    }
  })

  return { asOf: snapshot.asOf, teamWeeklyPoints: weekly, milestones }
}
