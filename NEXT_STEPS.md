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
- Google free/busy spike. `deno task gcal:freebusy` (`scripts/gcal-freebusy.ts`) reads teammates'
  free/busy from a personal Desktop OAuth client, no MCP. Verified against real data: Workspace free/busy
  sharing is on, so a peer's busy blocks come back and no service account is needed. The client JSON
  comes from 1Password and the refresh token is cached for silent re-runs.
- Timeline toggle fix. Switching to the dependency view and back left the timeline rendered under the
  board (a CSS `display` rule beat the `hidden` attribute). Guarded with `[hidden] { display: none }`.
- Slop-scan tuning. Real data showed 15 of 43 flagged tickets tripping on a single weak signal alone
  (length, one dash, one semicolon, or bullets with no stock-phrase hit). `isSlop` now requires
  `score >= 2`, dropping the flagged count from 43 to 28 of 66 issues (33 to 19 of the 48 shown by
  default). The hover card's "mark not slop" affordance now gates on the same threshold instead of
  raw flag count, so it no longer appears for tickets that aren't actually flagged.
- Compact-tick titles. Decided to keep ticket-number-only chips; the hover card already gives the
  full title and detail instantly, and chips are too narrow/dense (several per cell) to fit a useful
  title snippet without bloating the grid.
- Docs. `SETUP.md` is the day-zero credentials guide. New ADRs: 0006 (normalized issue schema across
  Linear and GitHub) and 0007 (productizing the spikes into domains and ports). `AGENTS.md` records the
  spike-then-productionize rule.

## Setup to finish the capacity feed

See `SETUP.md` for the full guide. The one blocker for the live on-call feed is the Incident.io key
(store it, then `deno task capacity --source incident --dry-run`). Google Calendar free/busy now has a
standalone spike (`deno task gcal:freebusy`, own OAuth client, no MCP); folding it into a
`GoogleCalendarSource` adapter that feeds `deno task capacity --source gcal` is the next step per ADR 0007.

## Next up

(nothing queued right now — see Open questions below for what needs a decision first)

## Open questions

- Free/busy to out-days: the spike proves teammates' free/busy is reachable, but free/busy shows busy
  windows without a reason. Mapping a busy block to an out-of-office day needs a heuristic (all-day or
  multi-day blocks) or the `calendar.events.readonly` scope to read event types. Decide which before the
  `GoogleCalendarSource` adapter lands.
- Deflation knobs: on-call is a flat 35% cut and time off is a straight day-fraction. Are those right,
  or should on-call vary by team and rotation load?
- Per-person base velocity is still a placeholder (default 20). Pull it from past-cycle throughput?
- Whether the dependency timeline and the capacity board stay two views or merge into one.

## Later (unchanged from roadmap)

- Port the reader to Deno, then the SQLite snapshot store with `tlr diff` and `tlr review`.
- Write layer: `tlr plan "<guidance>"` into validated ops, `tlr apply` to run the approved subset.
- SVG export of a view for weekly-update artifacts.
