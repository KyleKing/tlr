import { assertEquals } from "jsr:@std/assert@1"
import {
  buildCycles,
  buildMilestones,
  currentCycleNumber,
  dedupeByDataFile,
  isArchivedIssue,
  liveIssues,
  liveSnapshot,
  mergeIngest,
  milestoneKey,
  pickProject,
  priorityLabel,
  transformIssue,
  upsertProjectManifest,
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
