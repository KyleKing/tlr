// What the pending edit would do to the plan, as data. No DOM, no fetch, no write: the pending change
// is simulated in memory through web/lib/whatif.js, whose overlays never touch the stored snapshot, so
// asking "what would this cost" can never cost anything. web/lib/editImpact.js is the renderer over
// this; everything decided here is decided once and unit-tested without a browser.
//
// The result splits along the two speeds the modal changes at. `scopeImpact` (load, forecast,
// dependencies) only moves when assignee, cycle, estimate, or milestone move, and `impactKey` is the
// signature a caller memoizes it on. `textImpact` follows the description keystroke by keystroke and
// costs one regex sweep.

import { liveSnapshot } from "./issues.js"
import { bucketOf, buildBuckets, chainRisks, personCycleCapacity, slopScan } from "./planning.js"
import { whatIfPlan } from "./whatif.js"

const FAR_FUTURE = "9999-12-31"

function normalizeSnapshot(snapshot) {
  return {
    ...snapshot,
    asOf: snapshot?.asOf ?? new Date().toISOString().slice(0, 10),
    capacity: snapshot?.capacity ?? {},
    cycles: snapshot?.cycles ?? [],
    issues: snapshot?.issues ?? [],
    milestones: snapshot?.milestones ?? [],
  }
}

/**
 * The fields of the pending edit that move the plan, as a what-if scope patch. A blank estimate means
 * "leave it alone" (see editRules), so it never becomes a patch.
 */
export function scopePatch(issue, values) {
  const current = {
    assignee: issue?.assignee || "Unassigned",
    cycle: issue?.cycle ?? null,
    estimate: issue?.estimate ?? null,
    milestone: issue?.milestone ?? null,
  }
  const next = {
    assignee: values?.assignee || "Unassigned",
    cycle: values?.cycle ?? null,
    estimate: typeof values?.estimate === "number" ? values.estimate : current.estimate,
    milestone: values?.milestone ?? null,
  }
  return Object.fromEntries(Object.entries(next).filter(([field, value]) => value !== current[field]))
}

/** A signature of everything scopeImpact reads off the form, for a caller that caches the heavy half. */
export function impactKey(ctx) {
  return JSON.stringify([ctx?.issue?.id ?? null, scopePatch(ctx?.issue, ctx?.values)])
}

function loadIn(issues, person, cycle) {
  return issues
    .filter((i) => (i.assignee || "Unassigned") === person && i.cycle === cycle)
    .reduce((sum, i) => sum + (i.estimate || 0), 0)
}

// The person/cycle cells this edit moves work between: the one it lands in first, then the one it
// leaves, skipping a cell with no cycle (there is no per-cycle load to report for unscheduled work).
function touchedCells(issue, patch) {
  const before = { person: issue?.assignee || "Unassigned", cycle: issue?.cycle ?? null }
  const after = {
    person: patch.assignee ?? before.person,
    cycle: "cycle" in patch ? patch.cycle : before.cycle,
  }
  const cells = []
  for (const cell of [after, before]) {
    if (cell.cycle == null) continue
    if (cells.some((c) => c.person === cell.person && c.cycle === cell.cycle)) continue
    cells.push(cell)
  }
  return cells
}

function cellLoad(baseline, simulated, cell) {
  const before = loadIn(baseline.issues, cell.person, cell.cycle)
  const after = loadIn(simulated.issues, cell.person, cell.cycle)
  const capacity = cell.person === "Unassigned"
    ? null
    : personCycleCapacity(cell.person, cell.cycle, simulated.capacity).points
  return { ...cell, before, after, capacity, over: capacity != null && after > capacity }
}

function bucketEndLookup(snapshot) {
  const ends = Object.fromEntries(buildBuckets(snapshot, snapshot.issues).map((b) => [b.key, b.end]))
  return (issue) => ends[bucketOf(issue)] ?? FAR_FUTURE
}

// The chain this ticket sits in, or null when it has no blocking edges. Only the fields the pane draws.
function chainFor(snapshot, id) {
  const chain = chainRisks(snapshot).find((c) => c.ids.includes(id))
  if (!chain) return null
  return {
    size: chain.ids.length,
    points: chain.points,
    cyclesNeeded: chain.cyclesNeeded,
    cyclesAvailable: chain.cyclesAvailable,
    shortfall: chain.shortfall,
    stalled: chain.stalled,
    atRisk: chain.atRisk,
    target: chain.target,
    owners: chain.owners,
    spans: chain.spans,
  }
}

// The ticket's blockers and what it blocks, each with the date its bucket ends under the pending plan,
// plus the chain it belongs to. `chainWas` is the same chain before the edit, so the pane can say
// whether this move stretched the chain past its milestone or pulled it back inside.
function dependenciesOf(snapshot, baseline, id) {
  const byId = new Map(snapshot.issues.map((i) => [i.id, i]))
  const issue = byId.get(id)
  if (!issue) return { blockedBy: [], blocks: [], chain: null, chainWas: null }
  const endOf = bucketEndLookup(snapshot)
  const chain = chainFor(snapshot, id)
  const onRiskyChain = Boolean(chain?.atRisk)
  const row = (other) => ({
    id: other.id,
    title: other.title ?? other.id,
    statusType: other.statusType ?? null,
    lands: endOf(other),
    risk: onRiskyChain,
  })
  return {
    blockedBy: (issue.blockedBy ?? []).map((n) => byId.get(n)).filter(Boolean).map(row),
    blocks: (issue.blocks ?? []).map((n) => byId.get(n)).filter(Boolean).map(row),
    chain,
    chainWas: chainFor(baseline, id),
  }
}

/** Per-person load and the milestone forecast under the pending edit, against the plan as it stands. */
export function scopeImpact(ctx) {
  const issue = ctx?.issue ?? {}
  const snapshot = normalizeSnapshot(ctx?.snapshot)
  const patch = scopePatch(issue, ctx?.values)
  const overlays = Object.keys(patch).length && issue.id ? [{ kind: "scope", id: issue.id, patch }] : []
  const plan = whatIfPlan(snapshot, overlays)
  const baseline = liveSnapshot(snapshot)
  return {
    patch,
    cells: overlays.length ? touchedCells(issue, patch).map((cell) => cellLoad(baseline, plan.snapshot, cell)) : [],
    forecast: plan.milestones
      .filter((m) => m.shiftDays !== 0)
      .map((m) => ({
        key: m.key,
        name: m.name ?? m.key,
        baselineLanding: m.baselineLanding,
        landing: m.landing,
        shiftDays: m.shiftDays,
      })),
    dependencies: dependenciesOf(plan.snapshot, baseline, issue.id),
  }
}

/** The slop scan before and after the rewrite, or null while the description is untouched. */
export function textImpact(ctx) {
  const before = ctx?.issue?.description ?? ""
  const after = ctx?.values?.description ?? ""
  if (before === after) return null
  const was = slopScan(before)
  const now = slopScan(after)
  const verdict = now.score < was.score ? "cleaner" : now.score > was.score ? "worse" : "unchanged"
  return { was, now, verdict }
}

/** What the current review window already recorded about this ticket. Empty anywhere but Review. */
export function reviewImpact(ctx) {
  if (ctx?.source !== "review") return []
  return (ctx?.reviewItems ?? []).map((item) => ({
    kind: item.kind,
    summary: item.summary,
    from: item.detail?.from ?? null,
    to: item.detail?.to ?? null,
  }))
}

// What the edit did to the chain. A chain already late before the edit is worth saying once; one this
// edit pushed past its target, or pulled back inside it, is the thing the pane exists to catch.
function chainWarnings({ chain, chainWas }) {
  if (!chain) return []
  if (chain.stalled) return [`This ticket sits in a ${chain.size}-ticket chain with an owner who has no capacity`]
  if (chain.atRisk) {
    const became = chainWas && !chainWas.atRisk ? "This edit pushes" : "This ticket sits in"
    return [
      `${became} a ${chain.size}-ticket chain needing ${chain.cyclesNeeded} cycles with ` +
      `${chain.cyclesAvailable} left before ${chain.target}`,
    ]
  }
  if (chainWas?.atRisk) {
    return [`This edit brings its ${chain.size}-ticket chain back inside ${chain.target}`]
  }
  return []
}

function warningsFor(scope, text) {
  const warnings = []
  for (const cell of scope.cells) {
    if (cell.over) {
      warnings.push(`${cell.person} is over capacity in cycle ${cell.cycle}: ${cell.after} of ${cell.capacity} points`)
    }
  }
  for (const m of scope.forecast) {
    if (m.shiftDays > 0) warnings.push(`${m.name} lands ${m.shiftDays} day${m.shiftDays === 1 ? "" : "s"} later`)
  }
  warnings.push(...chainWarnings(scope.dependencies))
  if (text?.verdict === "worse") warnings.push("The rewritten description scores worse on the slop scan")
  return warnings
}

/**
 * Everything the impact pane draws, for one pending edit. Pure. Pass `scope` to reuse a scopeImpact()
 * a caller already memoized (see impactKey); leave it out and it is computed here.
 */
export function impactOf(ctx, scope = scopeImpact(ctx)) {
  const text = textImpact(ctx)
  return {
    changed: (ctx?.changed ?? []).map((c) => c.label),
    review: reviewImpact(ctx),
    scope,
    text,
    warnings: warningsFor(scope, text),
  }
}
