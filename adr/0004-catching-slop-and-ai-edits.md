# 0004 — Catching slop and reviewing AI edits

- Status: accepted
- Date: 2026-07-23

## Context

Two related needs. First, catch low-quality ticket text before a wider audience sees it. The real
problem is the writing: long tickets, or ones with obvious tells (em dashes, semicolons, stock
phrases, checklists, walls of text). Second, review edits an AI made on the user's behalf, and
separately, see what the user recently changed.

Linear's history records an actor and a bot actor, so in principle AI actions are separable. But the
AI here edits through the Linear MCP under the user's own account, so both AI and human edits carry
the same actor. Actor filtering cannot tell them apart.

## Decision

Slop: scan ticket description text for tells (dashes, semicolons, checklists, length, a stock-phrase
list) and score each ticket. Surface it as a flag and a filter. Missing planning fields (no estimate,
assignee, or milestone) are flagged too, but only count as blocking when the ticket is already in a
cycle. Logic lives in `slopScan` and `missingData` in `web/lib/planning.js`, with tests.

A flag is a heuristic, so a false positive needs a human override. Marking a ticket "not slop" stores
a hash of its text (`slopHash`) in browser localStorage and clears the flag. The flag returns if the
text changes, because the stored hash no longer matches. This keeps a reviewed judgement without
committing any ticket data to the repo.

AI-edit review: do not rely on actor attribution. Record intent at write time with a Claude Code hook
that logs what a batch changed, and reconcile that against a local snapshot diff. "What I recently
changed" comes from the same snapshot diff.

## Consequences

- Slop detection is a heuristic and needs tuning. On the current data, 33 of 48 shown tickets flag,
  which is likely too sensitive to be useful yet
- The hook is the source of truth for AI edits, not the Linear API, so edits made outside a hooked
  session are not attributed
- Both features depend on the Phase 1 snapshot store
