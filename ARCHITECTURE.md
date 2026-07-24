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
   ├─ fetch      read issues, history, milestones, cycles, relations
   ├─ snapshot   persist state locally (SQLite) for diff + review
   ├─ analyze    bucketing, capacity, slop scan, ordering risk  (web/lib/planning.js today)
   └─ change     plan -> validate against live state -> apply    (write layer, later)
      |
      ├─ cli      report / snapshot / diff / review / plan / apply
      └─ web      capacity board, dependency view, in-flow edit
```

## Stack

- Deno + TypeScript for the whole thing (core, CLI, and web share one runtime and one language).
  See [adr/0001-deno-over-python.md](adr/0001-deno-over-python.md)
- No front-end framework. Vanilla ES modules and CSS, so pure logic stays testable without a build
  step. `web/lib/planning.js` is imported by both the browser and Deno tests
- Linear over raw GraphQL `fetch`, not the SDK, because the snapshot and batch-mutation queries are
  custom. The project-issues filter now needs `ID!`, not `String!` (schema drift from the old script)
- SQLite (`node:sqlite`, built in) for the snapshot store, kept out of the repo because it holds real
  ticket data. See [adr/0003-local-data-public-repo.md](adr/0003-local-data-public-repo.md)
- API key in the macOS keychain (`security` CLI), service `tlr-linear`, account `api-key`

## Current layout

```
scripts/serve.ts        tiny static server for the web spike
web/index.html          board shell
web/style.css           styles (light + dark)
web/app.js              rendering, filters, interaction
web/lib/planning.js     pure logic: bucketOf, buildBuckets, milestoneCapacity, slopScan,
                        missingData, orderingRisks  (shared with tests)
web/data/cpu.json       real project fixture (gitignored)
web/data-sample.json    synthetic fixture so the public demo runs
tests/planning_test.ts  Deno tests for the pure logic
```

The prior Python implementation (`src/tlr/`) is gone. `capacity`, `roster`, and `gcal:freebusy` cover
what it did for capacity, roster, and out-days. Fetching a project's issues and building the
`data.issues` block that `web/app.js` reads is not yet ported: `web/data/cpu.json` is still hand- or
script-maintained per project, not refreshed from a live Linear query. That gap is the "project
switcher" and Ingest-domain work in [NEXT_STEPS.md](NEXT_STEPS.md) and
[ADR 0007](adr/0007-productization-and-domains.md).
