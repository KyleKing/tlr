# Next steps

Running list of what to build next and what needs a decision. Higher-level phases live in
[ROADMAP.md](ROADMAP.md); this file tracks the near-term work and the questions blocking it.

## Done

- Dependency-ordered timeline view. A "Timeline" toggle lays issues out by dependency depth
  (topological waves) instead of by assigned cycle. Each card shows its scheduled bucket, so a card
  scheduled ahead of its blocker stands out. Hover keeps the blocker highlight and full detail card.
  Logic is `dependencyWaves` in `web/lib/planning.js`, with tests.

## Next up

- Wire the real Google Calendar (current user only) so Kyle's out-days and the onsite come from actual
  events instead of the hand-seeded `capacity` block. Teammates stay manual until team calendars or an
  Incident.io path exist.
- Slop-scan tuning. The base rate (33 of 48 shown) is likely still too high even with the per-ticket
  "not slop" override. Consider weighting tells, or only flagging above a score threshold.
- Compact ticks show only the ticket number. Decide whether to add a short wrapped title snippet, or
  leave the full title to the hover card (current behaviour).

## Open questions

- Capacity sourcing: Incident.io has no MCP, so on-call is entered by hand. The Google Calendar MCP
  reads only the current user's calendar, not the team's. How do we get team-wide availability, shared
  calendars, a manual entry surface, or an Incident.io API token?
- Deflation knobs: on-call is a flat 35% cut and time off is a straight day-fraction. Are those right,
  or should on-call vary by team and rotation load?
- Per-person base velocity is still a placeholder (default 20). Pull it from past-cycle throughput?
- Whether the dependency timeline and the capacity board stay two views or merge into one.

## Later (unchanged from roadmap)

- Port the reader to Deno, then the SQLite snapshot store with `tlr diff` and `tlr review`.
- Write layer: `tlr plan "<guidance>"` into validated ops, `tlr apply` to run the approved subset.
- SVG export of a view for weekly-update artifacts.
