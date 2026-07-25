import { assertEquals } from "jsr:@std/assert@1"
import { DEFAULT_ESTIMATE_SCALE, fieldOptions, labelFor } from "../web/lib/fieldOptions.js"

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
  statusType: "unstarted",
  title: "Ticket",
}

Deno.test("cycle and milestone lists lead with an explicit none", () => {
  const options = fieldOptions(ISSUE, SNAPSHOT)
  assertEquals(options.cycles[0].value, null)
  assertEquals(options.milestones[0].value, null)
  assertEquals(options.cycles.map((o) => o.value), [null, 47, 48, 49])
  assertEquals(options.milestones.map((o) => o.label), ["— none —", "M1: Engine", "M2: Profiles"])
})

Deno.test("estimates come from the project's scale", () => {
  const options = fieldOptions(ISSUE, SNAPSHOT)
  assertEquals(options.estimates.map((o) => o.value), DEFAULT_ESTIMATE_SCALE)
})

Deno.test("a snapshot that carries its own estimate scale wins over the default", () => {
  const options = fieldOptions(ISSUE, { ...SNAPSHOT, estimateScale: [1, 2, 4, 8] })
  assertEquals(options.estimates.map((o) => o.value), [1, 2, 3, 4, 8])
})

// A ticket keeps whatever it already holds even when the project no longer offers it, so the form
// shows the truth instead of silently reading back as an edit nobody made.
Deno.test("a value the project no longer offers stays selectable", () => {
  const stale = { ...ISSUE, assignee: "Grace Hopper", cycle: 12, estimate: 13 }
  const options = fieldOptions(stale, SNAPSHOT)
  assertEquals(options.assignees.map((o) => o.value), ["Unassigned", "Ada Lovelace", "Bob Kahn", "Grace Hopper"])
  assertEquals(options.cycles.at(-1), { value: 12, label: "Cycle 12" })
  assertEquals(options.estimates.at(-1), { value: 13, label: "13" })
})

Deno.test("labelFor falls back to the raw value for something off-list", () => {
  const options = fieldOptions(ISSUE, SNAPSHOT)
  assertEquals(labelFor(options.priorities, 1), "Urgent")
  assertEquals(labelFor(options.milestones, null), "— none —")
  assertEquals(labelFor(options.milestones, "M9"), "M9")
})
