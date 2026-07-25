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

## Where it stands

All three original phases shipped. tlr ingests a project from a real Linear workspace, captures a
snapshot every three hours, diffs the plan over time, reviews what changed, and edits tickets back into
Linear from the UI. `deno task seed` generates deterministic offline data so every page works with no
credentials, and `deno task seed:linear` seeds the same story into a throwaway free workspace for live
testing.

How it works is in [ARCHITECTURE.md](ARCHITECTURE.md), including the accepted trade-offs under Known
limits. What tlr deliberately will not do is in [adr/0009](adr/0009-scope-boundaries.md). Everything
below is unbuilt.

## Now — the relationship view

The Roadmap page already places tickets by time and dependency wave. Whether a dedicated node/edge view
adds anything is an open question, so it starts as a throwaway spike rather than a feature.

The real project sets the terms. Of 77 open issues, 27 blocking edges connect 31 of them into seven
clusters (13, 4, 4, 3, 3, 2, 2), with a maximum degree of 6. The other 46 have no dependency at all.
Any layout that treats this as one big graph draws mostly empty space.

The spike, in one uncommitted route reading the real project file:

- Clusters as the frame. Each connected component gets its own tidy sub-graph, with unconnected tickets
  in a compact parked strip rather than scattered as loose dots
- Click through to a focus view. One ticket plus its neighbourhood, expanding a hop at a time, for
  reading a chain rather than surveying the plan
- Blocking edges solid, everything else dashed, so the one relationship that carries ordering risk stays
  visually dominant
- Milestone as co-location. A shared milestone places cards in the same region instead of drawing an
  edge between them, since 7 milestones over 77 tickets would otherwise bury the 27 real edges
- Toggles for what else is drawn: parent/sub-issue, shared cycle, shared assignee. Labels stay out,
  because at 2.5 per issue they are too dense to mean much
- No tests, no nav entry, no screenshots. We look at it against real data, decide, then either promote
  the winner properly or delete the route

The outcome is a decision, not a page: promote it, fold the good parts back into the Roadmap page's
existing wave layout, or drop the idea and record why.

## Next — small fixes

Each is a known gap with the fix already identified.

- **Turn on retention pruning.** `src/retention.ts` reports what it would drop and deletes only with
  `--prune`, held back because project keys were new and a mis-keyed row would thin the wrong history.
  Read a week of `prune: would drop N` lines in `web/data/snapshot-runs.jsonl`, confirm the keys are
  right, then add the flag to the LaunchAgent
- **Time out the Google token calls.** The exchange and refresh in `scripts/gcal-freebusy.ts` still use
  a bare `fetch`, the last ingest calls with no per-attempt timeout. `src/httpRetry.ts` already has the
  pieces
- **Cover the whole roster for on-call.** `oncallByCycle` only tracks people already in
  `capacity.roster`, so a teammate the board does not track is silently dropped from on-call deflation.
  Now that the Incident.io key returns schedules, check who is missing and add them

## Then — a Balance page

`tlr balance` already computes assignee and cycle moves for unscheduled work under a per-person ceiling.
Route that proposal through `/api/edit` so the moves can be reviewed and applied rather than only
printed. [BALANCE-NOTES.md](BALANCE-NOTES.md) has the seams, plus three open sub-questions: a per-person
forecast variant, affinities in Settings rather than hardcoded, and whether to reassign already-owned
work.

## Later — cross-project duplicate detection

Flag likely duplicates within or across projects, with a yes/no/correct-the-AI review queue and a golden
set for tuning. Hard to get right in both directions: AI-generated tickets sound similar without being
duplicates, while an engineer and a customer can describe the same issue differently enough that it
takes reading the code to tell they match. Would need semantic search (embeddings) at minimum, a bounded
candidate range rather than all-pairs, and possibly a small tuned local model for cost and latency at
that volume. Tabled as an idea, not a scoped feature.

The UI would show two or more tickets together and resolve to merge or mark-duplicate-and-close, so it
shares little with the single-ticket editor.

## Blocked

These wait on you or an external resource, not on more code.

- **Production deployment.** Plan written in [adr/0008](adr/0008-deployment.md): a separate systemd unit
  on the yak-shears-managed VM, pulled in and started the same way, sharing the CPU. Secrets no longer
  block it, since `src/secrets.ts` reads env vars on Linux through the same seam the keychain uses
  locally. Remaining prep: a production `serve` task, Google Calendar off the browser-OAuth flow, the
  GitOps `deno cache` step, and the systemd timer for scheduled capture. Waits on you to do the VM setup
- **A managed secret store.** `src/secrets.ts` covers the API keys today. A hosted, multi-user tlr would
  swap the env backend for Vault, Infisical, or a cloud manager behind the same `getSecret` call. Not
  needed while tlr holds only your own credentials
