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
  (deterministic guidance parser). CLI: `plan` (previews the resulting diff, read-only). Writes reach
  Linear only from the Review page (see Phase 3), never the CLI
- Write path: `src/linear_write.ts` turns validated ops into Linear `issueUpdate` mutations, driven by
  the server's `POST /api/edit` (dry-run by default, writes on confirm). v1 covers the fields keyed by
  the issue UUID alone: title, description, estimate, priority. Milestone/status/cycle/assignee moves
  need a name-to-UUID lookup and are v2
- Demo/live mode: `TLR_DEMO=1` points writes at the free/test workspace (keychain account `demo-key`)
  and shows a banner; live mode (the default) uses the real key (`api-key`). `GET /api/mode` reports it
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
- Snapshot history and pages: the server captures a snapshot on refresh (into an env-overridable
  store) and serves list, report, and review endpoints. The web app is now routed pages behind a shared
  nav (Board, Changes, Review, Settings). Changes renders the weekly update; Review groups edits by
  ticket with a mark-reviewed toggle; Settings holds appearance, capacity, roster, calendar overrides,
  and integrations, moved off the board's old dialog
- In-flow fixes: the Review page edits a ticket's title, description, estimate, or priority, previews
  the change (dry run), then applies it to Linear on confirm. This is the only write path, and only from
  the UI. Demo mode (`TLR_DEMO=1`) points it at the free/test workspace with a visible banner; live mode
  uses the real key
- Demo workspace and live verification: `deno task seed:linear` seeds a throwaway "Horse Tinder" project
  into the free workspace (guarded to `tlr-demo-workspace`, dry-run by default, archives on re-seed). The
  full loop is verified end to end against real Linear: ingest → an edit from the Review UI → `issueUpdate`
  → read back. This also fixed the `issues` query, which Linear now types as `ID` not `String`
- E2E and screenshots: the Playwright suite seeds data and captures snapshots against an isolated
  store (no Linear key), covering the board and both new pages. `deno task screenshots` regenerates the
  committed README images on demand

Open items and tradeoffs are in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md). The schema stays thin (the
current Linear shape), not ADR 0006's normalized model, until a second tracker lands.

## Phases

### Phase 1 — snapshot, diff, review (scaffolded)

Persist project state to SQLite on demand. `tlr diff` shows how the plan changed between two captures,
rolled up to the milestone level. `tlr review` shows edits since the last review, and the Review page
groups them by ticket and lets me clear each one. Actor attribution is out of scope (see Decisions).
See [adr/0006](adr/0006-normalized-tracker-schema.md) and
[adr/0007](adr/0007-productization-and-domains.md) for the normalized schema and domain split this
builds on.

### Phase 2 — write layer (op model built; writes run from the UI, not the CLI)

`tlr plan "<natural-language guidance>"` turns intent into structured ops (move milestone, set
priority, add relation, rename, rescope) and previews the resulting diff. It is read-only: the CLI
never writes. Writes go through the Review page, which validates each op against live state, previews
the change, and on confirm applies it as an idempotent `issueUpdate`. Bulk AI edits still go through
the Linear MCP in Claude Code; tlr's job is to review them and fix what is wrong, not to duplicate that
write surface.

### Phase 3 — in-flow editing (shipped for the v1 fields)

Edit a ticket in place on the Review page: fix the title, description, estimate, or priority, preview
the change (a dry run), then apply it to the current workspace. This is the same op-and-apply path the
write layer uses. SVG export for weekly-update artifacts shipped earlier. Remaining: the fields that
need a name-to-UUID lookup (milestone, status, cycle, assignee), and a candidate pannable 2D layout.

## Blocked

Called out separately because these wait on you or an external resource, not on more code. Backlog
items depending on them are marked below.

- **Secrets story (`SecretStore` port, ADR 0007).** `KeychainSecrets` vs `HostedSecrets` is designed,
  not built. Every credential today is a keychain entry or a gitignored file. Needed before tlr runs
  for anyone but the current local user, and before any deploy.
- **Production deployment.** Plan written in [adr/0008](adr/0008-deployment.md): a separate systemd
  unit on the yak-shears-managed VM, pulled in and started the same way, sharing the CPU. Blocked on
  the secrets story (no macOS keychain on the Linux host).

## Backlog

Ordered by payoff. Unblocked unless a "(blocked: ...)" note says otherwise.

- **Editing the fields that need a name-to-UUID lookup.** The Review-page edit form covers title,
  description, estimate, and priority. Milestone, status, cycle, and assignee moves need their target
  resolved to a Linear UUID (the snapshot carries names, not ids for these). Add the resolution to
  `src/linear_write.ts` and the fields to the form.
- **Secrets in the config UI** (advances the blocked secrets story). Manage the Linear key,
  Incident.io token, and Google OAuth through Settings, in the keychain today and wired through the
  `SecretStore` port (ADR 0007) so the same panel drives hosted secrets in production.
- **What-if planning.** Toggle a person's PTO or move scope and watch the forecast shift, in-tool.
- **Vendored public assets** fetched by a build task and gitignored (`app-template`'s
  `download-assets.sh`), only if the web app ever depends on something like HTMX instead of the
  hand-rolled `app.js` it uses today.

## Decisions

- **CLI, not MCP, and neither writes.** The CLI (`deno task cli`: scan, capacity, timeline, diff,
  review, plan, snapshot, export) is the read-and-preview surface for Claude Code, and it is built. Do
  not build an MCP server, and do not add writes to the CLI: bulk AI edits already go through the Linear
  MCP in Claude Code, so a tlr write command would only duplicate it. tlr writes only from the Review
  page, where a person reviews and fixes what the AI changed. If tlr is ever hosted, the CLI can gain a
  mode that calls the hosted tlr API instead of reading local files, reusing the same handlers.
- **Actor attribution is out of scope.** A snapshot-diff cannot tell an AI-via-MCP edit from mine (both
  land under my account), and splitting them would need a distinct Linear agent token or a write-time
  hook. The Review page does not try; it shows every change since the last snapshot and lets me clear
  each one, which is enough to catch what a bulk AI run touched.
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
