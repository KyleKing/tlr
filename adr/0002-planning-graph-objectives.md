# 0002 — Objectives for the planning graph

- Status: accepted
- Date: 2026-07-23

## Context

Idea one was a Gantt-style view showing relationship, ordering, and delivery timelines that Linear
lacks. Before designing it, we looked at the real data for the Contractual Product Uptime project
(66 issues):

- Per-issue dates barely exist: 1 of 66 has a due date, 9 have a started date. A classic
  date-anchored Gantt cannot be drawn from stored fields
- Estimates are rich: 55 of 66 carry points. This is the sizing signal
- Milestones carry the time structure: four milestones with target dates, plus a project start
- Dependencies are real: 18 `blocks` edges across 13 issues, plus `related` links. Not returned by
  the list endpoint, but present per issue
- Sub-issues are rare: 3 of 66 have a parent

The goal the user stated: look at the mapping and build a mental model of what is being worked on
when. See complexity, missing order or blocking relations, and over-allocation to a person based on
estimates (and later their calendar time off), with unscheduled work grouped as backlog.

## Decision

Build a capacity- and dependency-aware board, not a date Gantt. Objectives, in priority order:

1. Show load per person per time bucket (cycle for the near term, milestone for the horizon,
   backlog for the rest) against an adjustable capacity, so over-allocation is visible
2. Encode load with position and fill, not repeated numbers (Tufte data-ink). Milestone capacity
   scales by weeks in the window
3. Surface the blocking graph and flag ordering risk, where a blocker finishes after the work it
   blocks
4. Flag low-quality ticket text (slop) and missing planning fields, the latter only when a ticket is
   already committed to a cycle
5. Stay interactive: search, pinnable filters, and compact-versus-expanded density

Any derived schedule is labeled a forecast, never presented as a real date.

## Consequences

- The view answers "does this milestone fit before its date, and who is overloaded" rather than
  "what day does each ticket start"
- The blocking overlay is honest about coverage: many tickets have no relations, so absence of an
  arrow is not proof of no dependency
- A true date-based Gantt is rejected for this data. It could return if issues gain start and due
  dates

## Alternatives considered

- Milestone capacity bands only (no per-person, no dependencies): simpler, but misses over-allocation
  and ordering, which are the point
- Dependency DAG / PERT network with critical path: strong for ordering, weak for capacity, and
  sparse here because relations are thin. Kept as a later companion view, not the primary
