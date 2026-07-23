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

### Phase 0 — planning spike (done)

Interactive board on real Contractual Product Uptime data: load per person per cycle and milestone,
capacity heat against an adjustable knob, slop and ordering-risk and missing-data flags, search, and
pinnable filters. Grounds the graph objectives in [adr/0002-planning-graph-objectives.md](adr/0002-planning-graph-objectives.md).

### Phase 1 — snapshot, diff, review (next)

Port the reader to Deno as the Ingest domain's Linear adapter, normalizing to the shared issue schema
so GitHub can follow as a second tracker (see [adr/0006-normalized-tracker-schema.md](adr/0006-normalized-tracker-schema.md)
and [adr/0007-productization-and-domains.md](adr/0007-productization-and-domains.md)). Persist project
state to SQLite on demand. `tlr diff` shows how the plan changed between two captures, rolled up to the
milestone level. `tlr review` shows edits since the last review. Actor attribution cannot separate
AI-via-MCP edits from mine (both land under my account), so AI-edit review leans on a Claude Code hook
that records intent at write time.

### Phase 2 — write layer

`tlr plan "<natural-language guidance>"` turns intent into structured ops (move milestone, set
priority, add relation, rename, rescope). The tool validates each op against live state, renders a
diff, and `tlr apply` runs the approved subset as idempotent mutations. Packages the manual
staging-file workflow so it cannot go stale.

### Phase 3 — web views and in-flow editing

A dependency-ordered forecast timeline alongside the capacity board, and editing from inside the
tool that feeds the same validate-and-apply path. Candidate: a pannable 2D layout instead of the
grid. SVG export for weekly-update artifacts.

## Open questions

None queued right now. Per-person capacity deflates for on-call (flat 45%, see
[adr/0005-capacity-realism.md](adr/0005-capacity-realism.md)) and time off (straight day-fraction). Both
Incident.io on-call and Google Calendar free/busy out-days are wired into `deno task capacity`, and
per-person velocity comes from past-cycle throughput where a person has history. The dependency timeline
and the capacity board stay two views, not merged.
