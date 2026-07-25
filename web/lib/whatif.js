// What-if planning: overlays layered on a snapshot in memory, and the forecast delta they produce.
// Pure — no DOM, no network — and the input snapshot is never mutated, so the board can simulate a
// PTO week or a scope move and still hold the real data it read from disk.
//
// Two overlay kinds:
//   { kind: "capacity", person, cycle, patch: { oncall, outDays, reason } }
//   { kind: "scope",    id,     patch: { assignee, cycle, milestone } }
// A capacity patch follows setPersonCycle's rule (a null or "" value clears that field), so marking a
// person out and clearing an existing out/on-call entry are the same gesture. Later overlays win over
// earlier ones on the same target, so a stack reads as a sequence of edits.

import { setPersonCycle } from "./config.js"
import { liveIssues, liveSnapshot } from "./issues.js"
import { milestoneForecast, teamWeeklyThroughput } from "./planning.js"

const _DAY_MS = 24 * 3600 * 1000

export function applyOverlays(snapshot, overlays) {
  let capacity = snapshot.capacity ?? {}
  const moves = {}
  for (const ov of overlays ?? []) {
    if (ov.kind === "capacity") capacity = setPersonCycle(capacity, ov.person, ov.cycle, ov.patch)
    else if (ov.kind === "scope") moves[ov.id] = { ...moves[ov.id], ...ov.patch }
    else throw new Error(`unknown what-if overlay: ${ov.kind}`)
  }
  const issues = liveIssues(snapshot.issues).map((i) => (moves[i.id] ? { ...i, ...moves[i.id] } : i))
  return { ...snapshot, capacity, issues }
}

function _shiftDays(fromISO, toISO) {
  return Math.round((new Date(toISO) - new Date(fromISO)) / _DAY_MS)
}

function _forecastOf(snapshot) {
  return milestoneForecast(snapshot, teamWeeklyThroughput(snapshot))
}

// The simulated snapshot plus both forecasts, with a per-milestone delta so a caller can show the
// baseline landing, the what-if landing, and the shift between them rather than only the new number.
// A positive shiftDays means the milestone lands later than it did without the overlays.
// The baseline is forecast from the same live-only issue list the simulation runs on. Reading the raw
// snapshot here instead would price archived work into the baseline and not into the what-if, so every
// shiftDays would report a saving the overlays did not make.
export function whatIfPlan(snapshot, overlays) {
  const simulated = applyOverlays(snapshot, overlays)
  const baseline = _forecastOf(liveSnapshot(snapshot))
  const forecast = _forecastOf(simulated)
  const baselineByKey = Object.fromEntries(baseline.milestones.map((m) => [m.key, m]))
  const milestones = forecast.milestones.map((m) => {
    const was = baselineByKey[m.key]
    return {
      ...m,
      baselineLanding: was ? was.landing : m.landing,
      baselineSlipDays: was ? was.slipDays : m.slipDays,
      shiftDays: was ? _shiftDays(was.landing, m.landing) : 0,
    }
  })
  return { snapshot: simulated, capacity: simulated.capacity, baseline, forecast, milestones }
}
