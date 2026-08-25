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
limits. What tlr deliberately will not do is in [adr/0009](adr/0009-scope-boundaries.md). Each section
below says whether it is built.

## Next — context sources

A read-only enrichment layer over external systems (a linked support ticket, a Slack thread, a GitHub
PR) that an agent doing triage queries once instead of making its own live API call per source per
issue. Design and rationale: [ADR 0011](adr/0011-context-sources.md).

The port, the cache under it, the `context` command, and the first adapter shipped. `src/cache.ts` keys
on `(source, query fingerprint)` and takes no project id, closing the same project-scoping gap that
[ideas.txt #7](ideas.txt) and team-wide capture both name. `deno task cli context --issue DEV-1234`
prints every `ContextItem` across configured sources, linked results first, and names any source with
no credential on this machine instead of passing its silence off as an empty answer.

Pylon went first because its linked signal is the clearest: a custom field holds the bare tracker
identifier, so the linked lookup is one `equals` filter rather than a text search. The request shapes
came from a session spike against the live API, the tests replay a redacted recording, and both tiers
have since run against a real token: the linked lookup returned the support ticket recorded against a
live Linear identifier, and the wider net returned tickets in the window.
[SETUP.md](SETUP.md#pylon) has the two steps to mint a token, and
`deno task cli context --issue <identifier>` is the check. Two things to know before writing a second
adapter: Pylon filters a requester by contact id rather than by email (so `ContextQuery.actor` is
dropped unless it is a uuid), and its issue search allows 20 requests a minute, which is what the cache
keeps a batch run under.

Slack followed, and cost one adapter file plus one line in `src/contextRegistry.ts`, which is what the
port was built first to buy. Its search behaves differently enough from Pylon's to be worth writing
down: `after:`/`before:` exclude the day they name, a range that excludes everything is ignored rather
than obeyed (the search answers as if no dates were given), several `in:` terms are OR, the identifier
search is fuzzy so a match only counts as linked once the text is confirmed to contain the identifier,
and Linear's own bot posts carry no `text` at all. The wider net refuses to run on a date range alone,
because that is every message in the workspace for a fortnight.

`deno task cli context --project <file>` answers a whole list in one run, taking each issue's window
from its own `createdAt` (now recorded by ingest) and holding each source to its published call budget
through `paced`. The window snaps to its UTC day, so issues filed the same day share one lookup and the
cache serves the rest. A capture taken before ingest recorded `createdAt` gives every issue the same
window, which is a re-ingest away from being right.

What is left:

1. **A third adapter** (GitHub PRs), same shape as Pylon and Slack, when a real use case wants it.
   Spike its shape via the MCP connector inside a session per
   [ADR 0007](adr/0007-productization-and-domains.md), then productionize behind the port with a direct
   REST/GraphQL call and a secret from `src/secrets.ts`; never commit a real credential or a real
   ticket's content (ADR 0003).

2. **Do not hardcode a label name, a workspace name, or a company name anywhere in this layer.**
   "Needs Info" (or whatever a workspace calls its label for "not enough information to act"), and the
   choice to check a context source only when an issue is unlinked and cast a wider net by date range,
   are triage _policy_ — they belong in the prompt or script that calls `context`, not in tlr. If a
   follow-up session is tempted to add a `--policy triage` flag or similar, that is the signal this
   boundary is being crossed; keep tlr answering "what do you know," and leave "what should I do about
   it" to the caller.

## Done — team-wide capture

`standup` answered for one project because the snapshot store is keyed per project
([adr/0006](adr/0006-normalized-tracker-schema.md)), so the roll-up grouped by milestone and work on no
project at all could not appear: unfiled tickets were 29% of a recent cycle's open scope on the real
workspace.

`deno task issues --team DEV` now ingests every issue on a team into its own data file, keyed
`team:<id>`, and `standup` groups a team snapshot by project with an explicit bucket for work on none.
Cycle-hop history needed nothing new, as expected, because it comes from each issue's own history. The
scheduled run refreshes a team file the same way it refreshes a project one.

Two things a follow-up should know. Linear has no team-wide milestone, so a team snapshot's milestone
block is empty and every milestone-shaped view stays project-only. And the estimate scale and workflow
states come from the one team, where a project ingest pools them across every team it touches.

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

Narrower than this, and now built: the candidate-net search in a
[context source](adr/0011-context-sources.md) covers one external system, one time window, and unlinked
issues only. This stays tabled.

## Known issues

Small and self-contained. None of them break a user-facing path today.

- **`--muted` is never defined.** `web/style.css` reads `var(--muted)` in ten places, but no flavor in
  `web/lib/theme.js` supplies it and it is not in `SEMANTIC`, so the declaration is invalid and those
  elements fall back to the inherited `--text`. They pass the contrast scan by accident. Defining it
  would repaint `rm-chain-dim`, `bal-dim`, and the rest, some on pages `a11y.spec.ts` scans, so pair the
  fix with a run of that suite
- **`web/style.css` fails `deno fmt`.** Roughly forty declarations write a bare-decimal `.04em` or `.28`
  where the formatter wants a leading zero. It is the one file the check reports and predates the
  formatter landing. A single `deno fmt web/style.css` clears it, at the cost of touching many lines
- **The project-picker test does not switch projects.** `pages.spec.ts` asserts the picker renders with
  both stubbed entries, but nothing exercises the `onchange` navigation its name promises. Switching
  reloads onto the second project's data file, so covering it means confirming the review page still
  renders from `seed-a.json` without tripping the zero-console-errors fixture
- **`copier update` re-seeds four files.** `_skip_if_exists` only skips a file that is already there, so
  every update recreates `src/routes.ts` and `src/templates/`, which this repo deleted on purpose
  (templates live in `web/`). Delete them again after each update, or fix it template-side

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
