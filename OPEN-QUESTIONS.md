# Open questions

Running log of decisions I could not make without you, and tradeoffs I took a liberty on. Revisit
when the roadmap work below is exhausted. Newest sections appended at the bottom.

## Scope decisions from the mid-session refinement (2026-07-23)

Folded into the plan, recorded so the reasoning survives:

- **No GitHub adapter or third tracker yet.** Phase 1 keeps a _thin_ normalized schema, enough shape
  that a later adapter won't force a rewrite, without building out ADR 0006's full multi-tracker model.
  ADR 0006 stays the target, not this session's build.
- **Deployment is a plan plus minimal prep, not an actual deploy.** Target model: pulled into the VM
  that yak-shears' repo manages and started separately (its own systemd unit, sharing the CPU), the
  same way yak-shears runs. Config-only scaffolding, no secrets. Avoid premature optimization.
- **Seed a free Linear workspace for testing.** New in-scope item (added to ROADMAP backlog). A
  `deno task seed` that creates a throwaway free-tier Linear project with synthetic milestones,
  issues, cycles, and relations, so Phase 1 diff/review can run end-to-end without real ticket data.
  Doubles as a better public-demo fixture than the hand-written `data-sample.json`.
  Open: do you want me to create the free workspace + API key, or will you provision it and drop the
  key in the keychain (`security add-generic-password -s tlr-linear-seed ...`) for the seed script?

## Shipped since this log started (2026-07-23)

Clearing the self-contained, unblocked items so what's left is only work that needs a decision:

- Weekly-update report (`tlr report`, `src/report.ts`) and milestone slip forecast (`tlr forecast`,
  now shared in web/lib/planning.js and shown on the board's milestone headers)
- Faster filters (per-group All/None, visible double-click-to-solo hint)
- Milestone header density (narrow wrapping column, target/progress/forecast moved to the hover)

## Decisions that now block the rest of the roadmap

Everything left needs your input, so I stopped here rather than guess:

1. **Milestone display-key strategy** (see next section). Blocks the naming-assumption fix.
2. **Cohesive-app page structure.** You asked "what other pages, and how to make it cohesive?" The
   remaining UI items (weekly report in the app, an edit-history/review view) each need a home. Options:
   keep one board page and add panels/modals like the config dialog, or add real routed pages with a
   shared nav. I lean panels first (no routing commitment, reuses the dialog pattern), pages later.
3. **Snapshot history in the server.** Both "report in the UI" and the review queue need two snapshots
   to diff. The sqlite store (`src/snapshot.ts`) exists but only the CLI writes it. To surface either
   in the app the server has to capture snapshots (on refresh? daily? on a button?) and expose a
   list/load API. That capture cadence is a call for you.
4. **Edit-history review data source.** The review view can read the diff between two stored snapshots
   (works offline, no key) or lean on a Linear write-time hook for true actor attribution (needs the
   key and the hook). Snapshot-diff is buildable now; the hook is blocked.

## Product direction: what tlr should build beyond Linear

Captured from the mid-session discussion for you to prune. Ranked by value-over-Linear:

1. **Plan-level diff over time** (Phase 1) — the single thing Linear structurally cannot do; its
   history is per-issue, never milestone-scope-over-time
2. **Capacity/dependency forecast** (core, already built) — deepen it; Linear has no on-call/PTO/
   velocity model
3. **Review queue for recent/AI edits** (Phase 1 + ADR 0004)
4. **Weekly-update report generation** — the "report backward" job, currently only implied by Phase 3's
   SVG export. Generate the narrative (shipped / moved / at-risk) from the diff
5. **Milestone slip forecast** — realistic landing date vs. target, labeled as forecast (cheap on top
   of the capacity engine)
6. **What-if planning** — toggle PTO / move scope, watch the forecast shift; Linear can't simulate

Explicitly _not_ pursuing (Linear's own insights/filters are good enough): cross-project load view,
stale-issue detection.

## Near-term: milestone naming assumption (bug when polling other projects)

The board assumes Linear milestones are named "M1: Name". `milestoneKey` (scripts/issues.ts) keys off
the text before the colon, `buildBuckets` uses that key as the column label, and `bucketSub` strips a
leading `/^M\d: /`. A project whose milestones are plain names gets the full name as a long column
label. This will surface the moment tlr points at a real project through the Linear MCP. Open decision:
how to derive a short column label from an arbitrary milestone name. Options I see are ordinal codes by
target date (M1, M2, ... assigned by tlr, not by the name), a truncation with the full name in the
hover, or a user-set short code. Tell me which and I will implement it. Detail is in the ROADMAP item.

## Deferred: deployment and secrets (backlog items 8–11)

- **Secrets story (item 8).** ADR 0007's `SecretStore` port (`KeychainSecrets` vs `HostedSecrets`) is
  designed but not built. Needed before tlr runs for anyone but the current local user. Question:
  build the port now against the keychain adapter, or wait until a second user actually exists? (The
  deployment plan below assumes this lands first.)
- **Production deployment (item 10).** Plan written this session (see `adr/`/deploy notes); the actual
  deploy is held. Model: separate systemd unit on the yak-shears-managed VM, pulled in and started
  like yak-shears, sharing the CPU. Blocked on item 8 for hosted secrets.
- **Structured error handling depth (item 11).** I added the request-scoped log context and error
  handler for parity. Whether per-request IDs need surfacing in responses is a call for once there are
  real failure modes to diagnose.

## Deferred: Incident.io on-call gaps (from roadmap Open questions)

Unchanged from the roadmap. The configured API key returns zero schedules (`GET /v2/schedules` →
`total_record_count: 0`); likely the "Read schedules" grant is team-scoped, not account-level. And
`oncallByCycle` only tracks people already in `capacity.roster`. Both need your access to fix.

## Phase 1–3 build tradeoffs (2026-07-23)

Choices I made building the CLI and Phases 1–3, for you to confirm or redirect:

- **Thin schema, not ADR 0006.** Snapshot, diff, review, and the ops model all read the current
  Linear-shaped data (`src/seed.ts` defines the `Snapshot`/`Issue` types). No `Grouping`/`Relation`/
  `Meta` normalization yet, per your "no GitHub, no third tracker" call. ADR 0006 stays the target for
  when a second tracker actually lands.
- **Offline synthetic data.** `deno task seed` writes two dated snapshots (`web/data/seed-a.json`,
  `seed-b.json`) with a week of drift and registers a `seeded-reliability` project so the board and CLI
  run end-to-end with no Linear key. When you provision a free workspace, a `--linear` mode can push the
  same data through the tracker port. Open: do you want that mode built now, or is offline enough?
- **Phase 2 apply is in-memory only.** `planFromText` parses guidance into ops, `validateOp` checks
  each against live snapshot state, and `applyOps` produces the resulting snapshot so `tlr diff` can
  preview it. It does NOT mutate Linear (no key here, and a real write is a side effect I will not take
  without you). The real mutation adapter behind the tracker port is the remaining Phase 2 work, gated
  on your key. This is the honest limit of what I can finish autonomously.
- **CLI, not MCP, for now.** Per your choice. Subcommands emit JSON for Claude Code to pipe. The MCP
  stdio transport over the same handlers stays a roadmap item.
- **Phase 3 is the SVG export slice.** `boardSvg`/`timelineSvg` render deterministic artifacts from a
  snapshot. The pannable 2D layout candidate from the roadmap is a larger UI effort left open.
