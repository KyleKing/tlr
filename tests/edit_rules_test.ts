import { assert, assertEquals } from "jsr:@std/assert@1"
import { fieldOptions } from "../web/lib/fieldOptions.js"
import { buildTeams } from "../web/lib/issues.js"
import {
  changedFields,
  issueValues,
  normalizeValues,
  opsForChanges,
  pendingEdit,
  TITLE_MAX,
  validateEdit,
} from "../web/lib/editRules.js"

const SNAPSHOT = {
  capacity: { roster: { "Ada Lovelace": {}, "Bob Kahn": {} } },
  cycles: [{ n: 47 }, { n: 48 }, { n: 49 }],
  milestones: [{ key: "M1", name: "M1: Engine" }, { key: "M2", name: "M2: Profiles" }],
}

const ISSUE = {
  assignee: "Ada Lovelace",
  cycle: 48,
  description: "the original text",
  estimate: 3,
  id: "FC-1",
  milestone: "M1",
  priorityValue: 2,
  status: "Todo",
  statusType: "unstarted",
  title: "Ticket one",
}

const OPTIONS = fieldOptions(ISSUE, SNAPSHOT)

// The values a form holds after a fresh open: what the ticket already is.
function untouched() {
  const cur = issueValues(ISSUE)
  return normalizeValues({
    assignee: cur.assignee,
    cycle: String(cur.cycle),
    description: cur.description,
    estimate: String(cur.estimate),
    milestone: cur.milestone,
    priority: String(cur.priority),
    status: cur.status,
    title: cur.title,
  })
}

Deno.test("form strings normalize to the field's real type", () => {
  const values = normalizeValues({
    assignee: "",
    cycle: "",
    description: "text",
    estimate: "",
    milestone: "",
    priority: "3",
    status: "In Progress",
    title: "  spaced  ",
  })
  assertEquals(values.assignee, "Unassigned")
  assertEquals(values.cycle, null)
  assertEquals(values.estimate, null)
  assertEquals(values.milestone, null)
  assertEquals(values.priority, 3)
  assertEquals(values.title, "  spaced  ")
})

Deno.test("an untouched form is valid and changes nothing", () => {
  const values = untouched()
  assertEquals(validateEdit(values, OPTIONS), { ok: true, errors: {} })
  assertEquals(changedFields(ISSUE, values, OPTIONS), [])
  assertEquals(opsForChanges(ISSUE.id, changedFields(ISSUE, values, OPTIONS)), [])
})

Deno.test("an estimate off the team's scale is refused, with the scale in the reason", () => {
  const { ok, errors } = validateEdit({ ...untouched(), estimate: 4 }, OPTIONS)
  assertEquals(ok, false)
  assertEquals(errors.estimate, "Estimate must be one of 0, 1, 2, 3, 5, 8.")
})

Deno.test("a blank estimate is allowed and leaves the current one alone", () => {
  const values = { ...untouched(), estimate: null }
  assertEquals(validateEdit(values, OPTIONS).ok, true)
  assertEquals(changedFields(ISSUE, values, OPTIONS), [])
})

Deno.test("an empty or over-long title is refused", () => {
  assertEquals(validateEdit({ ...untouched(), title: "   " }, OPTIONS).errors.title, "Title cannot be empty.")
  const long = "x".repeat(TITLE_MAX + 1)
  assertEquals(
    validateEdit({ ...untouched(), title: long }, OPTIONS).errors.title,
    `Title is ${TITLE_MAX + 1} characters; the cap is ${TITLE_MAX}.`,
  )
  assertEquals(validateEdit({ ...untouched(), title: "x".repeat(TITLE_MAX) }, OPTIONS).ok, true)
})

// The options list is per team, so a cycle belonging to another team's board never reaches the write.
Deno.test("a cycle outside the issue's team is refused", () => {
  const { ok, errors } = validateEdit({ ...untouched(), cycle: 99 }, OPTIONS)
  assertEquals(ok, false)
  assertEquals(errors.cycle, "That cycle is not one of this team's cycles.")
})

Deno.test("a status, milestone, assignee, or priority off its list is refused", () => {
  const { errors } = validateEdit(
    { ...untouched(), assignee: "Nobody", milestone: "M9", priority: 7, status: "Shipped" },
    OPTIONS,
  )
  assertEquals(Object.keys(errors).sort(), ["assignee", "milestone", "priority", "status"])
})

Deno.test("only the fields that actually differ are reported, old value to new", () => {
  const values = { ...untouched(), estimate: 5, priority: 1, title: "  Ticket one  " }
  const changed = changedFields(ISSUE, values, OPTIONS)
  assertEquals(changed.map((c) => c.field), ["estimate", "priority"])
  assertEquals(changed[0], { field: "estimate", label: "Estimate", from: "3", to: "5", fromValue: 3, toValue: 5 })
  assertEquals(changed[1].from, "High")
  assertEquals(changed[1].to, "Urgent")
})

Deno.test("a changed description reports its size rather than its text", () => {
  const changed = changedFields(ISSUE, { ...untouched(), description: "shorter" }, OPTIONS)
  assertEquals(changed, [{
    field: "description",
    label: "Description",
    from: "17 chars",
    to: "7 chars",
    fromValue: "the original text",
    toValue: "shorter",
  }])
})

Deno.test("clearing the cycle and the milestone reads as none", () => {
  const changed = changedFields(ISSUE, { ...untouched(), cycle: null, milestone: null }, OPTIONS)
  assertEquals(changed.map((c) => [c.field, c.from, c.to]), [
    ["cycle", "Cycle 48", "— none —"],
    ["milestone", "M1: Engine", "— none —"],
  ])
})

Deno.test("changes become the ops the write path takes", () => {
  const values = { ...untouched(), assignee: "Bob Kahn", cycle: null, status: "Done", title: "A clearer title" }
  const changed = changedFields(ISSUE, values, OPTIONS)
  assertEquals(opsForChanges(ISSUE.id, changed), [
    { kind: "set_assignee", id: "FC-1", assignee: "Bob Kahn" },
    { kind: "set_cycle", id: "FC-1", cycle: null },
    { kind: "set_status", id: "FC-1", status: "completed", statusName: "Done" },
    { kind: "rename", id: "FC-1", title: "A clearer title" },
  ])
  assertEquals(pendingEdit(changed), {
    assignee: "Bob Kahn",
    cycle: null,
    status: "Done",
    title: "A clearer title",
  })
})

Deno.test("a ticket with no estimate reads as blank rather than zero", () => {
  const values = issueValues({ ...ISSUE, estimate: undefined })
  assertEquals(values.estimate, null)
  assert(validateEdit(values, OPTIONS).ok)
})

// The reason status is picked by name: a category alone cannot tell a team's two "started" states
// apart, so the op carries the name and the category resolves behind it.
Deno.test("a move between two states of the same category is a real change and names the state", () => {
  const teams = buildTeams([{
    id: "t-dev",
    key: "DEV",
    name: "Product Development",
    issueEstimationType: "fibonacci",
    issueEstimationAllowZero: true,
    issueEstimationExtended: false,
    states: {
      nodes: [
        { id: "s-prog", name: "In Progress", type: "started", position: 1 },
        { id: "s-review", name: "In Review", type: "started", position: 2 },
      ],
    },
  }])
  const issue = { ...ISSUE, id: "DEV-1", teamKey: "DEV", status: "In Progress", statusType: "started" }
  const options = fieldOptions(issue, { ...SNAPSHOT, teams })
  const changed = changedFields(issue, { ...issueValues(issue), status: "In Review" }, options)
  assertEquals(changed.map((c) => [c.from, c.to]), [["In Progress", "In Review"]])
  assertEquals(opsForChanges(issue.id, changed), [
    { kind: "set_status", id: "DEV-1", status: "started", statusName: "In Review" },
  ])
})
