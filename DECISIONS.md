# Decisions

One Y-statement per decision: in the context of a use case, facing a concern, we chose an option over
the alternatives, to get a quality, accepting a downside. Newest first within each section. A decision
that no longer holds moves to Superseded with the date and what replaced it, rather than being deleted,
so the reasoning stays findable. Before September 2026 these lived in `adr/`; the git history has the
long form, and the web research that informed the September decisions (`RESEARCH.md`, since removed).

## Accepted

**Rebuild in Python with a TUI** (2026-09). In the context of a Deno web app and CLI that I never
brought into daily use because too much of it was unreliable, facing a choice between hardening it and
starting over, we chose a rebuild in Python (Textual, chartui, DuckDB) over hardening the Deno code or
rebuilding in Go, to get a terminal-first tool that reuses my existing chart and TUI work and fits
pytest-recording for API fixtures, accepting that the tested Deno planning code is thrown away and that
startup is slower than a compiled binary.

**TUI over web** (2026-09). In the context of a single primary user who presents from the tool in
meetings, facing the cost of keeping a server, templates, and a browser test suite reliable, we chose a
keyboard-driven TUI with in-terminal charts over a web app, to get one process with no server and a
vim-style surface, accepting that sharing with a teammate means they run it themselves and that screen
sharing shows a terminal.

**Generic by configuration** (2026-09). In the context of a public repo driven by one company's
Linear and Pylon workspaces, facing the pull to hardcode the names, labels, customer tiers, and
thresholds that make it useful to me, we chose a gitignored local config with a committed sample over
constants in code, to get a tool anyone on Linear and Pylon can run without reading my workspace's
vocabulary in the source, accepting a config schema to maintain and a sample that must stay runnable.

**Read history from Linear, spend snapshots on what it lacks** (2026-09). In the context of assuming
local snapshots were the only way to know anything over time, facing the fact that Linear's
[`IssueHistory`](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/objects/IssueHistory)
records cycle, assignee, state, and estimate changes completely and retroactively, we
chose to read change history from the API and keep local capture only for milestone scope and
cross-system state (Pylon links, calendar, on-call), to get correct answers on the first run rather
than after weeks of accumulation, accepting a heavier first ingest and dependence on Linear's history
retention.

**Triage is one queue across Pylon and Linear** (2026-09). In the context of a daily meeting that
works the Pylon queue and decides per ticket whether engineering picks it up, facing two systems with
no shared ordering and a cross-link that is usually missing, we chose a single ordered queue built
from configurable rules (priority field, age, SLA distance, customer tier, exclusions) over two lists
side by side, to get through the meeting without tab-switching, accepting that the rules are policy the
user owns and tlr only evaluates.

**Allocation is a ledger, not a sum of open estimates** (2026-09). In the context of a ticket that
is 80% done in one cycle but waits two cycles for review and so charges its full estimate to three
cycles, and of meeting and review time that no estimate covers, we chose to record allocation as dated
events per person per cycle (assigned, estimated, moved, handed off, done) and derive load from the
ledger over summing open estimates, to get load numbers that stop charging a person for work that is
waiting on someone else, accepting that the handoff signal has to be defined per workspace.

**Local-first, public repo, no real data committed** (2026-07). In the context of a public repo
reading a private workspace, facing the risk of leaking a roadmap or a customer, we chose to gitignore
every real fixture and store and ship a synthetic sample over committing anything real, to get a safe
public demo, accepting that screenshots of real data stay a judgment call each time.

**Spike, then productionize behind a port** (2026-07). In the context of every integration starting
as a one-operator shortcut (an MCP call in a session, a keychain read), facing the risk that making it
real means rewriting callers, we chose to put each outside dependency behind an interface with a
direct REST or GraphQL call and a secret store, over wiring the shortcut into the product, to get
"productionize means a new adapter and a delete", accepting one interface per dependency. One vendor
eval ([Arize](https://arize.com/blog/mcp-vs-cli-skills-for-agents-what-our-eval-found-and-which-you-should-use/))
measured a CLI path at 90,000 fewer tokens than MCP for the same task, which matches my experience.

**Writes only after a preview a person confirms** (2026-07). In the context of bulk AI edits already
running through the Linear MCP, facing a second competing write surface, we chose that tlr writes only
after a dry-run preview confirmed in the UI and never from a piped CLI command, over an MCP server or
CLI write flags, to get one reviewed write path, accepting no unattended batch fixes.

**Capacity is per person and deflated by real constraints** (2026-07). In the context of a flat
points-per-cycle number hiding on-call weeks and days out, facing plans that looked safe but were
over-committed, we chose per-person velocity deflated by on-call (Incident.io) and out-days (Google
Calendar) over a team-level velocity (Linear's own capacity is a team number from the last three cycles,
per its [cycles docs](https://linear.app/docs/use-cycles), and it points capacity work at a
[Float integration](https://linear.app/integrations/float)), to get an honest over-allocation flag, accepting that each source
is another credential and refresh path.

**Refresh merges by provenance** (2026-07). In the context of automated refreshes overwriting
hand-typed corrections, we chose a merge where each source only touches fields it wrote over a blind
overwrite, to get safe automation, accepting a `locked` flag as the only way to freeze a value.

**Chain risk over ordering risk** (2026-07). In the context of dependency chains, facing an
ordering check that fired zero times across the real project's 25 blocking edges, we chose to measure
whether a chain's sequential points fit its owners' velocity before the milestone target over checking
that blockers are scheduled first, to get the risk that actually exists, accepting that a chain in
another project stays invisible.

**Slop scan by heuristic, review by diff, no actor attribution** (2026-07). In the context of AI edits
landing under the user's own Linear account, facing no way to tell them from hand edits, we chose a
text heuristic for AI tells plus a review queue of everything changed since the last review pointer
over actor-based filtering, to get a review path that works whoever made the edit, accepting that
"who did this" is never answered. Linear's [agent sessions](https://linear.app/developers/agents) and text attribution may change
this; see the roadmap.

**Keys scoped to the focused region, every binding on screen** (2026-08). In the context of
bindings accumulating with no rule, we chose per-region key maps with a hint bar over a command palette,
to get one visible source of truth for what a key does, accepting reused keys across regions. Every
keyboard write still previews.

**Charts in decks stay static SVG** (2026-08). In the context of Slidev decks needing charts that
survive PDF export and offline rendering, we chose hand-committed SVG over a charting library, to get
zero runtime dependency and full palette control, accepting no live chart during a talk.

## Proposed

**Handoff as a third capacity deflation** (2026-08). A ticket waiting on a reviewer is not waiting on
its owner, so charging its points to them overstates load. Which Linear or GitHub signal marks handoff
is unsettled; the allocation ledger above is where it lands.

**Work streams** (2026-08). Grouping work by stream is how I orient when many similar changes are in
flight, and no grouping tlr has (milestone, cycle, project, chain, assignee) expresses it. Where a
stream is defined is the open question. Nothing gets built against it until that is answered.

**Delete rather than freeze** (2026-09). In the context of a Deno app that phase 0 planned to leave
on `main` until phase 2 replaced its snapshot job, facing a repo where every agent and every lint config
would carry a dead implementation, we chose to delete the Deno code, the Slidev theme, and the
app-template scaffolding in one change and write the API knowledge down in `docs/api-notes.md`, over
freezing it in place, to get a tree that only holds what the rebuild uses, accepting that milestone
scope goes uncaptured until phase 2 ingests it and that reading the old implementation means checking
out `f16cb07`.

## Superseded

**Deno and TypeScript over Python** (2026-07, superseded 2026-09 by the Python rebuild). Chosen so
one runtime could serve a web view and a CLI. With the web view dropped the reason is gone.

**No front-end framework, no vendored assets** (2026-07, superseded 2026-09). Applied to the web
app, which is being removed.

**Deploy alongside yak-shears on one VM** (2026-08, superseded 2026-09). A hosted tlr is out of scope
while the tool is a single-user TUI. The systemd and Caddy plan is in git history if it comes back.

**A normalized schema across trackers** (2026-08, superseded 2026-09). Designed for a second tracker
that is not coming. Pylon is a context source, not a tracker, and the rebuild reads Linear's shape.

**No GitHub adapter** (2026-07, narrowed 2026-09). Still no GitHub tracker adapter, but review load
per person is a capacity input the user asked for, and PR review activity is the only place it lives.
Reading it is allowed; treating GitHub as a tracker is not.

**Out of Linear's way** (2026-07, still holds for cross-project load and stale-issue views). Requests
for those point back at Linear.

## Rejected and recorded

Tried or scoped, then dropped. Listed so they do not come back unexamined.

- A dedicated dependency node-and-edge view. Spiked on the real project: 31 of 77 open issues sat in
  any chain, six of seven clusters were pairs or triples, and the drawing added nothing over a wave
  plane. The text beside each chain carried the information
- Ordering risk (blocker scheduled after its dependent). Zero hits on 25 real edges
- Cross-project duplicate detection. Linear's [Triage Intelligence](https://linear.app/docs/triage-intelligence) does semantic duplicate
  suggestion at intake on Business and Enterprise plans, and the daily triage meeting already merges duplicates by
  hand. The spike's gold set found only 18 of 205 candidates were true duplicates under Linear's own
  symmetric relation, and same-day intake bursts could not gate candidates (13 of 112 gold pairs were
  legitimate same-burst tickets). Its code stays gitignored under `spike/duplicates/`
- Standup and weekly-update prose generation. Linear's [agent-drafted project updates](https://linear.app/changelog/2026-06-18-agent-assisted-project-updates)
  and Loops cover it. tlr feeds numbers into an update and does not write the sentences
- Project-level slip forecasting. Linear's [project graph](https://linear.app/docs/project-graph) draws it with optimistic and
  pessimistic bands. Milestone-level and
  capacity-deflated forecasts stay
- A "what could I pick up" view and reading handoff from `gh search prs` alone
