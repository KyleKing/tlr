import { ACTIVE_CYCLES, personCycleCapacity } from "../../web/lib/planning.js"
import type { Snapshot } from "@/seed.ts"

export function projectCapacity(snapshot: Snapshot) {
  const people = [...new Set(snapshot.issues.map((i) => i.assignee))]
    .filter((p) => p !== "Unassigned")
    .sort()
  const rows = []
  for (const person of people) {
    for (const cycle of ACTIVE_CYCLES) {
      const { points, factors } = personCycleCapacity(person, cycle, snapshot.capacity)
      const load = snapshot.issues
        .filter((i) => i.assignee === person && i.cycle === cycle)
        .reduce((acc, i) => acc + (i.estimate || 0), 0)
      rows.push({ person, cycle, capacity: points, load, over: Math.max(0, load - points), factors })
    }
  }
  const overPeople = new Set(rows.filter((r) => r.over > 0).map((r) => r.person))
  const totals = {
    capacity: rows.reduce((acc, r) => acc + r.capacity, 0),
    load: rows.reduce((acc, r) => acc + r.load, 0),
    peopleOverCapacity: overPeople.size,
  }
  return { rows, totals }
}
