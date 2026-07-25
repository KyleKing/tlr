# Architecture

TLR ("Teller") reads Linear and turns it into things Linear itself does not give you: a
capacity- and dependency-aware planning view, a diff of how the plan changed over time, a
review queue for recent edits, and a reviewed, deterministic way to make batch changes.

## What it is for

Two jobs that share one engine:

1. Report backward. Summarize what changed in a project over a window (the original weekly-update use)
2. Plan forward. Show load per person per cycle and milestone, surface chain risk from the
   blocking graph, and catch low-quality ticket text before it ships

## Shape

One core, two front-ends. The core owns every read, the snapshot store, and the change model, so
the CLI and the web app never talk to Linear directly on their own terms.

```
Linear GraphQL
      |
   core (Deno/TS)
   ├─ fetch      read issues, milestones, cycles, relations
   ├─ snapshot   persist state locally (SQLite) for diff + review
   ├─ analyze    bucketing, capacity, slop scan, chain risk     (web/lib/planning.js)
   └─ change     ops -> validate against live state -> issueUpdate  (src/linear_write.ts)
      |
      ├─ cli      scan / capacity / timeline / diff / review / report / forecast / plan / snapshot / export  (read + preview only)
      └─ web      capacity board, dependency view, weekly changes, review-and-fix, settings
```

Writes reach Linear only from the web app, never the CLI, and there is no MCP server. See
[adr/0009](adr/0009-scope-boundaries.md) for why, along with the other standing scope limits.

## Stack

- Deno + TypeScript for the whole thing (core, CLI, and web share one runtime and one language).
  See [adr/0001-deno-over-python.md](adr/0001-deno-over-python.md)
- No front-end framework. Vanilla ES modules and CSS, so pure logic stays testable without a build
  step. `web/lib/planning.js` is imported by both the browser and Deno tests
- Linear over raw GraphQL `fetch`, not the SDK, because the snapshot and batch-mutation queries are
  custom. The project-issues filter needs `ID!`, not `String!`
- SQLite (`node:sqlite`, built in) for the snapshot store, kept out of the repo because it holds real
  ticket data. See [adr/0003-local-data-public-repo.md](adr/0003-local-data-public-repo.md)
- Secrets through `src/secrets.ts`: an env var (`LINEAR_API_KEY` and friends) first, else the macOS
  keychain (`security` CLI, service `tlr-linear`). Off macOS the keychain call no-ops, so a Linux host
  uses env vars unchanged, the realized form of ADR 0007's `SecretStore`
- Demo/live mode: `TLR_DEMO=1` points writes at the free/test workspace (keychain account `demo-key`)
  with a visible banner; live mode uses `api-key`

## Ingest and storage

`scripts/issues.ts` fetches a project's issues, milestones, cycles, and teams. Cycles are pooled from
every team the project touches, deduped by number, and narrowed to the numbers the project's own issues
reference, because a project can span teams and two teams can number the same week differently. Each
team carries its own workflow states (id, name, type, and Linear's `position`) and its issue-estimation
settings (scale, whether zero is allowed, whether the extended scale is on), and every issue records
its team, so the editor offers that team's real states and real estimate values instead of one
hardcoded list. Both nested connections ride inside the existing project query, which stays under
Linear's complexity budget at ten matched projects.

Linear reports a blocking relation once, on the issue that owns it: A blocking B gives A a `blocks`
edge and gives B nothing, because the reverse lives in `inverseRelations`, which the project query does
not ask for. `linkRelations` pairs them up after transform so `blockedBy` is populated, and the readers
(`blockerMap` in `web/lib/planning.js`) derive blockers from both directions anyway, so a snapshot
captured before that pass still reads with depth. A blocker in another project stays invisible either
way.

Every writer of a project data file goes through `writeJsonAtomic` (temp file, then rename), since
`/api/config`, `/api/refresh`, and `/api/edit` all write the same file and a reader could otherwise
observe a half-written one. Each project succeeds or fails on its own, so a bad manifest entry cannot
end a run, and a capture whose issue count collapses is refused rather than stored as a mass deletion.
An ambiguous project-name match, a page reporting more results with no cursor, and a hung connection
all raise rather than quietly produce a short issue list.

`src/snapshot.ts` persists project state to SQLite on demand, keyed by a stable project key so a rename
in Linear does not fork the history. `src/diff.ts` rolls a pair of snapshots up to the milestone level,
matching on `linearId` so a ticket moved between teams reads as a rename rather than a delete plus an
add. Archived tickets are fetched and reported as archived, distinct from removed-from-project and from
cancelled, and filtered out of every view that plans forward. A ticket that leaves and comes back
carries its prior estimate and milestone instead of arriving as new work. `src/retention.ts` thins
captures beyond 14 days to one a day and beyond a year to one a week.

Capacity comes from Incident.io on-call and Google Calendar free/busy (`deno task capacity`), deflated
per [adr/0005](adr/0005-capacity-realism.md).

## The web app

Routed pages behind a shared nav (`web/lib/nav.js`): Board, Changes, Review, Roadmap, Settings, with a
global project picker. `GET /api/projects/access` checks, cached and best-effort, whether the current
Linear key can still see each locally-ingested project, and flags a stale one rather than silently
showing old data.

The **Board** is the main view: cycles across, people or buckets down, per-cell capacity load, with
search, status, bucket, and flag filters that round-trip through localStorage and the URL. Milestone
headers carry a forecast slip marker, and on-call/out-day overrides are edited in place. What-if mode
overlays PTO and scope moves in memory and shows the resulting forecast shift per milestone. It cannot
reach `/api/edit` or `/api/config`, and leaving the mode drops every overlay.

**Changes** browses snapshot history by capture or by day, in local time. **Review** runs from that
project's review pointer to the newest capture, so unreviewed changes accumulate rather than expiring
at the next capture. Reviewed marks are keyed by window and change-set, so clearing a ticket in the
morning does not suppress a different change to it that afternoon. **Roadmap** (the page, not this
repo's ROADMAP.md) lays tickets on a pannable, zoomable plane, x by cycle or forecast landing date, y by
dependency wave, with lane packing so no two cards overlap, and lists the dependency chains beneath the
filters. **Settings** holds appearance, capacity,
roster, integrations, and secrets.

`web/lib/errorBanner.js` catches uncaught client errors and unhandled rejections into a dismissible
banner, since a client-side failure has nothing to log server-side.

## Chain risk

`chainRisks` in `web/lib/planning.js` is the dependency check the Board, the Roadmap page, the editor's
impact pane, and `tlr timeline` all read. It groups open issues by blocking edges, takes the heaviest
path through each group by remaining points, charges each owner's segment against that person's own
measured velocity, and compares the sequential total against the time left before the target of the
latest milestone the chain reaches. A chain that cannot fit flags every ticket in it.

Two decisions behind it. A chain runs one ticket at a time, so team throughput is the wrong denominator:
a chain where one person owns most of the points takes as long as that person needs however idle
everyone else is. And the rate is a person's measured velocity rather than a specific cycle's deflated
capacity, because a chain running months out should not inherit whichever on-call week happens to fall
in the active cycles. Unassigned work is charged at the roster's median, since the default velocity made
unowned chains read as the fastest work in the plan.

This replaced an ordering-risk check (a blocker finishing after the work it blocks). Across the real
project's 25 blocking edges that check fired zero times, because nobody schedules a blocker after its
dependent. The chain length against the remaining time is the risk that is actually there.

## The write path

`src/ops.ts` is the typed op model: validate against live state, apply in memory, then
`src/linear_write.ts` turns a validated op into a Linear `issueUpdate`. `POST /api/edit` is dry-run by
default and writes on confirm. `web/lib/editForm.js` is the shared modal (title, description, estimate,
priority, milestone, status, cycle, assignee, then preview, then apply), reached from both the Review
page and the Board's hover card.

`web/lib/fieldOptions.js` is the single source for what each field may be set to, narrowed to the
issue's own team where the snapshot has team data. A value the ticket already holds stays on its list
even when the project no longer offers it. Status is picked by the state's own name, so a team with two
"started" states can be sent to the specific one. The op carries the name and the category behind it,
and an op with no name, or a name that team no longer has, still moves the ticket by category, which is
what every snapshot captured before team states were ingested needs.

The modal's right-hand column (`web/lib/editImpact.js` over the pure `web/lib/impact.js`) answers what
the edit costs: the owner's load in the cycle before and after, any milestone whose forecast landing
moves, the ticket's blockers and what it blocks with an ordering warning, and a live slop scan of the
rewritten description. It simulates through the same in-memory what-if overlays the Board uses, so the
pane never writes and never touches the snapshot.

## Secrets

`src/secrets.ts` is the realized `SecretStore` port: an env var, else the macOS keychain. The Settings
secrets pane sets and clears the Linear and Incident.io keys through it, reporting presence and
provenance only and never returning a value to the browser. Keychain writes pipe the value on stdin, so
it never appears in `ps`. A secret shadowed by an env var is read-only, because a keychain entry would
be ignored. Google OAuth keeps its own browser flow and shows status plus the task to run.

## Scheduled capture

`deno task snapshot` refreshes every project in the manifest and captures, run every three hours by a
launchd LaunchAgent (`scripts/schedule.sh install`). launchd fires a missed run on wake, so a sleeping
laptop still gets its capture. A lock file and a two-hour minimum interval (`src/runLock.ts`) keep a
catch-up run from colliding with or duplicating one that already landed.

Ingest records which Linear workspace a project came from, and a run skips a project belonging to
another workspace as not-applicable rather than asking a key that cannot see it (the demo-workspace
project is invisible to the live key by design). A project the active key should see and Linear cannot
find is a rename or a revoked grant, and still fails the run. Every run appends to a capped run log
(`src/runLog.ts`), `GET /api/schedule/health` reads it back, and `web/lib/scheduleBanner.js` banners a
failed or overdue run. No schedule installed means no banner. The hosted equivalent is a systemd timer,
recorded in [adr/0008](adr/0008-deployment.md) rather than shipped as an untested unit file.

## CLI and reporting

`deno task cli` covers `balance`, `capacity`, `diff`, `export`, `forecast`, `plan`, `report`, `review`,
`scan`, `snapshot`, `snapshots`, and `timeline`. `src/report.ts` produces the weekly
shipped/moved/at-risk narrative, `src/forecast.ts` a per-milestone landing date against target (with a
`--weekly` throughput override, since raw summed velocity reads far too high for a small team), and
`src/export.ts` SVG artifacts for a weekly update.

`src/commands/balance.ts` proposes an assignee and cycle for unscheduled open work under a per-person
ceiling deflated for on-call and time off, keeping a dependency chain with one owner. It emits
`set_assignee`/`set_cycle` ops, flags off-roster owners and un-estimated work, and reports per-milestone
deadline risk. See [BALANCE-NOTES.md](BALANCE-NOTES.md).

## Quality

Pure logic lives in `web/lib/*.js` and `src/` modules with no I/O, driven by Deno tests.
`web/lib/theme.js` defines every `--st-*`/`--risk`/`--slop`/`--miss` var per flavor plus a
luminance-computed `--accent-fg`, so filled buttons and pills stay legible whichever accent is in play.
`tests/theme_test.ts` sweeps every flavor/accent pair for contrast failures and `tests/e2e/a11y.spec.ts`
runs an axe-core color-contrast scan on every page. The Playwright suite seeds data against an isolated
store with no Linear key, and `deno task screenshots` regenerates the committed README images.

## Known limits

Accepted trade-offs. Things that are merely unfinished live in [ROADMAP.md](ROADMAP.md).

- A team may define a workflow state outside the six categories the op model stores (Linear's
  "duplicate"). The editor leaves those out of its choices rather than write a status the board has no
  rank, colour, or label for. A ticket already sitting in one still shows it, so the form reads true
- The LaunchAgent's wake-up catch-up rests on `man launchd.plist`, not on an observed overnight sleep
- `renderReport`'s markdown window is only as precise as `asOf`, so two captures on the same day print
  one date. Real intra-day precision needs capture timestamps threaded through `SnapshotDiff.project`

## Current layout

```
src/                  core: seed (data contract), snapshot, diff, review, ops, plan, linear_write
                      (the one write adapter), report, forecast, export, secrets, capture (store
                      locations + the shared capture), runLog, runLock, schedule, commands/, utils/env
scripts/              serve (dev server + JSON API), issues, roster, capacity, gcal-freebusy,
                      seed, seed-linear (fill the demo workspace), snapshot (the scheduled
                      capture), schedule.sh + launchagent.plist.template (its launchd timer), cli
web/app.js            board: rendering, filters, interaction
web/changes.js        weekly-update page       web/review.js   review-and-fix page
web/settings.js       settings page            web/lib/        pure logic (planning, capacity,
                                                               issues, config, theme, appearance, page)
web/templates/        Vento layouts + pages, rendered by the server
web/data/             real fixtures + snapshot sqlite (gitignored); web/data-sample.json is the public demo
tests/                Deno unit tests; tests/e2e Playwright (smoke, pages, screenshots)
```

`scripts/serve.ts` exposes the JSON API the web app uses: `POST /api/config` and `POST /api/refresh`
(capacity edits and refresh), `POST /api/edit` (the one Linear write path), snapshot capture, and the
report/review/mode reads. See [ADR 0007](adr/0007-productization-and-domains.md) for the domain split
and [ROADMAP.md](ROADMAP.md) for what is still open.
