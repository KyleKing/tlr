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
- Roster resolver. `deno task roster` (`scripts/roster.ts`) resolves each assignee display name to an
  email against the Linear GraphQL API, so the roster is no longer hand-typed. Both current assignees
  resolve; Marissa's email is filled.
- Timeline toggle fix. Switching to the dependency view and back left the timeline rendered under the
  board (a CSS `display` rule beat the `hidden` attribute). Guarded with `[hidden] { display: none }`.
- Docs. `SETUP.md` is the day-zero credentials guide. New ADRs: 0006 (normalized issue schema across
  Linear and GitHub) and 0007 (productizing the spikes into domains and ports). `AGENTS.md` records the
  spike-then-productionize rule.

## Setup to finish the capacity feed

See `SETUP.md` for the full guide. The one blocker for the live on-call feed is the Incident.io key
(store it, then `deno task capacity --source incident --dry-run`). Google Calendar free/busy now has a
standalone spike (`deno task gcal:freebusy`, own OAuth client, no MCP); folding it into a
`GoogleCalendarSource` adapter that feeds `deno task capacity --source gcal` is the next step per ADR 0007.

## Next up

- Slop-scan tuning. The base rate (33 of 48 shown) is likely still too high even with the per-ticket
  "not slop" override. Consider weighting tells, or only flagging above a score threshold.
- Compact ticks show only the ticket number. Decide whether to add a short wrapped title snippet, or
  leave the full title to the hover card (current behaviour).

## Open questions

- Team-wide time off: `deno task gcal:freebusy` will show whether teammates' free/busy is reachable
  from a personal OAuth client (Workspace sharing on) or comes back empty (needs domain-wide delegation
  or a manual entry surface). Run it to decide. On-call is already sourced from Incident.io for everyone
  on a schedule.
- Standalone Google path resolved: the free/busy spike uses its own OAuth client, no MCP. Open piece is
  folding it into a `GoogleCalendarSource` that returns out-day `Block[]` for `deno task capacity`.
- Deflation knobs: on-call is a flat 35% cut and time off is a straight day-fraction. Are those right,
  or should on-call vary by team and rotation load?
- Per-person base velocity is still a placeholder (default 20). Pull it from past-cycle throughput?
- Whether the dependency timeline and the capacity board stay two views or merge into one.

## Later (unchanged from roadmap)

- Port the reader to Deno, then the SQLite snapshot store with `tlr diff` and `tlr review`.
- Write layer: `tlr plan "<guidance>"` into validated ops, `tlr apply` to run the approved subset.
- SVG export of a view for weekly-update artifacts.
