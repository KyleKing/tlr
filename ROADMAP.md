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

## Status (2026-07-23)

A first pass at all three phases now runs offline through a CLI (`deno task cli`), driven by
deterministic synthetic data (`deno task seed`). Shipped this session as scaffolding, not the finished
product:

- Phase 1: `src/snapshot.ts` (node:sqlite store), `src/diff.ts` (milestone-rollup diff), `src/review.ts`
  (review queue with a stored pointer). CLI: `diff`, `review`, `snapshot`, `snapshots`
- Phase 2: `src/ops.ts` (typed op model, validate against live state, in-memory apply) and `src/plan.ts`
  (deterministic guidance parser). CLI: `plan` (previews the resulting diff). The real Linear mutation
  adapter behind the tracker port is the remaining work, gated on a key
- Phase 3: `src/export.ts` (`boardSvg`, `timelineSvg`). CLI: `export`
- Reporting: `src/report.ts` (`tlr report`, weekly shipped/moved/at-risk narrative from a diff) and
  `src/forecast.ts` (`tlr forecast`, per-milestone landing date vs target, labeled a forecast)
- Also: `scan`, `capacity`, and `timeline` CLI commands for Claude Code to pull before a batch edit
- Board UX: per-group All/None filter toggles with a visible double-click-to-solo hint, and milestone
  headers that wrap into a narrow column with target and progress moved to the hover
- Forecast on the board: each milestone header carries a slip marker (early/late vs. target) with the
  forecast landing date in the hover, from the shared `milestoneForecast` in web/lib/planning.js
- Milestone naming: headers show the name (an "M1: " prefix stripped) truncated to a narrow column,
  full name and detail in the hover, so a project with plain milestone names renders correctly

Open items and tradeoffs are in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md). The schema stays thin (the
current Linear shape), not ADR 0006's normalized model, until a second tracker lands.

## Phases

### Phase 1 — snapshot, diff, review (scaffolded)

Persist project state to SQLite on demand. `tlr diff` shows how the plan changed between two captures,
rolled up to the milestone level. `tlr review` shows edits since the last review. Actor attribution
cannot separate AI-via-MCP edits from mine (both land under my account), so AI-edit review leans on a
Claude Code hook that records intent at write time. See [adr/0006](adr/0006-normalized-tracker-schema.md)
and [adr/0007](adr/0007-productization-and-domains.md) for the normalized schema and domain split this
builds on.

### Phase 2 — write layer (scaffolded; real apply pending a key)

`tlr plan "<natural-language guidance>"` turns intent into structured ops (move milestone, set
priority, add relation, rename, rescope). The tool validates each op against live state, renders a
diff, and `tlr apply` runs the approved subset as idempotent mutations. Packages the manual
staging-file workflow so it cannot go stale.

### Phase 3 — in-flow editing (SVG export shipped; in-flow editing pending)

Editing from inside the tool that feeds the same validate-and-apply path as Phase 2. Candidate: a
pannable 2D layout instead of the grid. SVG export for weekly-update artifacts.

## Blocked

Called out separately because these wait on you or an external resource, not on more code. Backlog
items depending on them are marked below.

- **Free Linear seed/test environment.** I cannot create accounts or API keys. `deno task seed`
  generates offline synthetic fixtures, which covers testing today. Seeding a real free-tier workspace
  (and a `--linear` mode for the seed script) needs you to create a free Linear account and store its
  key in the keychain. Until then diff, review, and apply only run against synthetic or your existing
  local data.
- **Real Linear write path (Phase 2 `apply`).** The op model, validation against live state, and an
  in-memory apply are built and previewed by `tlr plan`. Real mutations need a Linear key and the
  tracker write adapter behind the port.
- **Secrets story (`SecretStore` port, ADR 0007).** `KeychainSecrets` vs `HostedSecrets` is designed,
  not built. Every credential today is a keychain entry or a gitignored file. Needed before tlr runs
  for anyone but the current local user, and before any deploy.
- **Production deployment.** Plan written in [adr/0008](adr/0008-deployment.md): a separate systemd
  unit on the yak-shears-managed VM, pulled in and started the same way, sharing the CPU. Blocked on
  the secrets story (no macOS keychain on the Linux host).

## Backlog

Ordered by payoff. Unblocked unless a "(blocked: ...)" note says otherwise.

- **Snapshot history in the server** (prerequisite for the two pages below). The sqlite store
  (`src/snapshot.ts`) exists but only the CLI writes it. Decision: the server captures a snapshot on
  each refresh (deduping an unchanged payload) and exposes list/load plus server-side diff, report, and
  review endpoints that reuse the `src/` handlers. That gives the Changes and Review pages two
  snapshots to compare without a Linear key.
- **Routed pages and shared nav** (decided over panels). Split the single board into Board, Changes,
  Review, and Settings pages behind one top nav with consistent chrome. Board is the current view;
  Settings folds in today's config dialog and later the secrets panel.
- **Changes page (weekly report).** Render `tlr report`'s shipped/moved/at-risk narrative from the
  diff between the two most recent stored snapshots. Depends on the snapshot history above.
- **Review page (edit history by my account).** The UI for Phase 1's review queue, built from the
  snapshot-diff first (added, removed, moved, re-estimated, status, slop), which works offline with no
  key. Give me a way to mark a change reviewed, and group changes to the same ticket within a 30-minute
  window into one unit, never grouping across a change already reviewed. Actor attribution (AI-via-MCP
  vs. mine) is deferred: both land under my account today. The clean split is to route AI edits through
  a distinct Linear app-user/agent token (agents show as their own actor) or a write-time hook; add
  that enrichment on top of the snapshot-diff base once a key exists.
- **Secrets in the config UI** (advances the blocked secrets story). Expand Settings to manage the
  Linear key, Incident.io token, and Google OAuth through the UI, in the keychain today and wired
  through the `SecretStore` port (ADR 0007) so the same panel drives hosted secrets in production.
- **What-if planning.** Toggle a person's PTO or move scope and watch the forecast shift, in-tool.
  Fits the in-flow editing below.
- **In-flow editing on the board** (the rest of Phase 3). Editing from inside the tool that feeds the
  same validate-and-apply path as Phase 2. Candidate: a pannable 2D layout instead of the grid.
  (Real writes are blocked on the Linear write path above.)
- **Vendored public assets** fetched by a build task and gitignored (`app-template`'s
  `download-assets.sh`), only if the web app ever depends on something like HTMX instead of the
  hand-rolled `app.js` it uses today.

## Decisions

- **CLI, not MCP.** The CLI (`deno task cli`: scan, capacity, timeline, diff, review, plan, snapshot,
  export) is the integration surface for Claude Code, and it is built. Do not build an MCP server. If
  tlr is ever hosted, the CLI can gain a mode that calls the hosted tlr API instead of reading local
  files, which reuses the same handlers without an MCP protocol layer.
- **Thin schema, no GitHub yet.** Snapshot, diff, review, and the op model read the current Linear
  shape. ADR 0006's normalized model stays the target for when a second tracker actually lands.
- **Out of scope** (Linear's own views cover them): a GitHub adapter or any third tracker, a
  cross-project load view, and stale-issue detection.

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
