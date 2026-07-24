// Deterministic synthetic project data, so Phase 1 (diff, review) and the CLI can run end-to-end
// without a real Linear workspace. generateSnapshots() returns two dated captures of the same
// project: `a` is earlier, `b` is `a` plus a week of realistic drift (scope slips, status moves,
// re-estimates, a new issue, a cancellation, a shifted milestone target). Diffing a against b gives
// the review path something real to show. The generator is seeded, so the output is stable across
// runs and safe to assert on in tests.
//
// Shape matches web/data-sample.json (the board and web/lib/planning.js read it directly), plus the
// blocks/blockedBy/related edges the timeline and ordering-risk checks need.

export type Issue = {
  id: string
  // Linear's internal UUID, captured only on a real ingest. Absent in offline seed data. A write
  // needs it because issueUpdate keys on the UUID, not the human identifier held in `id`.
  linearId?: string
  title: string
  url: string
  estimate: number
  assignee: string
  status: string
  statusType: "started" | "unstarted" | "triage" | "backlog" | "completed" | "canceled"
  priority: string | null
  priorityValue: number | null
  labels: string[]
  parentId: string | null
  milestone: string | null
  cycle: number | null
  description: string
  blocks: string[]
  blockedBy: string[]
  related: string[]
}

export type Snapshot = {
  project: { name: string; start: string; target: string; url: string }
  cycles: { n: number; start: string; end: string }[]
  asOf: string
  currentCycle: number
  teamCapacityPerCycle: number
  teamVelocity: number
  milestones: { key: string; name: string; target: string; progress: number }[]
  issues: Issue[]
  capacity: {
    config: { workdaysPerCycle: number; oncallPenalty: number }
    defaultVelocity: number
    roster: Record<string, { email: string }>
    people: Record<string, { velocity?: number; cycles?: Record<string, CycleEvent> }>
  }
}

type CycleEvent = {
  oncall?: boolean
  outDays?: number
  reason?: string
  locked?: boolean
  oncallSrc?: string
  outSrc?: string
}

// mulberry32: a tiny seeded PRNG so fixtures are reproducible without Math.random.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PEOPLE = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson", "Unassigned"]
const PRIORITY = [
  { value: 0, label: null },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
]
const STATUSES: Issue["statusType"][] = ["backlog", "unstarted", "started", "completed"]
const STATUS_LABEL: Record<Issue["statusType"], string> = {
  backlog: "Backlog",
  unstarted: "Todo",
  triage: "Triage",
  started: "In Progress",
  completed: "Done",
  canceled: "Canceled",
}

// A few descriptions written to trip the slop scan (dashes, semicolons, checklist, stock phrases),
// mixed with clean ones, so `tlr scan` and the board's slop filter have signal.
const SLOP_DESC =
  "This ticket will comprehensively leverage a robust, seamless approach; it delves into the core.\n- [ ] step one\n- [ ] step two"
const CLEAN_DESC = "Add a p99 latency panel to the reliability dashboard and alert when it exceeds 300ms."

const MILESTONES = [
  { key: "M1", name: "M1: Measure and page", target: "2026-07-31", progress: 55 },
  { key: "M2", name: "M2: Synthetics and live status", target: "2026-08-31", progress: 20 },
  { key: "M3", name: "M3: Incident readiness", target: "2026-09-30", progress: 5 },
  { key: "M4", name: "M4: Chaos and game days", target: "2026-10-31", progress: 0 },
]

const CYCLES = [
  { n: 47, start: "2026-07-13", end: "2026-07-20" },
  { n: 48, start: "2026-07-20", end: "2026-07-27" },
  { n: 49, start: "2026-07-27", end: "2026-08-03" },
]

function baseSnapshot(): Snapshot {
  const rand = rng(20260723)
  const issues: Issue[] = []
  const count = 32
  for (let k = 0; k < count; k++) {
    const num = 101 + k
    const id = `SEED-${num}`
    const assignee = PEOPLE[Math.floor(rand() * PEOPLE.length)]
    const st = STATUSES[Math.floor(rand() * STATUSES.length)]
    const pr = PRIORITY[Math.floor(rand() * PRIORITY.length)]
    const mIdx = Math.floor(rand() * MILESTONES.length)
    // early issues land in an active cycle, later ones only carry a milestone
    const cycle = k < 10 ? CYCLES[1 + Math.floor(rand() * 2)].n : null
    const slop = rand() < 0.25
    // a quarter of issues miss an estimate, to exercise the missing-data flag
    const estimate = rand() < 0.25 ? 0 : [1, 2, 3, 5, 8][Math.floor(rand() * 5)]
    issues.push({
      id,
      title: `${MILESTONES[mIdx].key} work item ${num}`,
      url: `https://linear.app/seed/issue/${id}`,
      estimate,
      assignee,
      status: STATUS_LABEL[st],
      statusType: st,
      priority: pr.label,
      priorityValue: pr.value,
      labels: [],
      parentId: null,
      milestone: MILESTONES[mIdx].key,
      cycle,
      description: slop ? SLOP_DESC : CLEAN_DESC,
      blocks: [],
      blockedBy: [],
      related: [],
    })
  }
  // A small blocking chain with one deliberate ordering risk: a blocker in a later milestone than
  // the issue it blocks, so orderingRisks() has something to flag.
  link(issues, "SEED-103", "SEED-101")
  link(issues, "SEED-104", "SEED-103")
  link(issues, "SEED-102", "SEED-120") // 120 sits in a later milestone -> ordering risk
  issues.find((i) => i.id === "SEED-101")!.related.push("SEED-105")

  return {
    project: {
      name: "Seeded Reliability Program",
      start: "2026-07-01",
      target: "2026-11-30",
      url: "https://linear.app/seed",
    },
    cycles: CYCLES,
    asOf: "2026-07-23",
    currentCycle: 48,
    teamCapacityPerCycle: 80,
    teamVelocity: 72,
    milestones: MILESTONES.map((m) => ({ ...m })),
    issues,
    capacity: {
      config: { workdaysPerCycle: 5, oncallPenalty: 0.45 },
      defaultVelocity: 20,
      roster: {
        "Ada Lovelace": { email: "ada@example.com" },
        "Grace Hopper": { email: "grace@example.com" },
        "Alan Turing": { email: "alan@example.com" },
        "Katherine Johnson": { email: "katherine@example.com" },
      },
      people: {
        "Grace Hopper": { cycles: { "48": { oncall: true, oncallSrc: "seed" } } },
        "Alan Turing": { cycles: { "49": { outDays: 2, reason: "PTO", outSrc: "seed" } } },
        "Katherine Johnson": { velocity: 15 },
      },
    },
  }
}

// `from` is blocked by `to`; store both directions the way the ingest does.
function link(issues: Issue[], fromId: string, toId: string) {
  const from = issues.find((i) => i.id === fromId)
  const to = issues.find((i) => i.id === toId)
  if (!from || !to) return
  from.blockedBy.push(toId)
  to.blocks.push(fromId)
}

// A week of drift applied to a deep copy of `a`: some in-progress work completes, two issues slip to
// a later milestone, a few are re-estimated, one is canceled, two are added, and M2's target moves
// out. Everything a plan-level diff and a review queue should surface.
function drift(a: Snapshot): Snapshot {
  const b: Snapshot = structuredClone(a)
  b.asOf = "2026-07-30"
  b.currentCycle = 49

  const byId = Object.fromEntries(b.issues.map((i) => [i.id, i]))
  const advance = (id: string) => {
    const i = byId[id]
    if (!i) return
    const order: Issue["statusType"][] = ["backlog", "unstarted", "started", "completed"]
    const idx = order.indexOf(i.statusType)
    if (idx >= 0 && idx < order.length - 1) {
      i.statusType = order[idx + 1]
      i.status = STATUS_LABEL[i.statusType]
    }
  }
  ;["SEED-101", "SEED-103", "SEED-106", "SEED-108", "SEED-111"].forEach(advance)

  // scope slip: two issues move to a later milestone
  if (byId["SEED-105"]) byId["SEED-105"].milestone = "M2"
  if (byId["SEED-112"]) byId["SEED-112"].milestone = "M3"

  // re-estimates
  if (byId["SEED-107"]) byId["SEED-107"].estimate = 8
  if (byId["SEED-109"]) byId["SEED-109"].estimate = 1

  // a cancellation
  if (byId["SEED-115"]) {
    byId["SEED-115"].statusType = "canceled"
    byId["SEED-115"].status = "Canceled"
  }

  // priority bump
  if (byId["SEED-102"]) {
    byId["SEED-102"].priority = "Urgent"
    byId["SEED-102"].priorityValue = 1
  }

  // milestone target slips
  const m2 = b.milestones.find((m) => m.key === "M2")
  if (m2) m2.target = "2026-09-15"

  // two new issues added into the current cycle
  b.issues.push({
    id: "SEED-133",
    title: "M2 work item 133",
    url: "https://linear.app/seed/issue/SEED-133",
    estimate: 3,
    assignee: "Ada Lovelace",
    status: STATUS_LABEL.unstarted,
    statusType: "unstarted",
    priority: "High",
    priorityValue: 2,
    labels: [],
    parentId: null,
    milestone: "M2",
    cycle: 49,
    description: CLEAN_DESC,
    blocks: [],
    blockedBy: [],
    related: [],
  })
  b.issues.push({
    id: "SEED-134",
    title: "M1 work item 134",
    url: "https://linear.app/seed/issue/SEED-134",
    estimate: 0,
    assignee: "Unassigned",
    status: STATUS_LABEL.backlog,
    statusType: "backlog",
    priority: null,
    priorityValue: 0,
    labels: [],
    parentId: null,
    milestone: "M1",
    cycle: 49,
    description: SLOP_DESC,
    blocks: [],
    blockedBy: [],
    related: [],
  })

  return b
}

export function generateSnapshots(): { a: Snapshot; b: Snapshot } {
  const a = baseSnapshot()
  return { a, b: drift(a) }
}
