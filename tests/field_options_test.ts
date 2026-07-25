import { assertEquals } from "jsr:@std/assert@1"
import { DEFAULT_ESTIMATE_SCALE, fieldOptions, labelFor, statusTypeFor } from "../web/lib/fieldOptions.js"
import { buildTeams } from "../web/lib/issues.js"

const SNAPSHOT = {
  capacity: { roster: { "Ada Lovelace": { email: "ada@example.com" }, "Bob Kahn": { email: "bob@example.com" } } },
  cycles: [{ n: 47 }, { n: 48 }, { n: 49 }],
  milestones: [{ key: "M1", name: "M1: Engine" }, { key: "M2", name: "M2: Profiles" }],
}

const ISSUE = {
  assignee: "Ada Lovelace",
  cycle: 48,
  description: "",
  estimate: 3,
  id: "FC-1",
  milestone: "M1",
  priorityValue: 2,
  status: "Todo",
  statusType: "unstarted",
  title: "Ticket",
}

// One team with two states in the same "started" category and a "duplicate" state the op model has no
// rank, colour, or label for, plus a team that does not estimate at all.
const TEAMS = buildTeams([
  {
    id: "t-dev",
    key: "DEV",
    name: "Product Development",
    issueEstimationType: "tShirt",
    issueEstimationAllowZero: true,
    issueEstimationExtended: false,
    states: {
      nodes: [
        { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "s-prog", name: "In Progress", type: "started", position: 2 },
        { id: "s-review", name: "In Review", type: "started", position: 3 },
        { id: "s-dupe", name: "Duplicate", type: "duplicate", position: 4 },
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
])

const TEAM_SNAPSHOT = { ...SNAPSHOT, teams: TEAMS }
const DEV_ISSUE = { ...ISSUE, id: "DEV-1", teamKey: "DEV", status: "In Progress", statusType: "started" }

Deno.test("cycle and milestone lists lead with an explicit none", () => {
  const options = fieldOptions(ISSUE, SNAPSHOT)
  assertEquals(options.cycles[0].value, null)
  assertEquals(options.milestones[0].value, null)
  assertEquals(options.cycles.map((o: { value: number | null }) => o.value), [null, 47, 48, 49])
  assertEquals(options.milestones.map((o: { label: string }) => o.label), ["— none —", "M1: Engine", "M2: Profiles"])
})

Deno.test("estimates come from the project's scale", () => {
  const options = fieldOptions(ISSUE, SNAPSHOT)
  assertEquals(options.estimates.map((o: { value: number }) => o.value), DEFAULT_ESTIMATE_SCALE)
})

Deno.test("a snapshot that carries its own estimate scale wins over the default", () => {
  const options = fieldOptions(ISSUE, { ...SNAPSHOT, estimateScale: [1, 2, 4, 8] })
  assertEquals(options.estimates.map((o: { value: number }) => o.value), [1, 2, 3, 4, 8])
})

// The whole point of ingesting workflow states by name: a team with two "started" states is offered
// both, so the editor can send the ticket to the specific one.
Deno.test("statuses are the issue's own team's states, by name, in the team's order", () => {
  const options = fieldOptions(DEV_ISSUE, TEAM_SNAPSHOT)
  assertEquals(options.teamKey, "DEV")
  assertEquals(options.statuses, [
    { value: "Todo", label: "Todo", type: "unstarted" },
    { value: "In Progress", label: "In Progress", type: "started" },
    { value: "In Review", label: "In Review", type: "started" },
  ])
  assertEquals(statusTypeFor(options, "In Review"), "started")
})

Deno.test("a snapshot with no team data offers one state per category", () => {
  const options = fieldOptions(ISSUE, SNAPSHOT)
  assertEquals(options.teamKey, null)
  assertEquals(options.statuses.map((o: { value: string }) => o.value), [
    "Backlog",
    "Todo",
    "Triage",
    "In Progress",
    "Done",
    "Canceled",
  ])
})

// Linear's "duplicate" category is filtered out of the offered states (the op model stores six), but a
// ticket already sitting in one still shows its real status rather than reading back as a change.
Deno.test("a state the team no longer offers stays selectable when the ticket is in it", () => {
  const dupe = { ...DEV_ISSUE, status: "Duplicate", statusType: "duplicate" }
  const options = fieldOptions(dupe, TEAM_SNAPSHOT)
  assertEquals(options.statuses.at(-1), { value: "Duplicate", label: "Duplicate", type: "duplicate" })
})

Deno.test("estimates follow the issue's own team scale, labels and all", () => {
  const options = fieldOptions({ ...DEV_ISSUE, estimate: null }, TEAM_SNAPSHOT)
  assertEquals(options.estimates, [
    { value: 0, label: "0" },
    { value: 1, label: "XS" },
    { value: 2, label: "S" },
    { value: 3, label: "M" },
    { value: 5, label: "L" },
    { value: 8, label: "XL" },
  ])
})

// A team that does not estimate has no scale of its own, so the project-wide union ingest wrote is the
// next best closed list the form can validate against.
Deno.test("a team that does not estimate falls back to the project scale", () => {
  const cus = { ...ISSUE, id: "CUS-1", teamKey: "CUS", estimate: null, status: "Open" }
  const options = fieldOptions(cus, { ...TEAM_SNAPSHOT, estimateScale: [1, 2, 4, 8] })
  assertEquals(options.estimates.map((o: { value: number }) => o.value), [1, 2, 4, 8])
})

// A ticket keeps whatever it already holds even when the project no longer offers it, so the form
// shows the truth instead of silently reading back as an edit nobody made.
Deno.test("a value the project no longer offers stays selectable", () => {
  const stale = { ...ISSUE, assignee: "Grace Hopper", cycle: 12, estimate: 13 }
  const options = fieldOptions(stale, SNAPSHOT)
  assertEquals(options.assignees.map((o: { value: string }) => o.value), [
    "Unassigned",
    "Ada Lovelace",
    "Bob Kahn",
    "Grace Hopper",
  ])
  assertEquals(options.cycles.at(-1), { value: 12, label: "Cycle 12" })
  assertEquals(options.estimates.at(-1), { value: 13, label: "13" })
})

Deno.test("an empty snapshot and a missing issue degrade to the defaults", () => {
  const options = fieldOptions(undefined, undefined)
  assertEquals(options.assignees, [{ value: "Unassigned", label: "Unassigned" }])
  assertEquals(options.cycles, [{ value: null, label: "— none —" }])
  assertEquals(options.milestones, [{ value: null, label: "— none —" }])
  assertEquals(options.estimates.map((o: { value: number }) => o.value), DEFAULT_ESTIMATE_SCALE)
  assertEquals(options.teamKey, null)
})

Deno.test("labelFor falls back to the raw value for something off-list", () => {
  const options = fieldOptions(ISSUE, SNAPSHOT)
  assertEquals(labelFor(options.priorities, 1), "Urgent")
  assertEquals(labelFor(options.milestones, null), "— none —")
  assertEquals(labelFor(options.milestones, "M9"), "M9")
  assertEquals(statusTypeFor(options, "nothing like it"), null)
})
