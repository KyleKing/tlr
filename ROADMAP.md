# Roadmap

Rewritten 2026-09-02 after an audit of the Deno app. The decisions it rests on, with the sources behind
them, are in [DECISIONS.md](DECISIONS.md).

## Why tlr exists

Linear and Pylon each know the current state of their own tickets. Neither answers the questions I
carry into three recurring meetings:

- Daily triage. Which support ticket do we look at next, is engineering or an agent already on it, and
  who has room to take it
- Standup and cycle planning. What are this pod's goals for the next two weeks, who is over their real
  capacity once on-call, days out, meetings, and review load are counted, and what carried over from
  last cycle and why
- Reporting up. Are we spending the right share of the team on customer work versus product, is the
  backlog getting older or younger, and will the milestone land

tlr answers those from the two systems' APIs plus a calendar and an on-call roster, in a terminal, in
the few minutes before or during the meeting. The terminal matters because I screen-share it: during a
call I will not switch between a terminal and Chrome, so anything the meeting needs has to be on one
screen, and anything I only do alone (bulk edits, one-off queries) stays with the Linear MCP in Claude
Code. Anything Linear or Pylon already shows in their own views is out of scope. Anything that needs a
hosted service, a second tracker, or an MCP server is out of scope.

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

DECISIONS.md replaces `adr/`, the plan and notes files are gone, and this file carries everything open.
The Deno code stays on `main` untouched until phase 2 replaces its snapshot job, because that job is the
only thing capturing milestone scope over time today.

### 1. A Python core and a CLI that agents can drive

A `tlr` package with one source adapter per system (Linear GraphQL, Pylon REST, Incident.io, Google
Calendar free/busy, GitHub PR review activity), a DuckDB file under the user's data directory, and a
CLI where every command prints JSON by default and markdown with `--format md`. Pure functions take
frames and return frames so tests need no network. API fixtures come from pytest-recording with
credentials scrubbed.

Config is a TOML file outside the repo with a committed sample: workspace ids, the Pylon custom field
that holds the Linear identifier, the priority field's values, customer tiers, SLA targets, exclusion
rules, thresholds, and which Linear accounts are agents. Nothing about my employer appears in code.

Done when `tlr capacity --format md` pastes into a standup doc with an unestimated count beside every
points total, and `tlr --help` works.

### 2. Triage queue

One ordered list across Pylon and Linear for the daily triage meeting, ordered by rules from config:
priority field first, then customer tier, then age and distance to the SLA target. Each row shows the
Pylon age in days, its priority, the linked Linear issue and state or a missing-link flag, whether it
is waiting on the customer, and whether an agent is already on it (assigned to an agent account, or
carrying an open agent session), so the meeting skips those rows. Rows can be marked outside the
ordering (feature request allowed to age, config work that stays in Pylon, waiting on customer) and
still listed under their own heading.

Backlog health beside the list: count over 30, 60, and 90 days with day-over-day delta, P50 and P95
close time against the configured targets, tickets in progress past a threshold, week-over-week active
count so a jump from logging more tickets reads differently from a jump in real problems, and resolved
split by human versus agent. The last one is cheap now and expensive to retrofit once hosted agents
start closing the easy tickets.

The Pylon adapter already exists in the Deno code; its filter shapes and rate limit (20 issue searches
a minute) carry over. Done when the meeting runs from tlr instead of the Pylon queue view.

### 3. Goals

Linear has no object for what a pod is trying to get done in the next two weeks. Ordering projects in
the Linear view is noisy, project descriptions have to stay evergreen, and project updates are
retroactive or point-in-time. Today pod leads write goals as prose, and I want them repeated at every
meeting with people organizing their work around them, balanced against incoming bugs and on-call.

tlr reads goals from wherever the workspace keeps them (a Linear Document per pod is the current
guess, with the document id in config) and shows each goal with the issues attached to it, their
owners, their state, and the owners' remaining capacity. A goal with no open issue, or whose issues
cannot fit their owners' capacity before its horizon, is flagged. The same screen is what standup opens
on and what the presenter view shows first.

How an issue attaches to a goal is the open question: a label, a project, a parent issue, or a line in
the document. Start by reading whatever the pods already do and make tlr follow it rather than adding a
convention. Done when a standup runs from this screen for two weeks and nobody opens the document.

### 4. Allocation ledger and honest capacity

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

### 5. The TUI

Textual app with vim-style motion, per-screen key maps rendered in a footer, and chartui for the
capacity heat, backlog age, and trend charts. Screens: goals, triage queue, capacity by person and
cycle, backlog health, and a presenter mode that hides the key hints and enlarges type for screen
sharing. Every read comes from the DuckDB file, so opening is instant and a refresh is an explicit
action whose age shows on screen.

Writes stay behind a preview the user confirms in the TUI, and are limited to what I do live in a
meeting: link a Pylon ticket to a Linear issue, set priority, estimate, cycle, project, milestone, or
assignee, and attach an issue to a goal. Bulk and solo edits stay with the Linear MCP. None of the
writes ship until the read side has been in daily use.

### 6. Editing with completions

Editing a description, an estimate, or an assignee during a call needs completion for account names,
projects, milestones, and estimate values, and it needs the ticket's context (capacity, goal, linked
Pylon ticket) visible beside the text. The TUI's own input widgets will not match nvim, so the plan is
to open the field in nvim from the TUI, the way second-look plans an nvim frontend over the same CLI,
with a language server that completes from the DuckDB file and answers hover with the context panel.
Whether that is a real LSP or an nvim plugin shelling out to `tlr` for completions is undecided. Nothing
here is built before phase 5 is in daily use.

### 7. Reporting up

Markdown and chart output for the weekly and monthly view: customer work versus product work share
over time, backlog age trend, commitment accuracy, goal completion per pod, and per-milestone forecast
from deflated capacity. Chain risk and the rebalancing proposal come back here, ported from the Deno
planning code once the ledger gives them better inputs than a sum of open estimates.

## Open questions

- Where goals live and how issues attach to them (phase 3). Read what the pods do first
- Which GitHub events count as review load: reviews submitted, or review requests received, or both.
  Check against a real month before choosing
- Meeting hours from the calendar need a rule for what counts (declined, optional, focus blocks). Start
  with accepted events from other people and refine
- How an agent-owned ticket is recognized: assignee account, agent session, or a label. Depends on how
  watch-doggo's jobs show up in Linear
- Editor integration: a language server or an nvim plugin over the CLI (phase 6)
- Where a "stream" is defined, if the work-streams idea comes back
- Whether the review queue for bulk AI edits returns keyed on Linear agent sessions, once I see how
  those appear in the API
- Linear plan tier decides whether Triage Intelligence and SLAs are available to the team, which
  decides how much of phase 2's health metrics tlr must compute itself

## Not doing

Recorded in [DECISIONS.md](DECISIONS.md) under Superseded and Rejected: an MCP server, CLI writes,
hosting, a second tracker, cross-project load views, stale-issue detection, duplicate detection, and
update prose generation.
