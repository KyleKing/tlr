# Roadmap

## Vision

A single tool for planning a Linear project forward and reviewing what changed, with edits made from
inside the tool so you stay in one place. It fills gaps Linear leaves open: a dependency- and
capacity-aware forecast, a plan-level diff over time, and a reviewed, deterministic batch-edit path
that keeps AI-made changes and sloppy ticket text from reaching a wider audience unchecked.

## Principles

1. Local-first. Real ticket data stays on the machine, never in this public repo
2. Read before write. Every mutation validates against live state and shows a diff first
3. Forecasts are labeled as forecasts. Derived schedules never masquerade as real dates
4. Pure logic is testable. Analysis lives in framework-free modules with Deno tests
5. Insert new items alphabetically into unordered lists; do not re-sort existing ones

## Phases

### Phase 1 — snapshot, diff, review (next)

Persist project state to SQLite on demand. `tlr diff` shows how the plan changed between two captures,
rolled up to the milestone level. `tlr review` shows edits since the last review. Actor attribution
cannot separate AI-via-MCP edits from mine (both land under my account), so AI-edit review leans on a
Claude Code hook that records intent at write time. See [adr/0006](adr/0006-normalized-tracker-schema.md)
and [adr/0007](adr/0007-productization-and-domains.md) for the normalized schema and domain split this
builds on.

### Phase 2 — write layer

`tlr plan "<natural-language guidance>"` turns intent into structured ops (move milestone, set
priority, add relation, rename, rescope). The tool validates each op against live state, renders a
diff, and `tlr apply` runs the approved subset as idempotent mutations. Packages the manual
staging-file workflow so it cannot go stale.

### Phase 3 — in-flow editing

Editing from inside the tool that feeds the same validate-and-apply path as Phase 2. Candidate: a
pannable 2D layout instead of the grid. SVG export for weekly-update artifacts.

## Backlog

Ordered by dependency and payoff; production deployment is last on purpose.

1. **Data-freshness UX.** `loadData()` silently falls back to `data-sample.json` if the project's data
   file is missing, and there's no visible signal when the shown data is stale (a snapshot taken hours
   or days ago) versus the fallback sample. A visible banner or header state for "showing sample data" /
   "data as of `<age>`" would prevent misreading stale or demo data as current.
2. **Test coverage for the web app.** All current tests are pure-function unit tests (`web/lib/*.js`);
   `web/app.js`'s DOM rendering and interaction code (filters, hover card, config panel, timeline
   toggle) has zero automated coverage. Playwright end-to-end tests would close this and are the
   standard `app-template` carries; a lightweight DOM smoke test is the minimum bar.
3. **Keyboard navigation on the board.** The board's now keyboard-friendly in spirit (Linear-close
   density), but the grid itself needs arrow-key movement between ticks/cards, a focus ring distinct
   from the hover state, and ARIA roles so the hover card's content is reachable without a mouse.
   Currently everything (search, filters, hover card) is mouse-only.
4. **Narrow-viewport handling.** The board is a wide table; `.wrap` scrolls horizontally but the header,
   filter bar, and legend haven't been checked below ~900px. Decide whether to explicitly scope tlr as
   desktop-only (reasonable for a planning tool used at a desk) or invest in a real narrow layout, rather
   than leaving it undefined.
5. **CI** (`.github/workflows/ci.yml`): `deno test`, `deno check`, `deno fmt --check`, and `deno lint` on
   every push and PR, plus Dependabot for GitHub Actions versions. Cheap and overdue given how much now
   depends on the pre-commit hook alone.
6. **Biome**, layered on top of `deno fmt`/`deno lint` for the TS/JS rules Deno's linter doesn't cover
   (unused imports, `useConst`, import-type enforcement).
7. **A fuller `.gitignore`** (coverage output, `*.tsbuildinfo`, editor cruft) beyond the current
   data/sqlite exclusions.
8. **Secrets story for more than one local user.** Every credential today is a macOS keychain entry or a
   gitignored local file (Incident.io token, Google OAuth client/token, Linear API key), and the config
   panel's refresh/save endpoints assume that same single-machine trust model. ADR 0007's `SecretStore`
   port (`KeychainSecrets` vs `HostedSecrets`) is designed but not built. Needed before tlr can run for
   anyone other than the current single local user, including the deployment below.
9. **A `deno compile` production task** and a matching `prod` script, once tlr needs to run as a
   standalone binary rather than `deno task dev`.
10. **Production deployment.** Likely target: nested into the existing `yak-shears` Hetzner Cloud VPS
    rather than a new server, for cost — same Caddy reverse proxy (new subdomain or path route), a new
    systemd service alongside the existing ones, reusing the cloud-init/DNS/Let's Encrypt pattern already
    proven there. Blocked on item 8 (no keychain access on a shared server).
11. **Structured error handling and a request-scoped log context** (`AsyncLocalStorage`), once
    `scripts/serve.ts` grows past its current three routes into something with real failure modes to
    diagnose.
12. **Zod-validated env config** with dev/prod defaults (`app-template`'s `env.ts`), once tlr grows
    enough environment-dependent behavior to warrant it over ad hoc `Deno.env.get` calls.
13. **Vendored public assets** fetched by a build task and gitignored (`app-template`'s
    `download-assets.sh`), only if the web app ever depends on something like HTMX instead of the
    hand-rolled `app.js` it uses today.

### Added 2026-07-23

- **Seed a free Linear workspace for testing.** A `deno task seed` that creates a throwaway free-tier
  project with synthetic milestones, issues, cycles, and relations, so Phase 1 diff/review can run
  end-to-end without touching real ticket data. Doubles as a richer public-demo fixture than the
  hand-written `data-sample.json`. Unblocks Phase 1 testing, so it ranks high despite the late add.
- **Weekly-update report generation** (the "report backward" job in ARCHITECTURE.md). Generate the
  narrative (shipped / moved / at-risk) from a Phase 1 diff. SVG export stays Phase 3; the text
  report can come as soon as `tlr diff` exists.
- **Milestone slip forecast.** Realistic landing date vs. target, labeled as a forecast, computed
  from remaining scope, capacity, and per-person velocity. Cheap on top of the existing capacity
  engine.
- **What-if planning.** Toggle a person's PTO or move scope and watch the forecast shift, in-tool.
  Fits Phase 3's in-flow editing.
- **Faster filter controls.** Changing the shown status, bucket, or flag set takes too many clicks
  today (one per chip, with a hidden double-click-to-solo). Revisit the interaction: candidates are
  select-all/clear-all per group, a shift-click range, keyboard access to the chips, and surfacing the
  double-click-to-solo affordance so it is discoverable.
- **A tlr MCP server (and matching CLI) for Claude Code.** Expose tlr's aggregated analysis that the
  Linear MCP does not give you, so an agent making batch edits to Linear can query tlr first. Two
  concrete tools to start: slop detection as a service (`scan_text` over provided ticket text, reusing
  `slopScan`), and capacity plus dependency timeline per project (`project_capacity`, `project_timeline`)
  so the agent can combine tlr's forecast with a user's stated preferences to schedule and assign each
  ticket. The engine already computes all of this for the board (`web/lib/planning.js`, `deno task
  capacity`), so this is a thin transport over existing pure functions, which keeps it aligned with the
  spike-then-productionize rule (a read-only surface, no write path). The read-through analysis feeds
  the reviewed batch-edit path in Phase 2, where the agent proposes ops and tlr validates them.

Explicitly out of scope for now (Linear's own views cover them): a GitHub adapter or any third
tracker (ADR 0006 stays the target, not a near-term build), cross-project load view, and
stale-issue detection.

## Open questions

- **Incident.io on-call has two live gaps.** The configured API key currently returns zero schedules
  (`GET /v2/schedules` → `total_record_count: 0`), so on-call refreshes see nothing at all regardless of
  who's on call — check whether the key's "Read schedules" grant is scoped to a team rather than the
  account level (SETUP.md's Incident.io section covers the fix). Separately, `oncallByCycle` only
  tracks people already in `capacity.roster`, so even once schedules are visible, anyone not on the
  roster (e.g. a teammate the board doesn't track, like David) is silently dropped — add them to the
  roster to have their on-call shifts show up.
- Per-person capacity deflates for on-call (flat 45%, see [adr/0005](adr/0005-capacity-realism.md)) and
  time off (straight day-fraction). Both Incident.io on-call and Google Calendar free/busy out-days are
  wired into `deno task capacity` (and the config panel's "Refresh all"), and per-person velocity comes
  from past-cycle throughput where a person has history. The dependency timeline and the capacity board
  stay two views, not merged.
