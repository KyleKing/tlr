import { assertEquals } from "jsr:@std/assert@1"
import {
  eachDay,
  mergeCapacity,
  mergeVelocity,
  oncallByCycle,
  outDaysByCycle,
  outDaysFromFreeBusy,
  unrosteredOncall,
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

Deno.test("mergeCapacity protects a hand-typed out-days value from an active gcal report", () => {
  const base = {
    people: {
      "Marissa TK": { cycles: { 49: { outDays: 3, reason: "onsite" } } }, // hand-typed, no marker
    },
  }
  // gcal now actually reports something for that same slot — the hand-typed value must survive.
  const merged = mergeCapacity(base, { "Marissa TK": { 49: { outDays: 1, reason: "busy" } } }, "gcal")
  const ev = merged.people["Marissa TK"].cycles["49"]
  assertEquals(ev.outDays, 3)
  assertEquals(ev.reason, "onsite")
  assertEquals(ev.outSrc, undefined)
})

Deno.test("mergeCapacity's locked flag blocks a source from refreshing its own prior write", () => {
  const base = {
    people: {
      "Kyle King": { cycles: { 49: { outDays: 1, reason: "busy", outSrc: "gcal", locked: true } } },
    },
  }
  const merged = mergeCapacity(base, { "Kyle King": { 49: { outDays: 5, reason: "PTO" } } }, "gcal")
  const ev = merged.people["Kyle King"].cycles["49"]
  assertEquals(ev.outDays, 1)
  assertEquals(ev.reason, "busy")
  // Reporting nothing at all must not clear a locked entry either.
  const cleared = mergeCapacity(merged, {}, "gcal")
  assertEquals(cleared.people["Kyle King"].cycles["49"].outDays, 1)
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

Deno.test("velocityByPerson averages completed points across the cycles a person worked", () => {
  const cycles = [{ n: 47, start: "2026-07-13", end: "2026-07-20" }, ...CYCLES]
  const issues = [
    { assignee: "Kyle King", cycle: 47, statusType: "completed", estimate: 8 },
    { assignee: "Kyle King", cycle: 47, statusType: "completed", estimate: 5 },
    { assignee: "Kyle King", cycle: 48, statusType: "completed", estimate: 100 }, // not yet past
    { assignee: "Marissa TK", cycle: 47, statusType: "started", estimate: 13 }, // not completed
    { assignee: "Unassigned", cycle: 47, statusType: "completed", estimate: 3 },
  ]
  assertEquals(velocityByPerson(issues, cycles, 48), { "Kyle King": { velocity: 13, cycles: 1 } })
})

// The regression this exists for: a lead back from months away delivered in one cycle and was out for
// the whole of the other. Averaging over both read as 5 a cycle, and every chain estimate and forecast
// they touched inherited it.
Deno.test("velocityByPerson ignores a cycle the person was out for entirely", () => {
  const cycles = [
    { n: 46, start: "2026-07-06", end: "2026-07-13" },
    { n: 47, start: "2026-07-13", end: "2026-07-20" },
    ...CYCLES,
  ]
  const issues = [{ assignee: "Kyle King", cycle: 46, statusType: "completed", estimate: 10 }]
  const capacity = { people: { "Kyle King": { cycles: { "47": { outDays: 5, reason: "leave" } } } } }
  assertEquals(velocityByPerson(issues, cycles, 48, capacity), { "Kyle King": { velocity: 10, cycles: 1 } })
})

Deno.test("velocityByPerson scales a partly-out cycle up to a full week", () => {
  const cycles = [{ n: 47, start: "2026-07-13", end: "2026-07-20" }, ...CYCLES]
  const issues = [{ assignee: "Kyle King", cycle: 47, statusType: "completed", estimate: 6 }]
  // Three of five workdays worked, so 6 points reads as a 10-point full week.
  const capacity = { people: { "Kyle King": { cycles: { "47": { outDays: 2 } } } } }
  assertEquals(velocityByPerson(issues, cycles, 48, capacity), { "Kyle King": { velocity: 10, cycles: 1 } })
})

// On-call is a planning assumption, not a measurement. Inverting it would turn a productive on-call
// week into a clear-week rate nobody has hit.
Deno.test("velocityByPerson leaves an on-call cycle at its measured rate", () => {
  const cycles = [{ n: 47, start: "2026-07-13", end: "2026-07-20" }, ...CYCLES]
  const issues = [{ assignee: "Marissa TK", cycle: 47, statusType: "completed", estimate: 20 }]
  const capacity = { people: { "Marissa TK": { cycles: { "47": { oncall: true } } } } }
  assertEquals(velocityByPerson(issues, cycles, 48, capacity), { "Marissa TK": { velocity: 20, cycles: 1 } })
})

Deno.test("velocityByPerson omits a person with no cycle worth measuring", () => {
  const cycles = [{ n: 47, start: "2026-07-13", end: "2026-07-20" }, ...CYCLES]
  const capacity = { people: { Ghost: { cycles: { "47": { outDays: 5 } } } } }
  const issues = [{ assignee: "Ghost", cycle: 47, statusType: "completed", estimate: 4 }]
  assertEquals(velocityByPerson(issues, cycles, 48, capacity), {})
})

Deno.test("mergeVelocity keeps a hand-typed velocity but refreshes its own prior write", () => {
  const hand = { people: { "Marissa TK": { cycles: {}, velocity: 25 } } }
  const withHand = mergeVelocity(hand, { "Marissa TK": { velocity: 10, cycles: 2 } })
  assertEquals(withHand.people["Marissa TK"].velocity, 25) // hand-typed, no velocitySrc → protected by default
  const first = mergeVelocity({ people: {} }, { "Kyle King": { velocity: 13, cycles: 3 } })
  assertEquals(first.people["Kyle King"].velocity, 13)
  assertEquals(first.people["Kyle King"].velocitySrc, "history")
  assertEquals(first.people["Kyle King"].velocityCycles, 3)
  const second = mergeVelocity(first, { "Kyle King": { velocity: 18, cycles: 4 } })
  assertEquals(second.people["Kyle King"].velocity, 18)
  assertEquals(second.people["Kyle King"].velocityCycles, 4)
  // No longer reported → the value this source wrote is cleared, not left stale.
  const third = mergeVelocity(second, {})
  assertEquals(third.people["Kyle King"], undefined)
})

Deno.test("mergeVelocity's locked flag blocks history from refreshing its own prior write", () => {
  const base = { people: { "Kyle King": { cycles: {}, velocity: 13, velocitySrc: "history", locked: true } } }
  const merged = mergeVelocity(base, { "Kyle King": { velocity: 18, cycles: 2 } })
  assertEquals(merged.people["Kyle King"].velocity, 13)
  // Reporting nothing at all must not clear a locked person's velocity either.
  const cleared = mergeVelocity(merged, {})
  assertEquals(cleared.people["Kyle King"].velocity, 13)
})

// A person on call but not on the roster is dropped from the deflation, so the board plans as though
// they were free. The refresh names them rather than leaving the gap silent.
Deno.test("unrosteredOncall names people on call that the roster does not track", () => {
  const cycles = [{ n: 48, start: "2026-07-20", end: "2026-07-27" }]
  const entries = [
    { email: "kyle@x.test", name: "Kyle King", startDate: "2026-07-21", endDate: "2026-07-23" },
    { email: "david@x.test", name: "David", startDate: "2026-07-22", endDate: "2026-07-24" },
  ]
  const roster = { "Kyle King": { email: "kyle@x.test" } }
  assertEquals(unrosteredOncall(entries, cycles, roster), ["David"])
  assertEquals(Object.keys(oncallByCycle(entries, cycles, roster)), ["Kyle King"])
})

Deno.test("unrosteredOncall ignores a shift that misses every cycle, and an empty roster", () => {
  const cycles = [{ n: 48, start: "2026-07-20", end: "2026-07-27" }]
  const away = [{ email: "d@x.test", name: "David", startDate: "2026-01-01", endDate: "2026-01-02" }]
  assertEquals(unrosteredOncall(away, cycles, { "Kyle King": {} }), [])
  // With no roster at all, oncallByCycle keeps everyone, so nobody is being dropped.
  assertEquals(unrosteredOncall(away, cycles, {}), [])
})
