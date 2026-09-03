# Roadmap

Rewritten 2026-09-02 after an audit of the Deno app. The decisions it rests on are in
[DECISIONS.md](DECISIONS.md), the sourced research in [RESEARCH.md](RESEARCH.md).

## Why tlr exists

Linear and Pylon each know the current state of their own tickets. Neither answers the questions I
carry into three recurring meetings:

- Daily triage. Which support ticket do we look at next, is engineering already on it, and who has room
  to take it
- Standup and cycle planning. Who is over their real capacity this week once on-call, days out,
  meetings, and review load are counted, and what carried over from last cycle and why
- Reporting up. Are we spending the right share of the team on customer work versus product, is the
  backlog getting older or younger, and will the milestone land

tlr answers those from the two systems' APIs plus a calendar and an on-call roster, in a terminal, in
the few minutes before or during the meeting. Anything Linear or Pylon already shows in their own views
is out of scope. Anything that needs a hosted service, a second tracker, or an MCP server is out of
scope.

## Where the Deno app stands

The audit ran the whole thing. Type check, 456 unit tests, lint, and 51 end-to-end tests pass, and the
hourly snapshot job has run unattended for a month. Under that, the daily paths do not hold:

- Every bare CLI command crashes on a default data file that does not exist, and `--help` is parsed as
  a positional argument. `review` writes a SQLite file into the current directory
- `standup` recomputes velocity and takes a manual out-of-office list instead of the deflated capacity
  the rest of the code uses, so there are two capacity truths and the newer one is worse
- Unestimated tickets are silently counted as zero in `capacity`, `diff`, `forecast`, and `export`. On
  the real workspace 32 of 62 unfiled tickets had no estimate, so every total is a floor
- Balance hardcodes two real people's names and thirty-odd workspace keywords in `src/commands/balance.ts`.
  That is a public repo carrying employer vocabulary and has to go regardless of the rebuild
- No command emits markdown. The one real deliverable so far (a standup sheet) was hand-copied from JSON
- 787 lines under `web/proto/` are wired to nothing, and `scripts/gh_merge_ui.py` belongs to another
  project
- The docs said the same things in five places and disagreed about which CLI commands exist

What did work, and what the rebuild keeps as design rather than code: per-person capacity deflated by
on-call and calendar, chain risk measured against owner velocity, provenance-aware refresh merging, the
context-source port with its Pylon and Slack adapters, reading cycle hops from Linear's own history,
and keeping every real ticket out of the repo.

## Keep, drop, rebuild

| Capability                          | Call                  | Reason                                                        |
| ----------------------------------- | --------------------- | ------------------------------------------------------------- |
| Per-person deflated capacity        | Rebuild               | Nothing native or adjacent does it per person                 |
| Chain risk from blocking graph      | Rebuild, later        | Linear has no transitive rollup                               |
| Rebalancing proposal                | Rebuild, later        | No tool proposes per-person moves at planning time            |
| Milestone-level slip forecast       | Rebuild, narrow       | Linear draws project-level; milestone stays open              |
| Context sources (Pylon, Slack)      | Rebuild               | Same port, same query shapes, Python client                   |
| Snapshot store and plan diff        | Narrow                | Linear history covers most of it; keep milestone scope        |
| Slop scan                           | Port as a small check | Cheap, and no one else sells it                               |
| Review queue for bulk AI edits      | Drop for now          | Linear agent sessions and text attribution changed the ground |
| Weekly-update narrative             | Drop                  | Linear writes it with an agent now                            |
| Duplicate detection spike           | Drop                  | Linear Triage Intelligence, and triage merges by hand         |
| Web app, Vento templates, e2e suite | Drop                  | TUI replaces it                                               |
| Balance affinities, hardcoded names | Drop                  | Employer-specific in a public repo                            |
| Hosted deployment plan              | Drop                  | Single-user TUI has nothing to host                           |
| Slidev theme and `deno task deck`   | Keep as is            | Unrelated to the rebuild, used for talks                      |

## Phases

Each phase ends with something I use in a real meeting that week. A phase that does not is too big.

### 0. Cut the docs and freeze the Deno app (this change)

DECISIONS.md replaces `adr/`, RESEARCH.md holds the research, the plan and notes files are gone, and
this file carries everything open. The Deno code stays on `main` untouched until phase 2 replaces its
snapshot job, because that job is the only thing capturing milestone scope over time today.

### 1. A Python core and a CLI that agents can drive

A `tlr` package with one source adapter per system (Linear GraphQL, Pylon REST, Incident.io, Google
Calendar free/busy, GitHub PR review activity), a DuckDB file under the user's data directory, and a
CLI where every command prints JSON by default and markdown with `--format md`. Pure functions take
frames and return frames so tests need no network. API fixtures come from pytest-recording with
credentials scrubbed.

Config is a TOML file outside the repo with a committed sample: workspace ids, the Pylon custom field
that holds the Linear identifier, the priority field's values, customer tiers, SLA targets, exclusion
rules, and thresholds. Nothing about my employer appears in code.

Done when `tlr capacity --format md` pastes into a standup doc with an unestimated count beside every
points total, and `tlr --help` works.

### 2. Triage queue

One ordered list across Pylon and Linear for the daily triage meeting, ordered by rules from config:
priority field first, then customer tier, then age and distance to the SLA target. Each row shows the
Pylon age in days, its priority, the linked Linear issue and state or a missing-link flag, and whether
it is waiting on the customer. Rows can be marked outside the ordering (feature request allowed to age,
config work that stays in Pylon, waiting on customer) and still listed under their own heading.

Backlog health beside the list: count over 30, 60, and 90 days with day-over-day delta, P50 and P95
close time against the configured targets, tickets in progress past a threshold, and week-over-week
active count so a jump from logging more tickets reads differently from a jump in real problems.

The Pylon adapter already exists in the Deno code; its filter shapes and rate limit (20 issue searches
a minute) carry over. Done when the meeting runs from tlr instead of the Pylon queue view.

### 3. Allocation ledger and honest capacity

Record allocation as dated events per person per cycle: assigned, estimate set, moved between cycles,
handed off for review, done. Assignment, estimate, cycle, and state come from Linear's `IssueHistory`
on first ingest. Handoff comes from the PR open and review-requested events on the linked GitHub PR,
which is the narrow GitHub read DECISIONS.md allows.

From the ledger, derive per person per cycle: points allocated, points delivered, points waiting on
someone else, planned versus arrived mid-cycle (carry-over classified by whether the issue existed at
cycle start), commitment accuracy against the 80 to 90 percent band, and cycle hops per issue. Deflate
capacity by on-call weeks, calendar out-days, meeting hours from the same calendar, and review load
from PR review counts. Each deflation is a separate column so the number can be argued with.

Done when the ticket that sat two cycles in review charges its owner once, and the standup capacity
table shows meeting and review load as its own lines.

### 4. The TUI

Textual app with vim-style motion, per-screen key maps rendered in a footer, and chartui for the
capacity heat, backlog age, and trend charts. Screens: triage queue, capacity by person and cycle,
backlog health, and a presenter mode that hides the key hints and enlarges type for screen sharing.
Every read comes from the DuckDB file, so opening is instant and a refresh is an explicit action
whose age shows on screen.

Writes, if any, stay behind a preview the user confirms in the TUI. The first candidates are the ones
triage does by hand today: set the Pylon-to-Linear link and set priority or cycle on the Linear issue.
Neither ships until the read side has been in daily use.

### 5. Reporting up

Markdown and chart output for the weekly and monthly view: customer work versus product work share
over time, backlog age trend, commitment accuracy, and per-milestone forecast from deflated capacity.
Chain risk and the rebalancing proposal come back here, ported from the Deno planning code once the
ledger gives them better inputs than a sum of open estimates.

## Open questions

- Which GitHub events count as review load: reviews submitted, or review requests received, or both.
  Check against a real month before choosing
- Meeting hours from the calendar need a rule for what counts (declined, optional, focus blocks). Start
  with accepted events from other people and refine
- Where a "stream" is defined, if the work-streams idea comes back
- Whether the review queue for bulk AI edits returns keyed on Linear agent sessions, once I see how
  those appear in the API
- Linear plan tier decides whether Triage Intelligence and SLAs are available to the team, which
  decides how much of phase 2's health metrics tlr must compute itself

## Not doing

Recorded in [DECISIONS.md](DECISIONS.md) under Superseded and Rejected: an MCP server, CLI writes,
hosting, a second tracker, cross-project load views, stale-issue detection, duplicate detection, and
update prose generation.
