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

## Done — the relationship view

Answered by a throwaway spike against the real project, then deleted. Recording the outcome here so the
idea does not come back unexamined.

The spike drew clusters and a focus view over `pr2026.json`. Of 77 open issues, only 31 sit in a
blocking chain at all, and six of the seven clusters are pairs or triples that no layout improves. The
drawing added nothing over the Roadmap page's existing wave plane. What did carry information was the
text beside each cluster: how far it stretches, and whether it can land in time.

Two things came out of it, both shipped:

- The graph was flat on real data. Linear reports a blocking relation once, on the issue that owns it,
  so every real ingest had an empty `blockedBy` and `dependencyWaves` collapsed to a single wave. The
  seed fixture hid it because seed relations are symmetric. Fixed in ingest and in the readers
- Ordering risk was the wrong measure. It fired zero times across 25 real edges, because nobody
  schedules a blocker after its dependent. `chainRisks` replaced it: a chain runs one ticket at a time,
  so its points are charged to the people who own it and compared against the time left before its
  milestone. See [ARCHITECTURE.md](ARCHITECTURE.md) for the model

A dedicated node/edge page stays unbuilt, and the spike says it should. Revisit only if a project turns
up whose graph is dense enough that the wave plane cannot show it.

## Done — the small fixes

- **Retention prunes.** The LaunchAgent passes `--prune`. It was waiting on the store keying history
  correctly, and it was not: captures taken before ingest recorded Linear's project id sat under a
  `slug:` key while newer ones sat under `id:`, so one project ran two histories and each page saw
  half. `mergeForkedProjectKeys` repairs that on open
- **The Google token calls time out.** The exchange and refresh in `scripts/gcal-freebusy.ts` go
  through `fetchWithRetry` like every other ingest call
- **On-call covers the whole roster.** The roster was doubling as the set of people to forecast
  against, which forced it to stay narrow, so three engineers on call were missing from it and their
  on-call weeks deflated nothing. Ownership of live work now decides who the forecast plans for
  (`planningPeople`), and `deno task roster` writes every active Linear member. Twenty on-call shifts
  resolve where eight did before

Velocity was measured wrong alongside them. Averaging completed points over every past cycle counted
leave as throughput of zero, so a lead back from months away read as 1 point a cycle. A cycle now counts
only when the person worked part of it and delivered, and a partly-out cycle scales up to a full week.
Both chain-risk flags on the real project cleared once the numbers were right, which is worth
remembering the next time a flag looks alarming: check the velocity behind it first.

## Done — the Balance page

`tlr balance`'s proposal is now reviewable at `/balance`: a row per proposed owner-and-cycle move, each
a checkbox over the ops the assigner already emits, so applying goes through `POST /api/edit` rather
than a second write path. Preview is a dry run.

Two defaults were wrong once the roster stopped being the planning set. Balance spread work across
roster keys, which after the roster widened to every engineer would have handed this project's tickets
to 23 people; it now uses whoever owns work here, falling back to the roster only for a project where
nothing is assigned yet. And its cycle window ran eight past the last cycle the project has, so every
candidate came back unplaceable with a warning that read like "nothing fits".

Still open from [BALANCE-NOTES.md](BALANCE-NOTES.md): a per-person forecast variant, affinities in
Settings rather than hardcoded in `DEFAULT_AFFINITIES`, and whether to offer reassigning work someone
already owns.

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
