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
- `GoogleCalendarSource` adapter. `deno task capacity --source gcal` now fetches live free/busy through
  the same OAuth client as the spike and runs it through `outDaysFromFreeBusy`: a weekday counts as
  reduced-capacity once its busy time reaches 5 hours, or it's an all-day block (free/busy carries no
  event type, so title-based detection isn't available). `--calendar-file` still works for named events
  when a real reason is known. Pure logic in `web/lib/capacity.js` (tested); still a local OAuth client,
  not a hosted per-user credential, which stays the gap before a shared runner can use it (ADR 0007).
  Running it for real against `cpu.json` surfaced that the heuristic under-reports real time off next to
  a hand-typed note (Marissa's known 3-day onsite showed as 1 busy day) — decided to drop hand-typed
  protection entirely rather than special-case it, so every source now always wins once it has an answer
  for a person+cycle, no permanent override.
- Per-person base velocity. `deno task capacity --source history` computes each person's velocity from
  completed points in past cycles, no external fetch needed since it reads the same data file. Applied
  to the real `cpu.json`: Marissa's velocity is now 20 from cycle 47 throughput; Kyle has no completed
  points in a past cycle yet, so he still falls back to the default. `mergeVelocity` now overwrites any
  prior value, hand-typed or not, matching on-call and out-days.
- Deflation knobs: on-call penalty raised from a flat 35% to 45% (`CAPACITY_DEFAULTS.oncallPenalty` in
  `web/lib/planning.js`, ADR 0005, and the real `cpu.json`'s own `config.oncallPenalty`, which had been
  overriding the code default). Time off stays a straight day-fraction cut, confirmed as right for now.
- Dependency timeline and capacity board stay two separate views (current toggle), not merged.

## Setup to finish the capacity feed

See `SETUP.md` for the full guide. The one blocker for the live on-call feed is the Incident.io key
(store it, then `deno task capacity --source incident --dry-run`). Google Calendar out-days and
per-person velocity both run without extra setup beyond what SETUP.md already covers.

## Next up

(nothing queued right now)

## Later (unchanged from roadmap)

- Port the reader to Deno, then the SQLite snapshot store with `tlr diff` and `tlr review`.
- Write layer: `tlr plan "<guidance>"` into validated ops, `tlr apply` to run the approved subset.
- SVG export of a view for weekly-update artifacts.
