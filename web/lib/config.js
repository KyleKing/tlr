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
