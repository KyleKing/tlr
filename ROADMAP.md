# Roadmap

Rewritten 2026-09-02 after an audit of the Deno app.
The decisions it rests on, with the sources behind
them, are in [DECISIONS.md](DECISIONS.md).

## Why tlr exists

Linear and Pylon each know the current state of their own tickets.
Neither answers the questions I
carry into three recurring meetings:

- Daily triage. Which support ticket do we look at next, is engineering or an agent
    already on it, and
    who has room to take it
- Standup and cycle planning. What are this pod's goals for the next two weeks, who is
    over their real
    capacity once on-call, days out, meetings, and review load are counted, and what carried
    over from
    last cycle and why
- Reporting up. Are we spending the right share of the team on customer work versus
    product, is the
    backlog getting older or younger, and will the milestone land

tlr answers those from the two systems' APIs plus a calendar and an on-call roster, in a
terminal, in
the few minutes before or during the meeting.
The terminal matters because I screen-share it: during a
call I will not switch between a terminal and Chrome, so anything the meeting needs has
to be on one
screen, and anything I only do alone (bulk edits, one-off queries) stays with the Linear
MCP in Claude
Code.
Anything Linear or Pylon already shows in their own views is out of scope.
Anything that needs a
hosted service, a second tracker, or an MCP server is out of scope.

## Where the Deno app stands

The audit ran the whole thing. Type check, 456 unit tests, lint, and 51 end-to-end tests
pass, and the
hourly snapshot job has run unattended for a month.
Under that, the daily paths do not hold:

- Every bare CLI command crashes on a default data file that does not exist, and `--help`
    is parsed as
    a positional argument.
    `review` writes a SQLite file into the current directory
- `standup` recomputes velocity and takes a manual out-of-office list instead of the
    deflated capacity
    the rest of the code uses, so there are two capacity truths and the newer one is worse
- Unestimated tickets are silently counted as zero in `capacity`, `diff`, `forecast`, and
    `export`.
    On
    the real workspace 32 of 62 unfiled tickets had no estimate, so every total is a floor
- Balance hardcodes two real people's names and thirty-odd workspace keywords in
    `src/commands/balance.ts`.
    That is a public repo carrying employer vocabulary and has to go regardless of the
    rebuild
- No command emits markdown. The one real deliverable so far (a standup sheet) was
    hand-copied from JSON
- 787 lines under `web/proto/` are wired to nothing, and `scripts/gh_merge_ui.py` belongs
    to another
    project
- The docs said the same things in five places and disagreed about which CLI commands
    exist

What did work, and what the rebuild keeps as design rather than code: per-person
capacity deflated by
on-call and calendar, chain risk measured against owner velocity, provenance-aware
refresh merging, the
context-source port with its Pylon and Slack adapters, reading cycle hops from Linear's
own history,
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
| Slidev theme and `deno task deck`   | Drop                  | Moved out of tlr; the rebuild has no deck path                |

## Phases

Each phase ends with something I use in a real meeting that week.
A phase that does not is too big.

Phases 0, 1, and 2 have shipped, so their entries are gone from this file and the
numbering
below stays put.
What they left behind: the Deno app and the app-template scaffolding are
deleted, `tlr` is a Python package scaffolded from calcipy_template, a DuckDB store
under the
user's data directory carries Linear and Pylon rows with per-field provenance, and
`tlr capacity`, `tlr triage`, `tlr backlog`, and `tlr import-snapshots` all run and
print JSON
by default or markdown with `--format md`.
`git log` is the record of how.

Two things those phases did not finish, both waiting on a decision rather than on code.
Customer
tier has no source, because this Pylon workspace has no tier field:
`[tiers].account_tier_field`
names whichever account field ends up carrying one, and until it is set the tier
ordering rule
does nothing.
And no cassette has been recorded yet, so the scrubber has never run against a real
payload.
Both are written up in [docs/api-notes.md](docs/api-notes.md).

### 3. Goals

Linear has no object for what a pod is trying to get done in the next two weeks.
Ordering projects in
the Linear view is noisy, project descriptions have to stay evergreen, and project
updates are
retroactive or point-in-time.
Today pod leads write goals as prose, and I want them repeated at every
meeting with people organizing their work around them, balanced against incoming bugs
and on-call.

tlr reads goals from wherever the workspace keeps them (a Linear Document per pod is the
current
guess, with the document id in config) and shows each goal with the issues attached to
it, their
owners, their state, and the owners' remaining capacity.
A goal with no open issue, or whose issues
cannot fit their owners' capacity before its horizon, is flagged.
The same screen is what standup opens
on and what the presenter view shows first.

How an issue attaches to a goal is the open question: a label, a project, a parent
issue, or a line in
the document.
Start by reading whatever the pods already do and make tlr follow it rather than adding
a
convention.
Done when a standup runs from this screen for two weeks and nobody opens the document.

### 4. Allocation ledger and honest capacity

Record allocation as dated events per person per cycle: assigned, estimate set, moved
between cycles,
handed off for review, done.
Assignment, estimate, cycle, and state come from Linear's `IssueHistory`
on first ingest.
Handoff comes from the PR open and review-requested events on the linked GitHub PR,
which is the narrow GitHub read DECISIONS.md allows.

From the ledger, derive per person per cycle: points allocated, points delivered, points
waiting on
someone else, planned versus arrived mid-cycle (carry-over classified by whether the
issue existed at
cycle start), commitment accuracy against the 80 to 90 percent band, and cycle hops per
issue.
Deflate
capacity by on-call weeks, calendar out-days, meeting hours from the same calendar, and
review load
from PR review counts.
Each deflation is a separate column so the number can be argued with.

Done when the ticket that sat two cycles in review charges its owner once, and the
standup capacity
table shows meeting and review load as its own lines.

### 5. The TUI

Textual app with vim-style motion, per-screen key maps rendered in a footer, and chartui
for the
capacity heat, backlog age, and trend charts.
Screens: goals, triage queue, capacity by person and
cycle, backlog health, and a presenter mode that hides the key hints and enlarges type
for screen
sharing.
Every read comes from the DuckDB file, so opening is instant and a refresh is an
explicit
action whose age shows on screen.

Writes stay behind a preview the user confirms in the TUI, and are limited to what I do
live in a
meeting: link a Pylon ticket to a Linear issue, set priority, estimate, cycle, project,
milestone, or
assignee, and attach an issue to a goal.
Bulk and solo edits stay with the Linear MCP.
None of the
writes ship until the read side has been in daily use.

### 6. Editing with completions

Editing a description, an estimate, or an assignee during a call needs completion for
account names,
projects, milestones, and estimate values, and it needs the ticket's context (capacity,
goal, linked
Pylon ticket) visible beside the text.
The TUI's own input widgets will not match nvim, so the plan is
to open the field in nvim from the TUI, the way second-look plans an nvim frontend over
the same CLI,
with a language server that completes from the DuckDB file and answers hover with the
context panel.
Whether that is a real LSP or an nvim plugin shelling out to `tlr` for completions is
undecided.
Nothing
here is built before phase 5 is in daily use.

### 7. Reporting up

Markdown and chart output for the weekly and monthly view: customer work versus product
work share
over time, backlog age trend, commitment accuracy, goal completion per pod, and
per-milestone forecast
from deflated capacity.
Chain risk and the rebalancing proposal come back here, ported from the Deno
planning code once the ledger gives them better inputs than a sum of open estimates.

## Open questions

- Where goals live and how issues attach to them (phase 3).
    Read what the pods do first
- Which GitHub events count as review load: reviews submitted, or review requests
    received, or both.
    Check against a real month before choosing
- Meeting hours from the calendar need a rule for what counts (declined, optional, focus
    blocks).
    Start
    with accepted events from other people and refine
- Which account field stands in for customer tier.
    This Pylon workspace has no tier field, and the
    candidates are `lifecycle` and annual revenue.
    Until one is chosen the triage queue lists every
    account at the default tier
- How an agent-owned ticket is recognized.
    Pylon answers this natively through a dozen
    `issue_ai_agent_*` filter attributes, none of which appeared on the record I read,
    because it had no
    agent on it.
    tlr matches a configured id list instead, on both the Pylon and the Linear side, so the
    open part is what those fields look like on a ticket an agent did touch
- Editor integration: a language server or an nvim plugin over the CLI (phase 6)
- Where a "stream" is defined, if the work-streams idea comes back
- Whether the review queue for bulk AI edits returns keyed on Linear agent sessions, once
    I see how
    those appear in the API
- Linear plan tier decides whether Triage Intelligence and SLAs are available to the team,
    which
    decides how much of the health metrics tlr must keep computing itself
- Whether `POST /issues/search` takes its cursor as a query parameter the way the
    documented `GET`
    endpoints do, and whether those `GET` endpoints share the 20-searches-a-minute budget.
    A search stuck
    on page one is how the first would show up

## Not doing

Recorded in [DECISIONS.md](DECISIONS.md) under Superseded and Rejected: an MCP server,
CLI writes,
hosting, a second tracker, cross-project load views, stale-issue detection, duplicate
detection, and
update prose generation.
