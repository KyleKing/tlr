# 0010 — Work states and the shelf

- Status: accepted
- Date: 2026-08-01

## Context

An older sketch of the author's, `shoal/dev_boards`, described a tabbed TUI over whatever tracker a
team used. It was mostly README-driven and only one piece was ever built (a Textual app that merged
approved GitHub PRs), but the model behind it predates tlr and is worth settling here rather than
rediscovering.

The sketch split work into five states, each a tab:

- Spike: what is being worked on right now, timed
- Shelf: work handed off and waiting on someone else, code review or a design
- Sprint: this week's items
- Queue: everything planned
- Explore: search across sources

Its stated goal was a screen that only shows work that could be picked up, with everything else out
of the way.

Four of the five are Linear's own views, and [0009](0009-scope-boundaries.md) already points those
back at Linear. Shelf is the exception, and it names a real gap in tlr's model rather than a missing
view.

## Decision

### Shelf is a capacity state, not a tab

Chain risk charges a chain's points to the people who own its tickets, and
[0005](0005-capacity-realism.md) deflates a person's cycle for on-call and out-days. Both assume the
assignee is what the work is waiting on. A ticket parked in review is waiting on a reviewer, so
counting its points against its owner's cycle overstates that person's load and understates their
room for new work.

Treat "waiting on someone else" as a third deflation input alongside on-call and out-days, sourced
the same way the others are: from a field the tracker already has, refreshed by a task, and shown on
the cell with its own marker so the number explains itself. Which Linear signal stands in for it (a
workflow state in the review category, a label, or a stale `startedAt` under an unchanged state) is
open, and picking one needs a look at how the real project actually marks handoff.

This is unbuilt. It is recorded here so the next capacity change starts from the right model.

### The pickup view stays out

No tab, page, or filter whose job is "what could I pick up". Linear's own views cover unassigned and
ready work, and a second one in tlr would be the cross-project load view
[0009](0009-scope-boundaries.md) already rules out, wearing a different name.

### Shelf state does not come from GitHub

The sketch read handoff straight from `gh search prs`, which is the truest source: a PR with a
pending review is unambiguous where a Linear state is a convention. It is still a GitHub adapter, and
[0009](0009-scope-boundaries.md) rules that out. Reopening it would mean a second identity map
(Linear person to GitHub login), a link between issue and PR that nothing maintains today, and an
ingest path that fails differently from the tracker's. The Linear-side signal is weaker and costs
none of that.

## Consequences

- A person's effective capacity gets a third factor, so the board's "over" badge fires later and, on
  a team that hands off a lot, considerably later
- Chain risk softens where a chain sits in review, which is the case most likely to be flagged today
  and least likely to be the owner's problem
- Deciding the signal needs real data, not a seed fixture, because seed data has no handoff behavior
- Shelf shares the provenance rules already in [0005](0005-capacity-realism.md): the refresh owns
  what it wrote, a hand-typed value is never silently overwritten
