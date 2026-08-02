# 0012 — Work streams

- Status: proposed (placeholder, decides nothing)
- Date: 2026-08-01

## Context

The author orients by work stream. When a lot of similar-looking changes are in flight, the question
that sorts them is which thread each one belongs to, and none of the groupings tlr has answers it.
A milestone is a delivery commitment with a date. A cycle is time. A project is a scope boundary. A
chain is a dependency relation. An assignee is a person. Two tickets can share all five and still
belong to different threads, and one thread routinely spans several milestones and owners.

The same concept wants to exist in three places at once, which is why it needs a decision rather
than an implementation:

- In tlr, as a grouping over Linear issues, so the board, the diff, and the weekly update can be read
  a stream at a time
- In `yak-shears`, as the thread a note belongs to, so notes taken about a stream stay findable next
  to the work
- In what goes to leadership, as the unit the narrative is told in, since a stream is closer to what
  leadership tracks than a ticket is

Working definition, to be argued with: a stream is a durable thread of related work, longer-lived
than a cycle, narrower than a project, and independent of any single milestone.

## Open questions

- Where a stream is defined. A Linear label is the only option all three surfaces can already see,
  and labels are flat, unowned, and go stale. A tlr-local definition stays clean and is invisible to
  everyone else. A definition that lives in notes inverts which tool is authoritative
- Whether membership is hand-maintained or derived. Derived (from title text, milestone, or chain
  membership) drifts less but will not match the thread the author actually has in mind, which is
  the whole point of the concept
- Whether a ticket belongs to one stream or several. One is far easier to render and to total
  capacity against; several is probably the truth
- Whether streams replace milestones as the spine of the weekly update, sit beside them, or only
  group the at-risk section
- How a stream stays coherent across three tools that do not talk to each other, and whether that is
  a shared name, a shared id, or nothing at all
- Whether the names leadership sees are the same names used internally

## Decision

None yet. This records the concept and the questions so the next person to reach for a grouping does
not invent a fourth one. Nothing should be built against it until the questions above are answered,
and the first thing to settle is where a stream is defined, because the other answers follow from it.

Whatever lands has to respect [0009](0009-scope-boundaries.md): if the grouping is something Linear
can already express and show, it belongs in Linear and tlr only reads it.
