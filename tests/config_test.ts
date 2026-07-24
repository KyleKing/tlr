import { assertEquals } from "jsr:@std/assert@1"
import { updateCapacityConfig, updateRosterEmail } from "../web/lib/config.js"

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
