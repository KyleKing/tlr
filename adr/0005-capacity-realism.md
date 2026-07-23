# 0005 — Capacity realism

- Status: accepted
- Date: 2026-07-23

## Context

The board first assumed every person had the same flat capacity each cycle (20 points). That hides the
things that actually shrink a cycle: an engineer on-call, days out for time off, or a whole-team onsite.
A plan that looks safe against flat capacity can be badly over-committed once those are counted.

Two sources feed real availability, and neither is fully reachable yet:

- On-call comes from Incident.io, which has no MCP connected here. It cannot be fetched
- Time off and the onsite live in Google Calendar. The Google Calendar MCP is available, but it reads
  the current user's calendar only, not the whole team's

## Decision

Model effective capacity per person per cycle in `personCycleCapacity` (pure, tested). A base velocity
(20 by default, overridable per person) is cut by time off and on-call:

- Out days scale it by `(workdays - outDays) / workdays`
- On-call multiplies by `(1 - oncallPenalty)`, default 0.35
- Each cut is returned as a factor so the cell can show why: 📟 on-call, 🧳 time off, and an "over"
  badge when committed points exceed the result

The inputs live in a `capacity` block in the data file, not in code. For now that block is seeded by
hand: the onsite the user named (cycle 49, the week of 2026-07-27) is real; on-call and per-person
velocity are placeholders marked in a `note` for the user to correct. Milestones size off base velocity
across their weeks and skip the near-term calendar events.

## Consequences

- Over-allocation is now honest about on-call and the onsite, which is where the near-term risk is
- The `capacity` block is the seam a future `tlr sync` fills: Incident.io for on-call, Google Calendar
  for time off, past cycles for per-person velocity
- On-call and team-wide time off cannot be sourced automatically today. Until an Incident.io path and a
  team-calendar path exist, those numbers are entered by hand and should be read as estimates
- Because the block is per-file, real capacity data stays in the gitignored `cpu.json`, never the repo

## Update (2026-07-23) — the block is now fetched

The `capacity` block no longer has to be seeded by hand. `deno task capacity` refreshes it:

- On-call: Incident.io has no CLI or MCP, but its REST API does the job. `scripts/capacity.ts` reads a
  bearer token (keychain service `tlr-incidentio`, account `api-key`, or `INCIDENT_IO_TOKEN`), lists
  schedules, and pulls the final schedule entries across the cycle window. Anyone on a shift that
  touches a cycle is marked on-call for it.
- Time off: still Google Calendar, still the current user only. The MCP step writes a small handoff
  file of out-of-office blocks that the script reads with `--calendar-file`. Peers stay manual until
  their free/busy is reachable.

The transforms (`web/lib/capacity.js`) are pure and tested; the script only does the fetching and the
write. A `roster` map in the block ties each person's display name to the email the two sources key on.

Merging is provenance-aware. Each source owns its fields (Incident.io owns `oncall`, the calendar owns
`outDays`/`reason`) and tags what it writes. A refresh overwrites its own prior data, clears entries it
no longer reports, and leaves the other source and any hand-entered value alone. So a value typed by
hand survives every refresh until a source reports on the same person and cycle.
