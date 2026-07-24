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

## Status (2026-07-24)

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
- Balance: `src/commands/balance.ts` (`tlr balance`), a deterministic assigner that proposes an
  assignee and cycle for unscheduled open work under a per-person point ceiling, deflated for on-call
  and OOO, keeping a dependency chain with one owner. It emits `set_assignee`/`set_cycle` ops (ready for
  the Review write path), flags off-roster owners and un-estimated work, and reports per-milestone
  deadline risk (does the plan land a milestone's work after its target). `milestoneForecast` grew an
  optional throughput override (`tlr forecast --weekly`) so the forecast can use a realistic per-person
  rate instead of raw summed velocity. Next: route a balance proposal through `/api/edit` as a
  Balance page (see `BALANCE-NOTES.md`)
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
- In-flow fixes: the Review page edits a ticket's title, description, estimate, priority, milestone,
  status, cycle, or assignee, previews the change (dry run), then applies it to Linear on confirm. This
  is the only write path, and only from the UI. Demo mode (`TLR_DEMO=1`) points it at the free/test
  workspace with a visible banner; live mode uses the real key
- Demo workspace and live verification: `deno task seed:linear` seeds a throwaway "Horse Tinder" project
  into the free workspace (guarded to `tlr-demo-workspace`, dry-run by default, archives on re-seed). The
  full loop is verified end to end against real Linear: ingest → an edit from the Review UI → `issueUpdate`
  → read back. This also fixed the `issues` query, which Linear now types as `ID` not `String`
- E2E and screenshots: the Playwright suite seeds data and captures snapshots against an isolated
  store (no Linear key), covering the board and both new pages. `deno task screenshots` regenerates the
  committed README images on demand
- UX/quality pass: the root cause behind several visual bugs was that `--st-*`/`--risk`/`--slop`/`--miss`
  CSS vars were referenced everywhere but never defined (status colors, filter chips, and summary counts
  all rendered unset). `web/lib/theme.js` now defines them per flavor plus a computed `--accent-fg` /
  `--st-*-fg` (luminance-based) so filled buttons and pills stay legible regardless of which accent or
  status color is in play; a few Latte accents were also darkened to clear WCAG AA as small text. Filter
  chips repaint on press instead of only dimming unselected ones. `tests/e2e/a11y.spec.ts` runs an
  axe-core color-contrast scan on every page so this class of bug gets caught going forward
- Milestone filtering: a searchable multi-select popover (type to search, checkboxes, All/None, a count
  badge) replaced one chip per milestone, which overflowed for a milestone name without the "M1: " short
  form. Cycle chips stay a plain chip row
- Ticket pills: the compact view now shows a leading flag glyph and a "·N" estimate suffix, not just a
  ring color and a width nudge
- Global project picker: moved from board-only into the shared nav (`web/lib/nav.js`), so Changes/
  Review/Settings can switch projects too. `GET /api/projects/access` (`src/linearAccess.ts`) does a
  best-effort, cached check of whether the current Linear key can still see each locally-ingested
  project (deriving the real Linear slugId from the project's own stored url, not the manifest's own
  slug field, which isn't guaranteed to match) and surfaces a ⚠ in the picker plus a banner on the
  current project rather than silently showing stale data. Skipped under the e2e harness so tests never
  reach Linear
- Demo data: the offline seed generator (`src/seed.ts`) and `web/data-sample.json` were reflavored from
  a "Reliability Program" theme (SLO specs, paging, incident grace mode — too close to real on-call
  work) to the same fictional "Horse Tinder" theme already used by `scripts/seed-linear.ts`'s live-
  workspace fixture, so there's one obviously-fake demo story instead of two
- Client error visibility: `web/lib/errorBanner.js` installs a global error/unhandledrejection handler
  and renders the message plus full stack into a dismissible banner, since a client-side failure has
  nothing to log server-side and was previously just silent. Wired into every page, plus explicit
  catches in the board's refresh and Settings' save/refresh actions
- Changes page: browses snapshot history (backed by the existing `/api/snapshots` list and a new
  optional `from`/`to` on `GET /api/report`) instead of only ever showing the latest pair. First shipped
  as two dropdowns, then replaced with ‹/› step buttons plus a day-range picker (1/7/30/since-last) that
  resolves "from" to whichever snapshot lands closest to that many days before "to" — a pair of
  dropdowns gave no sense of how far apart two entries were and could pick from-after-to. Review is
  unchanged — its mark-reviewed and edit-in-place actions only make sense against the latest window, so
  it keeps showing only that
- Empty cycle columns (no issue scheduled into them) are now dropped from the board instead of showing
  as a blank column
- Board cycle columns show every cycle the project has scheduled work in (gaps and all), not a fixed
  47/48/49 window — `bucketOf`/`buildBuckets` (`web/lib/planning.js`) previously special-cased those
  literal cycle numbers, which only ever matched the demo seed data; a real project's actual current
  cycle never coincided with them, so its board could only ever fall back to the milestone/backlog view
- Fixed a crash behind "refresh doesn't work": `transformIssue` (`web/lib/issues.js`) left a real
  Linear-ingested unassigned issue as `assignee: null`, but every render/sort/group path keys off the
  literal string "Unassigned" — opening such a project crashed `render()`'s people sort. Normalized at
  the ingest boundary and again defensively in `enrich()`
- A second UX/quality pass: bigger, bolder ticket-pill text (10px → 12px, dropped the cramped "·N"
  estimate suffix now that the pill's width already encodes it); "Open in Linear" restyled as a
  ghost/outline button instead of overriding only its text color on a solid accent fill (light-on-light
  was possible for some accent choices) — `tests/theme_test.ts` now sweeps every flavor/accent
  combination for this exact class of bug; the error banner moved to the bottom of the viewport so it
  stops covering the nav/access-warning; Cycle chips and the Milestones popover merged into one Buckets
  filter with two checkbox sections; the selected project and every board filter (search, status,
  buckets, flags, expanded, rows) now round-trip through localStorage/the URL instead of resetting on
  refresh or navigation; Settings notes that Appearance is a browser setting, not part of any project's
  data, since the project picker there doesn't apply to it
- Clarified, not changed: the "graph showing ticket relationships" is the Timeline view's dependency-
  wave grouping (`dependencyWaves` in `web/lib/planning.js`) — there is no node/edge graph UI, and none
  was removed; "graph" has always meant that wave-card representation plus the hover-based relation
  text. The Timeline view itself was removed this round (the board covers its case); rows: buckets is
  now the default orientation
- A third pass, mostly from live testing against a real project: icon/emoji glyphs next to text
  (ticket-pill flags, on-call/PTO badges, the Configure gear) get their own flex-centered `.ico` wrapper
  instead of relying on inline text flow, since color-emoji fonts don't reliably scale or baseline-align
  with regular text; compact ticket pills show the full id (with team prefix) instead of a bare number;
  `table { width: 100% }` stretched columns to fill the width whenever only a couple were visible, now
  sized to content; a selected bucket that ends up with nothing currently visible (after status/search/
  flag filters, not just "no issues ever") drops out the same way people already did, and the board
  scrolls to the current cycle on first load; Settings fills the page width instead of keeping its old
  760px popup-dialog size; the Board's Refresh button was only ever re-reading the same local file — it
  now POSTs `/api/refresh` (the live Linear/Incident.io/Calendar re-ingest) first, the same as Settings'
  "Refresh all", and a failure there surfaces through the error banner instead of looking like a no-op
- In-flow ticket editing moved off Review-only: `web/lib/editForm.js` extracts the shared form (title,
  description, estimate, priority, milestone, status, cycle, assignee → preview → apply), and the
  Board's hover card gets an "Edit" button that opens the same form in place, "pinning" the card so
  typing/selecting doesn't trigger its usual hover-away auto-hide
- On-call/out-days overrides moved from a Settings form onto the board itself: click an existing 📟/🧳
  badge to edit that person's cycle entry, right-click elsewhere in an eligible cycle cell to add one.
  Settings' "Calendar overrides" pane is removed — same `setPersonCycle` + `POST /api/config` path, just
  edited where the data already renders instead of a separate per-person/per-cycle grid of inputs. This
  also surfaced a real bug: `/api/config`, `/api/refresh`, and `/api/edit` all wrote the same project
  data file with a plain `writeTextFile`, so a concurrent reader could observe a half-written file and
  throw a JSON parse error — all three now write through a temp-file-then-rename `writeJsonAtomic`
- Fixed the real cause of "Refresh runs but shows no cycles" on a real (non-demo) project: a project
  spanning more than one Linear team (`scripts/issues.ts`'s `PROJECT_QUERY`) only ever fetched
  `teams(first: 1)`'s cycles, so whenever a project's actual issues lived on a different team than
  whichever one came first, none of the fetched cycle numbers matched any issue's `cycle`, and every
  bucket looked empty. Now pools cycles from every team on the project (`teams(first: 10)`, trimmed the
  outer `projects(first: 50)` to `first: 10` to stay under Linear's query-complexity budget once that's
  nested in), and `buildCycles` (`web/lib/issues.js`) dedupes by cycle number since it's only unique per
  team. A further wrinkle: two teams can have a same-week cycle under different numbers, so
  `currentCycleNumber` could still pick the wrong one — `ingestProject` now keeps only cycle numbers the
  project's own issues actually reference, which resolves the ambiguity in favor of whichever team is
  doing the work and matches the board's existing behavior of hiding cycles with no issues in them
  anyway. Also caught and fixed while reproducing this: `teams(first: 1)` was itself wrong for the same
  reason (a large team's `cycles` connection is oldest-first, so `first: 12` silently returned the
  earliest 12 cycles ever created rather than the current ones — needed `last: 12`)
- A fourth pass, live against a real project: confirmed the row-header truncation (bucket names in
  Rows: buckets) does show the full label on hover as intended; the board's per-cell red "over capacity"
  shading was checked and found correct (a real, heavily-scheduled future-cycle backlog), not a styling
  bug; Settings' width fix reads as a deliberate ~1080px content column rather than a hard 760px card, not
  full 1512px viewport width, since stretching form inputs edge-to-edge would look worse

Open items live in the Blocked, Backlog, and Open questions sections below; durable decisions are in
[adr/](adr). The schema stays thin (the current Linear shape), not ADR 0006's normalized model, until a
second tracker lands.

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

### Phase 3 — in-flow editing (shipped)

Edit a ticket in place on the Review page: fix the title, description, estimate, priority, milestone,
status, cycle, or assignee, preview the change (a dry run), then apply it to the current workspace. The
name/key/number fields resolve to Linear ids at write time from the issue's team and project context.
This is the same op-and-apply path the write layer uses. SVG export for weekly-update artifacts shipped
earlier. Remaining candidate: a pannable 2D layout instead of the grid. One known limit: status
resolves by workflow-state type and picks the first state of that type, so a team with two states in one
category (two "started" states) needs the specific state chosen by name later.

## Blocked

Called out separately because these wait on you or an external resource, not on more code. Backlog
items depending on them are marked below.

- **Production deployment.** Plan written in [adr/0008](adr/0008-deployment.md): a separate systemd
  unit on the yak-shears-managed VM, pulled in and started the same way, sharing the CPU. Secrets no
  longer block it (`src/secrets.ts` reads env vars on Linux, the same seam the keychain uses locally).
  Remaining prep: a production `serve` task, Google Calendar off the browser-OAuth flow, and the GitOps
  `deno cache` step. Waits on you to do the VM setup.
- **A managed secret store.** `src/secrets.ts` covers the API keys today (env var, else keychain). A
  hosted, multi-user tlr would swap the env backend for Vault/Infisical/a cloud manager behind the same
  `getSecret` call. Not needed while tlr holds only the owner's own credentials.

## Backlog

Ordered by payoff. Unblocked unless a "(blocked: ...)" note says otherwise.

- **Secrets in the config UI** (advances the blocked secrets story). Manage the Linear key,
  Incident.io token, and Google OAuth through Settings, in the keychain today and wired through the
  `SecretStore` port (ADR 0007) so the same panel drives hosted secrets in production.
- **What-if planning.** Toggle a person's PTO or move scope and watch the forecast shift, in-tool.
- **Vendored public assets** fetched by a build task and gitignored (`app-template`'s
  `download-assets.sh`), only if the web app ever depends on something like HTMX instead of the
  hand-rolled `app.js` it uses today.
- **A real node/edge relationship graph**, if the Timeline view's dependency-wave grouping (see Status)
  turns out not to be enough. Not started; raised as a question, not yet asked for as a feature.
- **A relative 2D roadmap chart** to replace the removed Timeline view: ticket cards laid out on a
  pannable 2D plane instead of the grid or wave-cards, with hover for detail (to avoid overlap at a
  glance) and the same filters as the Board. Raised as a question; needs a layout algorithm decision
  before it's buildable (force-directed vs. a fixed axis pair like time × dependency-depth).
- **Scheduled snapshots.** A daily `deno task snapshot` run via launchd (macOS) or a systemd timer/cron
  (Linux), with a catch-up run on wake if the machine was asleep at the scheduled time (`launchd`'s
  `StartCalendarInterval` fires on wake automatically; cron needs `anacron` or an explicit `flock`-guarded
  retry). Errors would need to surface somewhere the owner actually looks — a local notification, a log
  file surfaced in the UI, or piping to the same error-banner mechanism (`web/lib/errorBanner.js`) via a
  dismissed-on-visit banner. Not started; raised as a question about approach, not yet asked for as a
  feature.
- **Cross-project duplicate-ticket detection.** Flag likely duplicates (within or across projects) with
  a quick yes/no/correct-the-AI review queue, an eval/golden set for tuning, and a note that this is hard
  to get right: AI-generated tickets often sound similar as false positives, while an engineer and a
  customer can describe the same issue differently enough that it takes reading the code to tell they
  match. Would likely need semantic search (embeddings) at minimum, a bounded candidate range (not
  all-pairs), and possibly a small tuned local model rather than a general cloud one for cost/latency at
  that volume. Not started; raised as an idea to table, not a scoped feature.

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
