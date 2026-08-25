# 0011 — Context sources: a read-only enrichment layer

- Status: proposed
- Date: 2026-08-24

## Context

Triage work (deciding priority, disposition, and whether a ticket has enough information to act on)
needs facts a tracker does not hold: a linked support ticket's own priority and resolution, a Slack
thread from around when the issue was filed, a GitHub PR that fixed or attempted to fix it. Today that
means an agent makes several live API calls per issue (one search per source, sometimes more) to
reconstruct context that a second issue filed the same week, by the same reporter, about the same area
would need again from scratch. That cost is what an unattended batch run over a few hundred issues
turns into millions of tokens: most of it is round-trip tool calls and re-reading the same kind of
lookup, not the judgment call at the end.

[ADR 0009](0009-scope-boundaries.md) rules out a GitHub adapter or any third tracker, on the grounds
that Linear's own views cover planning across trackers and tlr exists for what Linear cannot show. That
line stands. A **context source** is not a tracker: it never gains a planning-graph identity, never
joins a snapshot, is never diffed, and is never assigned a cycle or capacity. It answers one question —
"what does this external system say about this issue, or about this window of time" — and nothing else.
This ADR adds that as a fifth port alongside `TrackerSource`, `CapacitySource`, `SecretStore`, and
`SnapshotStore` from [ADR 0007](0007-productization-and-domains.md), and narrows ADR 0009's ban to
trackers specifically, not read-only enrichment.

## Decision

### The port

```ts
interface ContextSource {
  readonly name: string // "pylon", "slack", "github-prs", ... — never hardcoded elsewhere
  search(query: ContextQuery): Promise<ContextItem[]>
}

type ContextQuery = {
  // Prefer a source's own ticket/link when one exists (source, e.g. Pylon's linear_ticket field on
  // its issues, or a GitHub PR that references the identifier in its body).
  linkedId?: { source: string; id: string }
  // Otherwise cast the wider net the source supports: text similarity plus a time window anchored on
  // the tlr issue's createdAt, narrowed by any known reporter/customer identity.
  text?: string
  window?: { start: string; end: string } // ISO 8601, ~createdAt +/- N days
  actor?: string // reporter email or handle, when known
  limit?: number
}

type ContextItem = {
  source: string
  id: string
  url: string
  title?: string
  body: string
  author?: string
  createdAt: string
  // "linked": the source itself recorded the connection (a custom field, a PR body reference).
  // "candidate": found by the wider text/time/actor net, unconfirmed.
  matchKind: "linked" | "candidate"
}
```

`search` is the only method. A context source never writes, never authenticates a second time per
call (the adapter owns its own client and rate limiting), and never becomes queryable by planning code
— nothing in `web/lib/planning.js` or `web/lib/capacity.js` ever imports a `ContextSource`.

### Two-tier lookup, matching the triage policy this exists to serve

1. **Linked first.** If the source itself records the connection (Pylon's `linear_ticket` custom
   field, an attachment, a PR body mentioning the identifier), return that with `matchKind: "linked"`
   and skip the wider search. This is what closes the actual gap: an agent doing this by hand already
   knows to check for a linked ticket, but pays a full search call to confirm one does not exist.
2. **Candidate net, only when unlinked.** Query by time window (created around the same date) and, if
   known, the same reporter/customer, tagged `matchKind: "candidate"`. This is deliberately narrower
   than [ROADMAP's cross-project duplicate detection](../ROADMAP.md#later--cross-project-duplicate-detection)
   idea, which is open-ended similarity across the whole workspace. A context source's candidate search
   is bounded to one external system and one time window, because that is what a "did something already
   happen around when this was filed" check needs, not general duplicate detection.

### Generic, not per-project

Pylon, Slack, and GitHub PRs are not scoped to a single Linear project the way `TrackerSource` results
are (see [ideas.txt #7](../ideas.txt), the same project-scoping gap `standup` hit). A context source's
cache keys on `(source, query fingerprint)`, never on a project id, and the port takes no project
argument. This is why the caching/search generalization is listed as a shared prerequisite in
[ROADMAP.md](../ROADMAP.md) rather than built inside this feature: any command that is not
project-scoped needs the same fix, and building it twice (once generic, once accidentally re-coupled to
a project by a context-source adapter that copies an existing pattern) is the failure mode to avoid.

### Spike, then productionize, same as every other port

Per [ADR 0007](0007-productization-and-domains.md): explore each source's shape via its MCP connector
inside a session first (Pylon, Slack, GitHub already have one available in this workspace's Claude Code
setup). Productionize behind the port with a direct REST/GraphQL call and a secret from
`src/secrets.ts`, because an MCP dependency does not survive a scheduled or hosted run. The CLI reads
context sources the same way it reads everything else — JSON out, no write path — consistent with
[ADR 0009](0009-scope-boundaries.md)'s "no MCP server, no writes from the CLI."

### Naming stays generic

Nothing in the port, the cache, or the CLI command names Coverbase, `irm`, `DEV-####`, or any
Coverbase-specific label ("Needs Info" is a Linear label choice belonging to whichever workspace tlr
runs against, not a constant in this layer). An adapter's config names its own source-specific
identifiers (a Pylon custom field key, a Slack channel list, a GitHub org/repo) so a second workspace
supplies its own without a code change.

## Alternatives considered

- Fold this into `TrackerSource` and ADR 0006's normalized model. Rejected: that model's `Issue` type
  carries planning fields (state, priority, estimate, cycle) that support tickets, Slack messages, and
  PRs do not have and should not be made to fake. A context source answers "what do you know about
  this," not "what should the planner schedule."
- One bespoke script per source (a Pylon script, a Slack script), no shared port. Rejected: it is the
  same mistake ADR 0007 already named for capacity sources — the caller ends up depending on the
  shortcut instead of the interface, and a third source means a third one-off instead of a third
  adapter.

## Consequences

- An agent doing triage (or any other task that wants "what does the world outside Linear say about
  this ticket") calls one CLI command instead of one live tool call per source per issue. The token
  cost this was meant to cut is the round-trip and re-read of each of those calls, not the judgment call
  the agent still has to make
- ADR 0009's ban narrows to trackers. A context source is explicitly permitted; a fourth tracker (a
  real second issue-tracking/planning system) is still out of scope
- The candidate-net search is opinionated and narrow (time window + actor, one external system at a
  time) on purpose, not a step toward the open-ended cross-project duplicate detection idea already
  tabled in ROADMAP
- Generalizing the cache/search layer away from per-project keys becomes a prerequisite this depends on,
  not a side effect of building it, so it is sequenced first in ROADMAP
