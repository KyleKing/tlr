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

All three phases run end to end against a real Linear workspace: ingest a project, capture snapshots,
review what changed, and edit tickets back into Linear from the UI. `deno task seed` generates
deterministic offline data (a fictional "Horse Tinder" project) so every page works with no credentials,
and `deno task seed:linear` seeds the same story into a throwaway free workspace for live testing.

### Ingest and storage

`scripts/issues.ts` fetches a project's issues, milestones, cycles, and teams from Linear. Cycles are
pooled from every team the project touches, deduped by number, and narrowed to the numbers the project's
own issues reference, because a project can span teams and two teams can number the same week
differently. Each team also carries its own workflow states (id, name, type, and Linear's `position`)
and its issue-estimation settings (scale, whether zero is allowed, whether the extended scale is on),
and every issue records the team it sits on, so the editor can offer that team's real states and real
estimate values instead of one hardcoded list. Both nested connections ride inside the existing
project query, which stays under Linear's complexity budget at ten matched projects.
Capacity comes from Incident.io on-call and Google Calendar free/busy (`deno task capacity`). Every
writer of a project data file goes through `writeJsonAtomic` (temp file, then rename), since
`/api/config`, `/api/refresh`, and `/api/edit` all write the same file and a reader could otherwise
observe a half-written one.

Each project succeeds or fails on its own, so a bad manifest entry cannot end the run, and a capture
whose issue count collapses is refused rather than stored as a mass deletion. Ambiguous project-name
matches, a page that reports more results with no cursor, and a hung Linear connection all error instead
of quietly producing a short issue list.

`src/snapshot.ts` persists project state to SQLite (`node:sqlite`) on demand, keyed by a stable project
key so a rename in Linear does not fork the history. `src/diff.ts` rolls a pair of snapshots up to the
milestone level, matching on `linearId` so a ticket moved between teams reads as a rename rather than a
delete plus an add. Archived tickets are fetched and reported as archived, distinct from removed from
the project and from cancelled, and filtered out of every view that plans forward. A ticket that leaves
and comes back carries its prior estimate and milestone instead of arriving as new work.
`src/retention.ts` thins captures beyond 14 days to one a day and beyond a year to one a week, reporting
by default and deleting only with `--prune`.

### The web app

Routed pages behind a shared nav (`web/lib/nav.js`): Board, Changes, Review, Roadmap, Settings, with a
global project picker. `GET /api/projects/access` checks, cached and best-effort, whether the current
Linear key can still see each locally-ingested project and flags a stale one rather than silently
showing old data.

The **Board** is the main view: cycles across, people or buckets down, with per-cell capacity load. It
carries search, status, bucket, and flag filters that round-trip through localStorage and the URL,
milestone headers with a forecast slip marker, and on-call/out-day overrides edited in place by clicking
a 📟/🧳 badge or right-clicking a cycle cell. What-if mode overlays PTO and scope moves in memory and
shows the resulting forecast shift per milestone; it cannot reach `/api/edit` or `/api/config`, and
leaving the mode drops every overlay.

**Changes** browses snapshot history by capture or by day, in local time, with a day-range picker
(1/7/30/since-last) that resolves "from" to whichever snapshot lands closest to that many days back.
**Review** runs from that project's review pointer to the newest capture, so unreviewed changes
accumulate rather than expiring at the next capture; marking the last open ticket advances the pointer,
and reviewed marks are keyed by window and change-set so clearing a ticket in the morning does not
suppress a different change to it that afternoon. **Roadmap** lays tickets on a pannable, zoomable plane, x by
cycle or forecast landing date, y by dependency wave, with lane packing so no two cards overlap and
edges drawn between blockers. **Settings** holds appearance, capacity, roster, integrations, and
secrets.

`web/lib/errorBanner.js` catches uncaught client errors and unhandled rejections into a dismissible
banner, since a client-side failure has nothing to log server-side.

### Write path

`src/ops.ts` is the typed op model: validate against live state, apply in memory, then `src/linear_write.ts`
turns a validated op into a Linear `issueUpdate`. `POST /api/edit` is dry-run by default and writes on
confirm. `web/lib/editForm.js` is the shared form (title, description, estimate, priority, milestone,
status, cycle, assignee → preview → apply), reached from both the Review page and the Board's hover card.
Status resolves by the state's own name on the issue's team, so a team with two "started" states can be
sent to the specific one; an op with no name, or a name that team no longer has, still moves the ticket
by workflow-state category, which is what every snapshot captured before team states were ingested
needs. This is the only write path, and only from the UI. `TLR_DEMO=1` points writes at the free/test workspace
(keychain account `demo-key`) behind a visible banner; live mode uses `api-key`. `GET /api/mode` reports
which.

### Secrets

`src/secrets.ts` is the realized `SecretStore` port: an env var, else the macOS keychain. The Settings
secrets pane sets and clears the Linear and Incident.io keys through it, reporting presence and
provenance only and never returning a value to the browser. A secret shadowed by an env var is read-only,
because a keychain entry would be ignored. Google OAuth keeps its own browser flow and shows status plus
the task to run.

### Scheduled capture

`deno task snapshot` refreshes every project in the manifest and captures, run every three hours by a
launchd LaunchAgent (`scripts/schedule.sh install`). launchd fires a missed run on wake, so a sleeping
laptop still gets its capture; a lock file and a 2-hour minimum interval (`src/runLock.ts`) keep a catch-up run
from colliding with or duplicating one that already landed. Ingest records which Linear workspace a
project came from, and a run skips a project belonging to another workspace as not-applicable rather
than asking a key that cannot see it and reporting the project missing — the demo-workspace project is
invisible to the live key by design. A project the active key should see and Linear cannot find is a
rename or a revoked grant, and still fails the run. Every run appends to a capped run log
(`src/runLog.ts`), `GET /api/schedule/health` reads it back, and `web/lib/scheduleBanner.js` banners a
failed or overdue run. No schedule installed means no banner. The hosted equivalent is a systemd timer,
recorded in ADR 0008 rather than shipped as an untested unit file.

### CLI and reporting

`deno task cli` is the read-and-preview surface for Claude Code: `balance`, `capacity`, `diff`, `export`,
`forecast`, `plan`, `report`, `review`, `scan`, `snapshot`, `snapshots`, `timeline`. It never writes.
`src/report.ts` produces the weekly shipped/moved/at-risk narrative, `src/forecast.ts` a per-milestone
landing date against target (with a `--weekly` throughput override, since raw summed velocity reads far
too high for a small team), and `src/export.ts` SVG artifacts for a weekly update.

`src/commands/balance.ts` proposes an assignee and cycle for unscheduled open work under a per-person
ceiling deflated for on-call and time off, keeping a dependency chain with one owner. It emits
`set_assignee`/`set_cycle` ops, flags off-roster owners and un-estimated work, and reports per-milestone
deadline risk. Routing a proposal through `/api/edit` as a Balance page is still open; see
[BALANCE-NOTES.md](BALANCE-NOTES.md).

### Quality

Pure logic lives in `web/lib/*.js` and `src/` modules with no I/O, driven by Deno tests. `web/lib/theme.js`
defines every `--st-*`/`--risk`/`--slop`/`--miss` var per flavor plus a luminance-computed `--accent-fg`,
so filled buttons and pills stay legible whichever accent is in play; `tests/theme_test.ts` sweeps every
flavor/accent pair for contrast failures and `tests/e2e/a11y.spec.ts` runs an axe-core color-contrast scan
on every page. The Playwright suite seeds data against an isolated store with no Linear key;
`deno task screenshots` regenerates the committed README images.

### Known limits

- A team may define a workflow state outside the six categories the op model stores (Linear's
  "duplicate"); the editor leaves those out of its choices rather than write a status the board has no
  rank, colour, or label for
- The LaunchAgent's wake-up catch-up rests on `man launchd.plist`, not on an observed overnight sleep
- Retention reports what it would drop but never deletes until `--prune` is passed by hand, because
  project keys were only just introduced and a mis-keyed row would be thinned against the wrong history
- `renderReport`'s markdown window is only as precise as `asOf`, so two captures on the same day print
  one date; real intra-day precision needs capture timestamps threaded through `SnapshotDiff.project`
- The Google token exchange and refresh in `scripts/gcal-freebusy.ts` still use a bare `fetch`, so they
  are the last ingest calls with no per-attempt timeout
- Incident.io returns zero schedules for the configured key, and `oncallByCycle` only tracks people
  already in `capacity.roster` (see Open questions)

Open items live in the Blocked, Backlog, and Open questions sections below; durable decisions are in
[adr/](adr). The schema stays thin (the current Linear shape), not ADR 0006's normalized model, until a
second tracker lands.

## Phases

### Phase 1 — snapshot, diff, review (shipped)

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

Edit a ticket in place from the Review page or the Board's hover card: fix the title, description,
estimate, priority, milestone, status, cycle, or assignee, preview the change (a dry run), then apply it
to the current workspace. The name/key/number fields resolve to Linear ids at write time from the issue's
team and project context. This is the same op-and-apply path the write layer uses. SVG export for
weekly-update artifacts and the pannable 2D layout both shipped.

## Blocked

Called out separately because these wait on you or an external resource, not on more code. Backlog
items depending on them are marked below.

- **Production deployment.** Plan written in [adr/0008](adr/0008-deployment.md): a separate systemd
  unit on the yak-shears-managed VM, pulled in and started the same way, sharing the CPU. Secrets no
  longer block it (`src/secrets.ts` reads env vars on Linux, the same seam the keychain uses locally).
  Remaining prep: a production `serve` task, Google Calendar off the browser-OAuth flow, the GitOps
  `deno cache` step, and the systemd timer for scheduled capture (described in the ADR, no unit file in
  the repo until it can be tested). Waits on you to do the VM setup.
- **A managed secret store.** `src/secrets.ts` covers the API keys today (env var, else keychain). A
  hosted, multi-user tlr would swap the env backend for Vault/Infisical/a cloud manager behind the same
  `getSecret` call. Not needed while tlr holds only the owner's own credentials.

## Backlog

Ordered by payoff. Unblocked unless a "(blocked: ...)" note says otherwise.

- **A Balance page.** Route a `tlr balance` proposal through `/api/edit` so the assignee and cycle moves
  it already computes can be reviewed and applied, rather than only printed. See
  [BALANCE-NOTES.md](BALANCE-NOTES.md) for the seams; also open there are a per-person forecast variant,
  affinities in Settings rather than hardcoded, and whether to reassign already-owned work.
- **A real node/edge relationship graph**, if the Roadmap page's wave layout and its blocker edges turn
  out not to be enough. Raised as a question, not yet asked for as a feature.
- **Vendored public assets** fetched by a build task and gitignored (`app-template`'s
  `download-assets.sh`), only if the web app ever depends on something like HTMX instead of the
  hand-rolled `app.js` it uses today.
- **Cross-project duplicate-ticket detection.** Flag likely duplicates (within or across projects) with
  a quick yes/no/correct-the-AI review queue, an eval/golden set for tuning, and a note that this is hard
  to get right: AI-generated tickets often sound similar as false positives, while an engineer and a
  customer can describe the same issue differently enough that it takes reading the code to tell they
  match. Would likely need semantic search (embeddings) at minimum, a bounded candidate range (not
  all-pairs), and possibly a small tuned local model rather than a general cloud one for cost/latency at
  that volume. Not started; raised as an idea to table, not a scoped feature.

## Decisions

- **CLI, not MCP, and neither writes.** The CLI (`deno task cli`, see Status) is the read-and-preview
  surface for Claude Code, and it is built. Do
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
