// Deterministic synthetic project data, so Phase 1 (diff, review) and the CLI can run end-to-end
// without a real Linear workspace. generateSnapshots() returns two dated captures of the same
// project: `a` is earlier, `b` is `a` plus a week of realistic drift (scope slips, status moves,
// re-estimates, a new issue, a cancellation, a shifted milestone target). Diffing a against b gives
// the review path something real to show. The generator is seeded, so the output is stable across
// runs and safe to assert on in tests.
//
// Shape matches web/data-sample.json (the board and web/lib/planning.js read it directly), plus the
// blocks/blockedBy/related edges the timeline and chain-risk checks need.

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
  // The Linear team key ("DEV") whose workflow states and estimate scale govern this issue. Absent in
  // offline seed data and in captures taken before ingest recorded it.
  teamKey?: string | null
  labels: string[]
  parentId: string | null
  milestone: string | null
  cycle: number | null
  description: string
  blocks: string[]
  blockedBy: string[]
  related: string[]
}

export type WorkflowStateOption = { id: string; name: string; type: string; position: number }

export type TeamEstimation = { type: string; allowZero: boolean; extended: boolean }

// One Linear team the project touches, with the workflow states and estimate scale that team uses.
// Ingest captures these so the editor can offer a team's real states by name rather than one state
// per category, and its real estimate values rather than a free-text number.
export type ProjectTeam = {
  id: string
  key: string
  name: string
  estimation: TeamEstimation
  states: WorkflowStateOption[]
}

export type Snapshot = {
  // id and slugId come from a real Linear ingest (scripts/issues.ts) and key the snapshot history in
  // src/projectIdentity.ts. Offline seed data has neither. workspaceKey is the Linear workspace the
  // project lives in, so a scheduled run under one key can tell a project it cannot see from one that
  // was renamed or revoked (src/workspace.ts).
  project: {
    id?: string
    name: string
    slugId?: string
    start: string
    target: string
    url: string
    workspaceKey?: string | null
  }
  teams?: ProjectTeam[]
  // Every estimate value any of the project's teams allows. Null when no team estimates.
  estimateScale?: number[] | null
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
// mixed with clean ones, so `tlr scan` and the board's slop filter have signal. Same fictional "Horse
// Tinder" theme as scripts/seed-linear.ts's live-workspace fixture, so every demo/test surface tells
// one obviously-fake story instead of two, and neither reads like real internal project data.
const SLOP_DESC =
  "This ticket will comprehensively leverage a robust, seamless approach to delight our equine users; it delves into the core.\n- [ ] step one\n- [ ] step two"
const CLEAN_DESC = "Score candidates on breed compatibility, temperament, and shared disciplines."

const MILESTONES = [
  { key: "M1", name: "M1: Matchmaking engine", target: "2026-07-31", progress: 55 },
  { key: "M2", name: "M2: Stable profiles", target: "2026-08-31", progress: 20 },
  { key: "M3", name: "M3: Neigh-bors chat", target: "2026-09-30", progress: 5 },
  { key: "M4", name: "M4: Trust and safety", target: "2026-10-31", progress: 0 },
]

// Two cycles past the current one, because a real project always has upcoming weeks planned and
// anything that schedules forward (balance) has nowhere to put work without them. Two-week spans,
// matching the real TLR team's configured cycle length (see scripts/configure-linear-team.ts).
const CYCLES = [
  { n: 47, start: "2026-06-29", end: "2026-07-13" },
  { n: 48, start: "2026-07-13", end: "2026-07-27" },
  { n: 49, start: "2026-07-27", end: "2026-08-10" },
  { n: 50, start: "2026-08-10", end: "2026-08-24" },
  { n: 51, start: "2026-08-24", end: "2026-09-07" },
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
  // A small blocking chain, plus a second one deliberately built to miss its milestone so chainRisks()
  // has something to flag: three tickets on one owner, 39 points of sequential work against M1's target
  // a week and a bit out. One person cannot deliver that however free the rest of the team is, which is
  // the whole point of measuring a chain against its owners rather than team throughput.
  link(issues, "SEED-103", "SEED-101")
  link(issues, "SEED-104", "SEED-103")
  link(issues, "SEED-102", "SEED-120")
  for (const id of ["SEED-125", "SEED-126", "SEED-127"]) {
    const i = issues.find((x) => x.id === id)!
    i.assignee = PEOPLE[0]
    i.milestone = "M1"
    i.title = `M1 work item ${id.slice(5)}`
    i.estimate = 13
    i.status = STATUS_LABEL.unstarted
    i.statusType = "unstarted"
  }
  link(issues, "SEED-126", "SEED-125")
  link(issues, "SEED-127", "SEED-126")
  issues.find((i) => i.id === "SEED-101")!.related.push("SEED-105")

  // One issue forced into triage (rather than widening the random STATUSES pool, which would reshuffle
  // every later RNG draw and perturb every other issue's fixture values) so the triage status type,
  // otherwise only ever asserted in the abstract via STATUS_RANK, has one real instance to exercise.
  const triageIssue = issues.find((i) => i.id === "SEED-110")!
  triageIssue.statusType = "triage"
  triageIssue.status = STATUS_LABEL.triage

  return {
    project: {
      name: "Horse Tinder (seed)",
      start: "2026-07-01",
      target: "2026-11-30",
      url: "https://linear.app/seed",
    },
    teams: [{
      id: "team-tlr",
      key: "TLR",
      name: "Horse Tinder",
      estimation: { type: "fibonacci", allowZero: true, extended: false },
      states: [
        { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
        { id: "st-triage", name: "Triage", type: "triage", position: 1 },
        { id: "st-todo", name: "Todo", type: "unstarted", position: 2 },
        { id: "st-progress", name: "In Progress", type: "started", position: 3 },
        { id: "st-done", name: "Done", type: "completed", position: 4 },
        { id: "st-canceled", name: "Canceled", type: "canceled", position: 5 },
      ],
    }],
    // The project-wide/ingest-time fallback scale (see projectEstimateScale in web/lib/issues.js),
    // deliberately wider than the TLR team's own live fibonacci scale so stale/extended-value code
    // paths in web/lib/fieldOptions.js have real values above 8 to resolve against.
    estimateScale: [0, 1, 2, 3, 5, 8, 13, 21],
    cycles: CYCLES,
    asOf: "2026-07-23",
    currentCycle: 48,
    teamCapacityPerCycle: 80,
    teamVelocity: 72,
    milestones: MILESTONES.map((m) => ({ ...m })),
    issues,
    capacity: {
      config: { workdaysPerCycle: 10, oncallPenalty: 0.45 },
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
  b.currentCycle = 49 // On-call rotates forward with the cycle, so the now-current cycle (49) still has a live rotation to
   // show and edit, the same way `a`'s cycle 48 does. Cycle 48's own entry is left untouched: it is now
  // history, not a live rotation.
  ;(b.capacity.people["Grace Hopper"] ??= {}).cycles = {
    ...b.capacity.people["Grace Hopper"].cycles,
    "49": { oncall: true, oncallSrc: "seed" },
  }

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
