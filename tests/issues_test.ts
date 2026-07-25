import { assertEquals } from "jsr:@std/assert@1"
import {
  buildCycles,
  buildMilestones,
  buildTeams,
  currentCycleNumber,
  dedupeByDataFile,
  DEFAULT_STATUS_OPTIONS,
  estimateOptions,
  identifierTeamKey,
  isArchivedIssue,
  liveIssues,
  liveSnapshot,
  mergeIngest,
  milestoneKey,
  pickProject,
  priorityLabel,
  projectEstimateScale,
  teamForIssue,
  transformIssue,
  upsertProjectManifest,
  workflowStates,
} from "../web/lib/issues.js"

Deno.test("priorityLabel maps Linear's 0-4 scale, null passes through", () => {
  assertEquals(priorityLabel(0), "No priority")
  assertEquals(priorityLabel(1), "Urgent")
  assertEquals(priorityLabel(2), "High")
  assertEquals(priorityLabel(3), "Medium")
  assertEquals(priorityLabel(4), "Low")
  assertEquals(priorityLabel(null), null)
})

Deno.test("milestoneKey takes the part before the colon", () => {
  assertEquals(milestoneKey("M1: Measure and page"), "M1")
  assertEquals(milestoneKey("No colon here"), "No colon here")
})

Deno.test("buildMilestones maps and sorts by target date", () => {
  const out = buildMilestones([
    { id: "b", name: "M2: Later", targetDate: "2026-08-31", progress: 20 },
    { id: "a", name: "M1: Sooner", targetDate: "2026-07-31", progress: 60 },
  ])
  assertEquals(out, [
    { key: "M1", name: "M1: Sooner", target: "2026-07-31", progress: 60 },
    { key: "M2", name: "M2: Later", target: "2026-08-31", progress: 20 },
  ])
})

Deno.test("buildCycles maps and sorts by cycle number", () => {
  const out = buildCycles([
    { number: 49, startsAt: "2026-07-27T00:00:00.000Z", endsAt: "2026-08-03T00:00:00.000Z" },
    { number: 48, startsAt: "2026-07-20T00:00:00.000Z", endsAt: "2026-07-27T00:00:00.000Z" },
  ])
  assertEquals(out, [
    { n: 48, start: "2026-07-20", end: "2026-07-27" },
    { n: 49, start: "2026-07-27", end: "2026-08-03" },
  ])
})

// Regression: a project spanning multiple Linear teams pools each team's cycles(), and cycle numbers
// are only unique within a team — two teams can both have a "cycle 48" with different date windows.
Deno.test("buildCycles dedupes cycle numbers that collide across pooled teams", () => {
  const out = buildCycles([
    { number: 48, startsAt: "2026-06-20T00:00:00.000Z", endsAt: "2026-06-27T00:00:00.000Z" },
    { number: 48, startsAt: "2026-07-20T00:00:00.000Z", endsAt: "2026-07-27T00:00:00.000Z" },
  ])
  assertEquals(out.length, 1)
})

const CYCLES = [
  { n: 48, start: "2026-07-20", end: "2026-07-27" },
  { n: 49, start: "2026-07-27", end: "2026-08-03" },
]

Deno.test("currentCycleNumber picks the cycle containing the date", () => {
  assertEquals(currentCycleNumber(CYCLES, "2026-07-23"), 48)
})

Deno.test("currentCycleNumber falls back to the most recent started cycle", () => {
  assertEquals(currentCycleNumber(CYCLES, "2026-08-10"), 49)
})

Deno.test("currentCycleNumber is null before any cycle starts", () => {
  assertEquals(currentCycleNumber(CYCLES, "2026-01-01"), null)
})

Deno.test("transformIssue maps fields and splits relations into blocks/blockedBy", () => {
  const milestoneKeyById = new Map([["mile-1", "M1"]])
  const raw = {
    id: "uuid-eng-1",
    identifier: "ENG-1",
    archivedAt: "2026-07-20T09:00:00.000Z",
    title: "Fix the thing",
    url: "https://linear.app/team/issue/ENG-1",
    description: "some description",
    estimate: 3,
    priority: 2,
    state: { name: "In Progress", type: "started" },
    team: { key: "ENG" },
    assignee: { name: "Ada Lovelace" },
    cycle: { number: 48 },
    labels: { nodes: [{ name: "bug" }] },
    parent: { identifier: "ENG-0" },
    projectMilestone: { id: "mile-1" },
    relations: {
      nodes: [
        { type: "blocks", relatedIssue: { identifier: "ENG-2" } },
        { type: "blocked", relatedIssue: { identifier: "ENG-3" } },
      ],
    },
  }
  assertEquals(transformIssue(raw, milestoneKeyById), {
    id: "ENG-1",
    linearId: "uuid-eng-1",
    archived: true,
    title: "Fix the thing",
    url: "https://linear.app/team/issue/ENG-1",
    description: "some description",
    estimate: 3,
    assignee: "Ada Lovelace",
    status: "In Progress",
    statusType: "started",
    teamKey: "ENG",
    priority: "High",
    priorityValue: 2,
    labels: ["bug"],
    parentId: "ENG-0",
    milestone: "M1",
    cycle: 48,
    blocks: ["ENG-2"],
    blockedBy: ["ENG-3"],
  })
})

Deno.test("transformIssue defaults missing optionals to null/empty, and a missing assignee to the Unassigned sentinel", () => {
  const raw = {
    id: "uuid-eng-9",
    identifier: "ENG-9",
    title: "No frills",
    url: "https://linear.app/team/issue/ENG-9",
    description: null,
    estimate: null,
    priority: null,
    state: null,
    assignee: null,
    cycle: null,
    labels: { nodes: [] },
    parent: null,
    projectMilestone: null,
    relations: { nodes: [] },
  }
  assertEquals(transformIssue(raw, new Map()), {
    id: "ENG-9",
    linearId: "uuid-eng-9",
    archived: false,
    title: "No frills",
    url: "https://linear.app/team/issue/ENG-9",
    description: "",
    estimate: null,
    assignee: "Unassigned",
    status: null,
    statusType: null,
    teamKey: "ENG",
    priority: null,
    priorityValue: null,
    labels: [],
    parentId: null,
    milestone: null,
    cycle: null,
    blocks: [],
    blockedBy: [],
  })
})

Deno.test("transformIssue reads archivedAt as an archived flag, so a diff can tell it from a removal", () => {
  const base = { id: "u", identifier: "ENG-2", title: "t", url: "u", labels: { nodes: [] }, relations: { nodes: [] } }
  assertEquals(transformIssue({ ...base, archivedAt: null }, new Map()).archived, false)
  assertEquals(transformIssue({ ...base, archivedAt: "2026-07-20T09:00:00.000Z" }, new Map()).archived, true)
})

Deno.test("isArchivedIssue only reads a literal true, so a snapshot from before the field is live", () => {
  assertEquals(isArchivedIssue({ id: "ENG-1", archived: true }), true)
  assertEquals(isArchivedIssue({ id: "ENG-1", archived: false }), false)
  assertEquals(isArchivedIssue({ id: "ENG-1" }), false)
  assertEquals(isArchivedIssue(undefined), false)
})

Deno.test("liveIssues and liveSnapshot drop archived work and tolerate a missing list", () => {
  const issues = [{ id: "ENG-1" }, { id: "ENG-2", archived: true }, { id: "ENG-3", archived: false }]
  const ids = (list: { id: string }[]) => list.map((i) => i.id)
  assertEquals(ids(liveIssues(issues)), ["ENG-1", "ENG-3"])
  assertEquals(liveIssues(undefined), [])
  const snapshot = { asOf: "2026-07-23", issues }
  assertEquals(ids(liveSnapshot(snapshot).issues), ["ENG-1", "ENG-3"])
  assertEquals(liveSnapshot(snapshot).asOf, "2026-07-23")
  assertEquals(snapshot.issues.length, 3)
})

Deno.test("dedupeByDataFile keeps the newest manifest entry when two slugs point at one data file", () => {
  const manifest = [
    { slug: "old-name-slug", name: "Product Reliability 2026", dataFile: "pr2026.json" },
    { slug: "1c60eac693e8", name: "Product Reliability 2026", dataFile: "pr2026.json" },
    { slug: "seeded-reliability", name: "Horse Tinder (seed)", dataFile: "seed-b.json" },
  ]
  assertEquals(dedupeByDataFile(manifest), [
    { slug: "1c60eac693e8", name: "Product Reliability 2026", dataFile: "pr2026.json" },
    { slug: "seeded-reliability", name: "Horse Tinder (seed)", dataFile: "seed-b.json" },
  ])
})

Deno.test("upsertProjectManifest adds a new project and sorts by name", () => {
  const manifest = [{ slug: "b-proj", name: "B Project", dataFile: "b.json" }]
  const out = upsertProjectManifest(manifest, { slug: "a-proj", name: "A Project", dataFile: "a.json" })
  assertEquals(out, [
    { slug: "a-proj", name: "A Project", dataFile: "a.json" },
    { slug: "b-proj", name: "B Project", dataFile: "b.json" },
  ])
})

Deno.test("upsertProjectManifest replaces an existing entry for the same slug", () => {
  const manifest = [{ slug: "a-proj", name: "Old Name", dataFile: "a.json" }]
  const out = upsertProjectManifest(manifest, { slug: "a-proj", name: "New Name", dataFile: "a.json" })
  assertEquals(out, [{ slug: "a-proj", name: "New Name", dataFile: "a.json" }])
})

Deno.test("pickProject returns the requested slug when present", () => {
  const projects = [
    { slug: "a-proj", name: "A", dataFile: "a.json" },
    { slug: "b-proj", name: "B", dataFile: "b.json" },
  ]
  assertEquals(pickProject(projects, "b-proj"), { slug: "b-proj", name: "B", dataFile: "b.json" })
})

Deno.test("pickProject falls back to the first entry when the slug is missing or unrequested", () => {
  const projects = [{ slug: "a-proj", name: "A", dataFile: "a.json" }]
  assertEquals(pickProject(projects, "nope"), { slug: "a-proj", name: "A", dataFile: "a.json" })
  assertEquals(pickProject(projects, null), { slug: "a-proj", name: "A", dataFile: "a.json" })
})

Deno.test("pickProject returns null for an empty manifest", () => {
  assertEquals(pickProject([], null), null)
})

const RAW_TEAMS = [
  {
    id: "t-dev",
    key: "DEV",
    name: "Product Development",
    issueEstimationType: "fibonacci",
    issueEstimationAllowZero: true,
    issueEstimationExtended: false,
    states: {
      nodes: [
        { id: "s-review", name: "In Review", type: "started", position: 2980.82 },
        { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "s-prog", name: "In Progress", type: "started", position: 2 },
        { id: "s-dupe", name: "Duplicate", type: "duplicate", position: 5282.08 },
      ],
    },
  },
  {
    id: "t-cus",
    key: "CUS",
    name: "Customer Ops",
    issueEstimationType: "notUsed",
    issueEstimationAllowZero: false,
    issueEstimationExtended: false,
    states: { nodes: [{ id: "s-open", name: "Open", type: "unstarted", position: 1 }] },
  },
]

Deno.test("buildTeams sorts teams by key and each team's states by Linear's own position", () => {
  const teams = buildTeams(RAW_TEAMS)
  assertEquals(teams.map((t: { key: string }) => t.key), ["CUS", "DEV"])
  const dev = teams.find((t: { key: string }) => t.key === "DEV")!
  assertEquals(dev.states.map((s: { name: string }) => s.name), ["Todo", "In Progress", "In Review", "Duplicate"])
  assertEquals(dev.estimation, { type: "fibonacci", allowZero: true, extended: false })
})

Deno.test("buildTeams tolerates a missing team list and missing state nodes", () => {
  assertEquals(buildTeams(undefined), [])
  assertEquals(buildTeams([{ id: "t", key: "T", name: "T" }])[0].states, [])
})

Deno.test("estimateOptions returns each Linear scale's published values", () => {
  const values = (type: string, extended = false) =>
    estimateOptions({ type, allowZero: false, extended }).map((o: { value: number }) => o.value)
  assertEquals(values("exponential"), [1, 2, 4, 8, 16])
  assertEquals(values("exponential", true), [1, 2, 4, 8, 16, 32, 64])
  assertEquals(values("fibonacci"), [1, 2, 3, 5, 8])
  assertEquals(values("fibonacci", true), [1, 2, 3, 5, 8, 13, 21])
  assertEquals(values("linear"), [1, 2, 3, 4, 5])
  assertEquals(values("linear", true), [1, 2, 3, 4, 5, 6, 7])
  assertEquals(values("tShirt"), [1, 2, 3, 5, 8])
})

Deno.test("estimateOptions labels t-shirt sizes and keeps the fibonacci numbers behind them", () => {
  assertEquals(estimateOptions({ type: "tShirt", allowZero: false, extended: true }), [
    { value: 1, label: "XS" },
    { value: 2, label: "S" },
    { value: 3, label: "M" },
    { value: 5, label: "L" },
    { value: 8, label: "XL" },
    { value: 13, label: "XXL" },
    { value: 21, label: "XXXL" },
  ])
})

Deno.test("estimateOptions puts zero first only when the team allows it", () => {
  assertEquals(estimateOptions({ type: "fibonacci", allowZero: true, extended: false })[0], { value: 0, label: "0" })
  assertEquals(estimateOptions({ type: "fibonacci", allowZero: false, extended: false })[0], { value: 1, label: "1" })
})

Deno.test("estimateOptions is empty for an unused or unrecognized scale, so the caller keeps free text", () => {
  assertEquals(estimateOptions({ type: "notUsed", allowZero: true, extended: false }), [])
  assertEquals(estimateOptions({ type: "somethingNew", allowZero: false, extended: false }), [])
  assertEquals(estimateOptions(undefined), [])
})

Deno.test("projectEstimateScale unions every team's values and is null when nobody estimates", () => {
  assertEquals(projectEstimateScale(buildTeams(RAW_TEAMS)), [0, 1, 2, 3, 5, 8])
  assertEquals(projectEstimateScale(buildTeams([RAW_TEAMS[1]])), null)
  assertEquals(projectEstimateScale(undefined), null)
})

Deno.test("identifierTeamKey reads the team prefix off a Linear identifier", () => {
  assertEquals(identifierTeamKey("DEV-123"), "DEV")
  assertEquals(identifierTeamKey("SEED-101"), "SEED")
  assertEquals(identifierTeamKey("nodash"), null)
  assertEquals(identifierTeamKey(undefined), null)
})

Deno.test("teamForIssue matches on teamKey, falls back to the identifier, then to a lone team", () => {
  const teams = buildTeams(RAW_TEAMS)
  assertEquals(teamForIssue(teams, { id: "CUS-1", teamKey: "DEV" })!.key, "DEV")
  assertEquals(teamForIssue(teams, { id: "CUS-1" })!.key, "CUS")
  assertEquals(teamForIssue(teams, { id: "XYZ-1" }), null)
  assertEquals(teamForIssue(buildTeams([RAW_TEAMS[0]]), { id: "XYZ-1" })!.key, "DEV")
  assertEquals(teamForIssue([], { id: "DEV-1" }), null)
})

// The point of ingesting states by name: a team with two "started" states can now be sent to the
// specific one, which resolving by category alone could never do.
Deno.test("workflowStates offers a team's own states in its order and drops types the app cannot store", () => {
  const teams = buildTeams(RAW_TEAMS)
  assertEquals(workflowStates(teams, { id: "DEV-1", teamKey: "DEV" }), [
    { name: "Todo", type: "unstarted" },
    { name: "In Progress", type: "started" },
    { name: "In Review", type: "started" },
  ])
})

Deno.test("workflowStates falls back to one state per category when the snapshot has no team data", () => {
  assertEquals(workflowStates(undefined, { id: "DEV-1" }), DEFAULT_STATUS_OPTIONS)
  assertEquals(workflowStates([], { id: "DEV-1" }), DEFAULT_STATUS_OPTIONS)
})

Deno.test("mergeIngest replaces the Linear-sourced blocks and keeps everything else", () => {
  const existing = {
    capacity: { defaultVelocity: 20 },
    teamVelocity: { note: "synthetic" },
    project: { name: "Old" },
    issues: [{ id: "OLD-1" }],
  }
  const fresh = {
    project: { name: "New" },
    cycles: [],
    currentCycle: null,
    milestones: [],
    issues: [],
    asOf: "2026-07-23",
  }
  assertEquals(mergeIngest(existing, fresh), {
    capacity: { defaultVelocity: 20 },
    teamVelocity: { note: "synthetic" },
    project: { name: "New" },
    cycles: [],
    currentCycle: null,
    milestones: [],
    issues: [],
    asOf: "2026-07-23",
  })
})
