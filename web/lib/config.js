// Pure edits to the capacity block, applied by the configuration panel (web/app.js) before it POSTs
// the result to /api/config (scripts/serve.ts). No network or file I/O lives here.

// Merge a { config, defaultVelocity } patch into capacity's top-level knobs. capacity.people and
// capacity.roster are left untouched.
export function updateCapacityConfig(capacity, patch) {
  return {
    ...capacity,
    config: { ...capacity.config, ...patch.config },
    ...(patch.defaultVelocity != null ? { defaultVelocity: patch.defaultVelocity } : {}),
  }
}

// Set (or correct) one roster entry's email, keeping every other roster field and person untouched.
export function updateRosterEmail(capacity, name, email) {
  return {
    ...capacity,
    roster: { ...capacity.roster, [name]: { ...capacity.roster?.[name], email } },
  }
}

// Patch one person's one-cycle capacity entry (oncall, outDays, reason, locked, oncallSrc, outSrc).
// A key set to "" or null/undefined is removed rather than stored, so clearing a field back to blank
// (including a *Src marker) is how a value goes back to hand-typed/protected — the same "no marker
// means hand-typed" rule mergeCapacity already applies on refresh (see web/lib/capacity.js).
export function setPersonCycle(capacity, name, cycleNumber, patch) {
  const people = { ...(capacity.people ?? {}) }
  const person = { ...(people[name] ?? { cycles: {} }) }
  const cycles = { ...(person.cycles ?? {}) }
  const key = String(cycleNumber)
  const entry = { ...(cycles[key] ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === "" || v == null) delete entry[k]
    else entry[k] = v
  }
  cycles[key] = entry
  person.cycles = cycles
  people[name] = person
  return { ...capacity, people }
}
