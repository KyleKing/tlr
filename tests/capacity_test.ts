import { assertEquals } from "jsr:@std/assert@1"
import {
  eachDay,
  mergeCapacity,
  mergeVelocity,
  oncallByCycle,
  outDaysByCycle,
  outDaysFromFreeBusy,
  velocityByPerson,
  workdaysInWindow,
} from "../web/lib/capacity.js"

const CYCLES = [
  { n: 48, start: "2026-07-20", end: "2026-07-27" },
  { n: 49, start: "2026-07-27", end: "2026-08-03" },
]
const ROSTER = {
  "Kyle King": { email: "kyle@coverbase.ai" },
  "Marissa TK": { email: "marissa@coverbase.ai" },
}

Deno.test("eachDay is half-open and steps by day", () => {
  assertEquals(eachDay("2026-07-27", "2026-07-30"), ["2026-07-27", "2026-07-28", "2026-07-29"])
  assertEquals(eachDay("2026-07-27", "2026-07-27"), [])
})

Deno.test("workdaysInWindow counts weekdays in the intersection and skips weekends", () => {
  // Mon–Wed onsite inside cycle 49 → 3 weekdays.
  assertEquals(workdaysInWindow("2026-07-27", "2026-07-30", "2026-07-27", "2026-08-03"), 3)
  // Full cycle 49 (Mon–Sun) → 5 weekdays.
  assertEquals(workdaysInWindow("2026-07-27", "2026-08-03", "2026-07-27", "2026-08-03"), 5)
  // Sat–Sun only → 0.
  assertEquals(workdaysInWindow("2026-08-01", "2026-08-03", "2026-07-27", "2026-08-03"), 0)
  // No overlap with the window → 0.
  assertEquals(workdaysInWindow("2026-07-20", "2026-07-24", "2026-07-27", "2026-08-03"), 0)
})

Deno.test("oncallByCycle marks touched cycles and drops off-roster people", () => {
  const entries = [
    { email: "kyle@coverbase.ai", name: "Kyle King", startDate: "2026-07-20", endDate: "2026-07-27" },
    { email: "stranger@example.com", name: "Stranger", startDate: "2026-07-20", endDate: "2026-07-27" },
  ]
  assertEquals(oncallByCycle(entries, CYCLES, ROSTER), { "Kyle King": { 48: true } })
})

Deno.test("oncallByCycle resolves by email when the display name differs", () => {
  const entries = [{ email: "MARISSA@coverbase.ai", name: "M. TK", startDate: "2026-07-27", endDate: "2026-08-03" }]
  assertEquals(oncallByCycle(entries, CYCLES, ROSTER), { "Marissa TK": { 49: true } })
})

Deno.test("outDaysByCycle sums weekday out-days per cycle and caps at the workday count", () => {
  const events = [
    { email: "kyle@coverbase.ai", startDate: "2026-07-27", endDate: "2026-07-30", title: "onsite" },
  ]
  assertEquals(outDaysByCycle(events, CYCLES, ROSTER), { "Kyle King": { 49: { outDays: 3, reason: "onsite" } } })
  // A two-week PTO spanning both cycles caps each at 5.
  const pto = [{ email: "kyle@coverbase.ai", startDate: "2026-07-20", endDate: "2026-08-03", title: "PTO" }]
  assertEquals(outDaysByCycle(pto, CYCLES, ROSTER), {
    "Kyle King": { 48: { outDays: 5, reason: "PTO" }, 49: { outDays: 5, reason: "PTO" } },
  })
})

Deno.test("mergeCapacity applies on-call, then clears its own stale entries on a later run", () => {
  const base = { defaultVelocity: 20, people: {} }
  const first = mergeCapacity(base, { "Kyle King": { 48: true } }, "incident.io")
  assertEquals(first.people["Kyle King"].cycles["48"].oncall, true)
  assertEquals(first.people["Kyle King"].cycles["48"].oncallSrc, "incident.io")
  // Next run no longer reports Kyle on-call in 48 → the entry it wrote is removed.
  const second = mergeCapacity(first, {}, "incident.io")
  assertEquals(second.people["Kyle King"], undefined)
})

Deno.test("mergeCapacity keeps hand-entered values and the other source's fields", () => {
  const base = {
    people: {
      "Kyle King": { cycles: { 49: { outDays: 3, reason: "onsite" } } }, // hand-entered, no marker
    },
  }
  const withOncall = mergeCapacity(base, { "Kyle King": { 49: true } }, "incident.io")
  const ev = withOncall.people["Kyle King"].cycles["49"]
  assertEquals(ev.oncall, true)
  assertEquals(ev.outDays, 3) // manual out-days survive an on-call refresh
  // A calendar refresh reporting nothing must not wipe the hand-entered out-days (no gcal marker on it).
  const afterGcal = mergeCapacity(withOncall, {}, "gcal")
  assertEquals(afterGcal.people["Kyle King"].cycles["49"].outDays, 3)
  assertEquals(afterGcal.people["Kyle King"].cycles["49"].oncall, true)
})

Deno.test("mergeCapacity replaces its own out-days when the calendar changes them", () => {
  const first = mergeCapacity({ people: {} }, { "Kyle King": { 49: { outDays: 3, reason: "onsite" } } }, "gcal")
  assertEquals(first.people["Kyle King"].cycles["49"].outDays, 3)
  const second = mergeCapacity(first, { "Kyle King": { 49: { outDays: 5, reason: "PTO" } } }, "gcal")
  assertEquals(second.people["Kyle King"].cycles["49"].outDays, 5)
  assertEquals(second.people["Kyle King"].cycles["49"].reason, "PTO")
})

Deno.test("outDaysFromFreeBusy flags a day only once busy time reaches the threshold", () => {
  const calendars = {
    "kyle@coverbase.ai": {
      busy: [
        // Mon 2026-07-27: two meetings totalling 3h — under the 5h threshold.
        { start: "2026-07-27T14:00:00Z", end: "2026-07-27T15:30:00Z" },
        { start: "2026-07-27T17:00:00Z", end: "2026-07-27T18:30:00Z" },
        // Tue 2026-07-28: an all-day block clears the threshold on its own.
        { start: "2026-07-28T00:00:00Z", end: "2026-07-29T00:00:00Z" },
      ],
    },
  }
  assertEquals(outDaysFromFreeBusy(calendars, CYCLES, ROSTER), {
    "Kyle King": { 49: { outDays: 1, reason: "busy" } },
  })
})

Deno.test("outDaysFromFreeBusy ignores weekend busy time and caps at the workday count", () => {
  const calendars = {
    "kyle@coverbase.ai": {
      busy: [
        // Sat–Sun, 30h busy — ignored, weekends don't eat into workdays.
        { start: "2026-08-01T00:00:00Z", end: "2026-08-03T06:00:00Z" },
      ],
    },
  }
  assertEquals(outDaysFromFreeBusy(calendars, CYCLES, ROSTER), {})
})

Deno.test("velocityByPerson averages completed points across past cycles", () => {
  const cycles = [{ n: 47, start: "2026-07-13", end: "2026-07-20" }, ...CYCLES]
  const issues = [
    { assignee: "Kyle King", cycle: 47, statusType: "completed", estimate: 8 },
    { assignee: "Kyle King", cycle: 47, statusType: "completed", estimate: 5 },
    { assignee: "Kyle King", cycle: 48, statusType: "completed", estimate: 100 }, // not yet past
    { assignee: "Marissa TK", cycle: 47, statusType: "started", estimate: 13 }, // not completed
    { assignee: "Unassigned", cycle: 47, statusType: "completed", estimate: 3 },
  ]
  assertEquals(velocityByPerson(issues, cycles, 48), { "Kyle King": 13 })
})

Deno.test("mergeVelocity overwrites a prior velocity, hand-typed or not, once history reports", () => {
  const overHand = mergeVelocity({ people: { "Marissa TK": { cycles: {}, velocity: 25 } } }, { "Marissa TK": 10 })
  assertEquals(overHand.people["Marissa TK"].velocity, 10)
  assertEquals(overHand.people["Marissa TK"].velocitySrc, "history")
  const first = mergeVelocity({ people: {} }, { "Kyle King": 13 })
  assertEquals(first.people["Kyle King"].velocity, 13)
  assertEquals(first.people["Kyle King"].velocitySrc, "history")
  const second = mergeVelocity(first, { "Kyle King": 18 })
  assertEquals(second.people["Kyle King"].velocity, 18)
  // No longer reported → the value this source wrote is cleared, not left stale.
  const third = mergeVelocity(second, {})
  assertEquals(third.people["Kyle King"], undefined)
})
