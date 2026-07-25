// One place that says, per consumer, what an archived ticket does to the answer.
//
// Ingest fetches archived issues on purpose so the diff can tell an archive apart from a removal
// (scripts/issues.ts, web/lib/issues.js). That puts them in front of every other reader too, and a
// consumer that forgets to exclude them quietly counts finished-and-filed work as load, scope, or
// slop. The shape of the assertion is the same everywhere: adding an archived ticket to a snapshot
// must not move the output at all. velocityByPerson is the one deliberate exception.

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1"
import { assigneeNames } from "../scripts/roster.ts"
import { balance } from "../src/commands/balance.ts"
import { projectCapacity } from "../src/commands/capacity.ts"
import { scanIssues } from "../src/commands/scan.ts"
import { projectTimeline } from "../src/commands/timeline.ts"
import { boardSvg, timelineSvg } from "../src/export.ts"
import { milestoneForecast } from "../src/forecast.ts"
import { generateSnapshots } from "../src/seed.ts"
import type { Issue, Snapshot } from "../src/seed.ts"
import { velocityByPerson } from "../web/lib/capacity.js"
import { liveSnapshot } from "../web/lib/issues.js"
import { roadmapLayout } from "../web/lib/roadmap.js"
import { whatIfPlan } from "../web/lib/whatif.js"

// Loud on every axis a consumer might read: a person nobody else has, a big estimate, a milestone and
// a cycle the board draws, slop in the description, and a blocking edge into the live graph.
const ARCHIVED: Issue & { archived: boolean } = {
  archived: true,
  assignee: "Archived Owner",
  blockedBy: [],
  blocks: ["SEED-103"],
  cycle: 48,
  description: "This will comprehensively leverage a robust, seamless approach; furthermore it delves in.",
  estimate: 99,
  id: "SEED-999",
  labels: [],
  milestone: "M1",
  parentId: null,
  priority: "Urgent",
  priorityValue: 1,
  related: [],
  status: "Todo",
  statusType: "unstarted",
  title: "Archived ticket that must not count",
  url: "",
}

function pair(): { live: Snapshot; polluted: Snapshot } {
  const { a } = generateSnapshots()
  const live = structuredClone(a)
  const polluted = structuredClone(a)
  polluted.issues.push(structuredClone(ARCHIVED))
  return { live, polluted }
}

function unmoved(name: string, run: (snapshot: Snapshot) => unknown) {
  Deno.test(`${name} ignores an archived ticket`, () => {
    const { live, polluted } = pair()
    assertEquals(JSON.parse(JSON.stringify(run(polluted))), JSON.parse(JSON.stringify(run(live))))
  })
}

unmoved("milestoneForecast", (s) => milestoneForecast(s))
unmoved("boardSvg", (s) => boardSvg(s))
unmoved("timelineSvg", (s) => timelineSvg(s))
unmoved("balance", (s) => balance(s))
unmoved("projectCapacity", (s) => projectCapacity(s))
unmoved("projectTimeline", (s) => projectTimeline(s))
unmoved("scanIssues", (s) => scanIssues(s))
unmoved("roadmapLayout", (s) => roadmapLayout(s))
unmoved("whatIfPlan", (s) => whatIfPlan(s, []))
unmoved("liveSnapshot", (s) => liveSnapshot(s))

Deno.test("the archived fixture would move every consumer if it were live", () => {
  const { live, polluted } = pair()
  const asLive = structuredClone(polluted)
  ;(asLive.issues[asLive.issues.length - 1] as Issue & { archived: boolean }).archived = false
  for (const run of [milestoneForecast, boardSvg, projectCapacity, scanIssues]) {
    assertNotEquals(JSON.stringify(run(asLive)), JSON.stringify(run(live)))
  }
})

Deno.test("the roster does not learn a person who only owns archived work", () => {
  assertEquals(assigneeNames([{ assignee: "Ada" }, { archived: true, assignee: "Archived Owner" }]), ["Ada"])
})

// The one place archived work still counts: velocity measures what was delivered, and a team that
// tidies its board by archiving finished tickets should not watch its recorded throughput fall.
Deno.test("velocityByPerson still counts completed work that has since been archived", () => {
  const cycles = [{ n: 47, start: "2026-07-13", end: "2026-07-20" }, { n: 48, start: "2026-07-20", end: "2026-07-27" }]
  const issues = [
    { assignee: "Ada", cycle: 47, estimate: 8, statusType: "completed" },
    { archived: true, assignee: "Ada", cycle: 47, estimate: 5, statusType: "completed" },
  ]
  assertEquals(velocityByPerson(issues, cycles, 48), { Ada: { velocity: 13, cycles: 1 } })
})
