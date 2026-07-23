# Next steps

Running list of what to build next and what needs a decision. Higher-level phases live in
[ROADMAP.md](ROADMAP.md); this file tracks the near-term work and the questions blocking it.

## Done

- Dependency-ordered timeline view. A "Timeline" toggle lays issues out by dependency depth
  (topological waves) instead of by assigned cycle. Each card shows its scheduled bucket, so a card
  scheduled ahead of its blocker stands out. Hover keeps the blocker highlight and full detail card.
  Logic is `dependencyWaves` in `web/lib/planning.js`, with tests.
- Capacity fetcher. `deno task capacity` refreshes the `capacity` block from real sources instead of
  hand-seeding it. On-call comes from the Incident.io REST API; out-days come from a Google Calendar
  handoff file. Pure transforms in `web/lib/capacity.js` (tested), thin I/O in `scripts/capacity.ts`,
  provenance-aware merge that preserves hand-entered values. See ADR 0005's update.

## Setup to finish the capacity feed

- Incident.io token: create an API key in the Incident.io dashboard (Settings → API keys) with
  permission to read schedules, then store it: `security add-generic-password -s tlr-incidentio -a
  api-key -w` (paste the key when prompted). Run `deno task capacity --source incident --dry-run` to
  check what it would write.
- Google Calendar: run `/mcp` in this session and authorize "claude.ai Google Calendar". Out-days for
  peers depend on whether the Workspace shares free/busy; probe once authed.
- Fill in Marissa's email in the `roster` block of `cpu.json` so on-call and out-days match her.

## Next up

- Slop-scan tuning. The base rate (33 of 48 shown) is likely still too high even with the per-ticket
  "not slop" override. Consider weighting tells, or only flagging above a score threshold.
- Compact ticks show only the ticket number. Decide whether to add a short wrapped title snippet, or
  leave the full title to the hover card (current behaviour).

## Open questions

- Team-wide time off: the Google Calendar MCP reads only the current user's calendar. Do teammates
  share free/busy across the Workspace (so the freebusy API reaches them), or do we need a manual
  entry surface for their out-days? On-call is now sourced from Incident.io for everyone on a schedule.
- Google Calendar in the standalone script: the fetch currently comes through the MCP in a Claude
  session, handed to the script as a file. A reproducible `deno task capacity` run would need its own
  OAuth client credentials or a service account. Worth it, or is the MCP handoff enough?
- Deflation knobs: on-call is a flat 35% cut and time off is a straight day-fraction. Are those right,
  or should on-call vary by team and rotation load?
- Per-person base velocity is still a placeholder (default 20). Pull it from past-cycle throughput?
- Whether the dependency timeline and the capacity board stay two views or merge into one.

## Later (unchanged from roadmap)

- Port the reader to Deno, then the SQLite snapshot store with `tlr diff` and `tlr review`.
- Write layer: `tlr plan "<guidance>"` into validated ops, `tlr apply` to run the approved subset.
- SVG export of a view for weekly-update artifacts.
