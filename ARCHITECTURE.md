# Architecture

TLR ("Teller") reads Linear and turns it into things Linear itself does not give you: a
capacity- and dependency-aware planning view, a diff of how the plan changed over time, a
review queue for recent edits, and a reviewed, deterministic way to make batch changes.

## What it is for

Two jobs that share one engine:

1. Report backward. Summarize what changed in a project over a window (the original weekly-update use)
2. Plan forward. Show load per person per cycle and milestone, surface ordering risk from the
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
   ├─ analyze    bucketing, capacity, slop scan, ordering risk  (web/lib/planning.js)
   └─ change     ops -> validate against live state -> issueUpdate  (src/linear_write.ts)
      |
      ├─ cli      scan / capacity / timeline / diff / review / report / forecast / plan / snapshot / export  (read + preview only)
      └─ web      capacity board, dependency view, weekly changes, review-and-fix, settings
```

Writes reach Linear only from the web app's Review page, never the CLI. Bulk edits already go through the
Linear MCP in Claude Code, so a CLI write path would duplicate it; the CLI stays read-and-preview. See
[ROADMAP.md](ROADMAP.md) Decisions.

## Stack

- Deno + TypeScript for the whole thing (core, CLI, and web share one runtime and one language).
  See [adr/0001-deno-over-python.md](adr/0001-deno-over-python.md)
- No front-end framework. Vanilla ES modules and CSS, so pure logic stays testable without a build
  step. `web/lib/planning.js` is imported by both the browser and Deno tests
- Linear over raw GraphQL `fetch`, not the SDK, because the snapshot and batch-mutation queries are
  custom. The project-issues filter now needs `ID!`, not `String!` (schema drift from the old script)
- SQLite (`node:sqlite`, built in) for the snapshot store, kept out of the repo because it holds real
  ticket data. See [adr/0003-local-data-public-repo.md](adr/0003-local-data-public-repo.md)
- Secrets through `src/secrets.ts`: an env var (`LINEAR_API_KEY` and friends) first, else the macOS
  keychain (`security` CLI, service `tlr-linear`). Off macOS the keychain call no-ops, so a Linux host
  uses env vars unchanged, the realized form of ADR 0007's `SecretStore`
- Demo/live mode: `TLR_DEMO=1` points writes at the free/test workspace (keychain account `demo-key`)
  with a visible banner; live mode uses `api-key`

## Current layout

```
src/                  core: seed (data contract), snapshot, diff, review, ops, plan, linear_write
                      (the one write adapter), report, forecast, export, secrets, commands/, utils/env
scripts/              serve (dev server + JSON API), issues, roster, capacity, gcal-freebusy,
                      seed, seed-linear (fill the demo workspace), cli
web/app.js            board: rendering, filters, interaction
web/changes.js        weekly-update page       web/review.js   review-and-fix page
web/settings.js       settings page            web/lib/        pure logic (planning, capacity,
                                                               issues, config, theme, appearance, page)
web/templates/        Vento layouts + pages, rendered by the server
web/data/             real fixtures + snapshot sqlite (gitignored); web/data-sample.json is the public demo
tests/                Deno unit tests; tests/e2e Playwright (smoke, pages, screenshots)
```

The prior Python implementation (`src/tlr/`) is gone. `capacity`, `roster`, `gcal:freebusy`, and
`issues` cover capacity, roster, out-days, and issue ingest. `scripts/serve.ts` exposes the JSON API the
web app uses: `POST /api/config` and `POST /api/refresh` (capacity edits and refresh), `POST /api/edit`
(the one Linear write path, from the Review page), snapshot capture, and the report/review/mode reads.
See [ADR 0007](adr/0007-productization-and-domains.md) for the domain split and
[ROADMAP.md](ROADMAP.md) for what's still open.
