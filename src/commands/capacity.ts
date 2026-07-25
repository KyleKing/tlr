import { liveIssues } from "../../web/lib/issues.js"
import { activeCycles, personCycleCapacity } from "../../web/lib/planning.js"
import type { Issue, Snapshot } from "@/seed.ts"

export function projectCapacity(snapshot: Snapshot) {
  const issues = liveIssues(snapshot.issues) as Issue[]
  const people = [...new Set(issues.map((i) => i.assignee))]
    .filter((p) => p !== "Unassigned")
    .sort()
  const rows = []
  for (const person of people) {
    for (const cycle of activeCycles(snapshot)) {
      const { points, factors } = personCycleCapacity(person, cycle, snapshot.capacity)
      const load = issues
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
