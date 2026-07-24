import { assertEquals } from "jsr:@std/assert@1"
import { setPersonCycle, updateCapacityConfig, updateRosterEmail } from "../web/lib/config.js"

Deno.test("updateCapacityConfig merges config knobs and leaves people/roster alone", () => {
  const capacity = {
    config: { workdaysPerCycle: 5, oncallPenalty: 0.35 },
    defaultVelocity: 20,
    people: { "Ada Lovelace": { velocity: 18 } },
    roster: { "Ada Lovelace": { email: "ada@example.com" } },
  }
  const out = updateCapacityConfig(capacity, { config: { oncallPenalty: 0.45 }, defaultVelocity: 22 })
  assertEquals(out.config, { workdaysPerCycle: 5, oncallPenalty: 0.45 })
  assertEquals(out.defaultVelocity, 22)
  assertEquals(out.people, capacity.people)
  assertEquals(out.roster, capacity.roster)
})

Deno.test("updateCapacityConfig without defaultVelocity leaves it unchanged", () => {
  const capacity = { config: { workdaysPerCycle: 5 }, defaultVelocity: 20 }
  const out = updateCapacityConfig(capacity, { config: { workdaysPerCycle: 4 } })
  assertEquals(out.defaultVelocity, 20)
  assertEquals(out.config.workdaysPerCycle, 4)
})

Deno.test("updateRosterEmail sets a new entry and leaves other people untouched", () => {
  const capacity = { roster: { "Ada Lovelace": { email: "ada@example.com" } } }
  const out = updateRosterEmail(capacity, "Grace Hopper", "grace@example.com")
  assertEquals(out.roster, {
    "Ada Lovelace": { email: "ada@example.com" },
    "Grace Hopper": { email: "grace@example.com" },
  })
})

Deno.test("updateRosterEmail corrects an existing entry's email", () => {
  const capacity = { roster: { "Ada Lovelace": { email: "wrong@example.com" } } }
  const out = updateRosterEmail(capacity, "Ada Lovelace", "ada@example.com")
  assertEquals(out.roster["Ada Lovelace"], { email: "ada@example.com" })
})

Deno.test("setPersonCycle creates a new person and cycle entry", () => {
  const out = setPersonCycle({}, "Kyle King", 48, { oncall: true })
  assertEquals(out.people["Kyle King"].cycles["48"], { oncall: true })
})

Deno.test("setPersonCycle clearing a value back to blank also drops its source marker", () => {
  const capacity = { people: { "Kyle King": { cycles: { 48: { oncall: true, oncallSrc: "incident.io" } } } } }
  const out = setPersonCycle(capacity, "Kyle King", 48, { oncall: null, oncallSrc: null })
  assertEquals(out.people["Kyle King"].cycles["48"], {})
})

Deno.test("setPersonCycle leaves other fields, cycles, and people untouched", () => {
  const capacity = {
    people: {
      "Kyle King": { cycles: { 47: { outDays: 5, reason: "busy" }, 48: { oncall: true } } },
      "Marissa TK": { cycles: { 48: { oncall: true } } },
    },
  }
  const out = setPersonCycle(capacity, "Kyle King", 48, { locked: true })
  assertEquals(out.people["Kyle King"].cycles["48"], { oncall: true, locked: true })
  assertEquals(out.people["Kyle King"].cycles["47"], capacity.people["Kyle King"].cycles["47"])
  assertEquals(out.people["Marissa TK"], capacity.people["Marissa TK"])
})
