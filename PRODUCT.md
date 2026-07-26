# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Tech leads and engineering managers at the author's company who run a Linear project: a handful of
people on the same workspace, each planning their own project forward and reporting on it backward.
The tool is built for that group today and is expected to open up to Linear-using leads outside the
company later, so nothing should assume a single operator or a single machine.

Every user is already fluent in Linear and in their own roadmap. They arrive knowing the tickets and
the people; what they lack is the aggregate.

## Product Purpose

tlr reads a Linear project and answers the questions Linear structurally cannot: how the plan moved
since last week, whether a milestone will land on its target date, who is overloaded next cycle once
on-call and time off are counted, and which ticket text reads as AI slop.

It keeps a local snapshot history so it can diff the plan over time, models per-person capacity
against the dependency graph, and gives a reviewed, deterministic path for batch edits so AI-made
changes and sloppy text do not reach a wider audience unchecked.

Success is a lead who can write the weekly update, spot the milestone that is slipping, rebalance the
next cycle, and clean up what a bulk AI edit got wrong, without leaving the tool and without hand
-assembling any of it from Linear views.

## Positioning

Linear's history is per-issue. tlr snapshots whole-project state locally and diffs two captures, so
it can show plan-level change over time, which no per-issue history can reconstruct.

The second thing a neighboring tool could not truthfully copy: capacity is deflated by real
constraints (Incident.io on-call weeks, Google Calendar out-days, per-person velocity from past-cycle
throughput) and charged against the dependency graph, where a blocking chain runs one ticket at a time
and its points land on the people who own it.

## Operating Context

Four recurring scenes, all of them short and all of them next to Linear rather than instead of it:

- After a Claude Code batch edit through the Linear MCP, to review what landed and fix what got
  mangled. This is the reason the write path exists at all
- The weekly or cycle-boundary ritual: write the update, check milestone slip, rebalance the next
  cycle
- Ad-hoc during the day, open alongside Linear, to pull one fact Linear will not aggregate
- Before a meeting (standup, skip-level, a stakeholder asking when a milestone lands), pulled up to
  answer someone

Runs locally at `localhost:8000` via `deno task dev`, or as a compiled binary. A launchd agent
captures a snapshot every three hours in the background, so the data a user opens is usually already
fresh and the app has to say when it is not. Live mode uses the real workspace key; demo mode
(`TLR_DEMO=1`) points writes at a test workspace and says so on screen.

## Capabilities and Constraints

Six pages behind one nav: Board (capacity heat per person against cycles and milestones, with slop,
chain-risk, and missing-data flags, plus a what-if overlay), Changes (step through snapshot history,
generate the shipped/moved/at-risk narrative), Review (group every change to a ticket since the last
review pointer, clear each one, edit in place), Roadmap (every ticket on one pannable plane, time
across and dependency depth down, with the chains listed worst first), Balance (a deterministic
assignee-and-cycle proposal for unscheduled work under each person's deflated ceiling), and Settings
(appearance, capacity, roster, integrations, credentials).

A read-and-preview CLI covers the same engine for piping into Claude Code: `scan`, `capacity`,
`balance`, `timeline`, `diff`, `report`, `forecast`, `review`, `plan`, `snapshot`, `export`.

Standing constraints, most of them settled in `adr/0009-scope-boundaries.md`:

- Writes to Linear happen only from the web UI, only after a dry-run preview a person confirms. The
  CLI never writes and there is no MCP server
- No front-end framework, no build step, no CDN, nothing vendored. Vanilla ES modules and hand-written
  CSS, so the pure logic in `web/lib/*.js` runs unchanged in the browser and in Deno tests
- Deno and TypeScript for the whole stack. Hono serves, Vento renders, SQLite (`node:sqlite`) stores
  snapshots
- Real Linear data never enters the repo. Fixtures and snapshot files are gitignored and the app falls
  back to synthetic sample data, because the repo is public and the workspace is a private company's
- Every outside dependency sits behind a port (tracker, capacity source, secret store, snapshot
  store), so moving from one laptop to a hosted per-user runner is an adapter binding, not a rewrite
- Out of Linear's way: no second tracker, no cross-project load view, no stale-issue detection
- A forecast is always labeled a forecast and never rendered as a real date

Terminology comes from Linear and stays there: issue, project, milestone, cycle, estimate (points),
blocking relation. tlr adds its own: capture/snapshot, chain and wave, slop, heat, deflated capacity,
review pointer, op.

Undecided: whether tlr is ever hosted, and on what. The port structure exists so that decision can be
deferred.

## Brand Commitments

The name is `tlr`, lowercase in the UI and in prose, `TLR` only at the head of a document. Stands for
Tech Lead Reporter, pronounced "Teller". The only mark today is the wordmark in the nav; there is no
logo and no favicon.

Voice is lowercase, terse, and declarative. No marketing register, no emoji, no exclamation. Warnings
read as plain sentences. Documentation explains why a decision was made and names what was tried and
discarded.

The color system is Catppuccin, four flavors (latte, frappe, macchiato, mocha) and eight user-selectable
accents, with the light flavor deliberately darkened from stock so small text clears AA.

## Evidence on Hand

- Six real screenshots at `docs/images/{board,changes,review,roadmap,balance,settings}.png`,
  regenerated on demand from the end-to-end suite at 1280x800 against seed data
- Synthetic seed data (`deno task seed`) that runs the whole app offline with no Linear key, and is
  what the tests and screenshots use
- Nine ADRs in `adr/` recording the decisions and the rejected alternatives
- Contrast is enforced by tests: `tests/theme_test.ts` sweeps every flavor and accent pair, and
  `tests/e2e/a11y.spec.ts` runs axe-core color-contrast under wcag2aa across eight scenarios

There are no users outside the author yet, no testimonials, no benchmarks, no pricing, and no hosted
deployment. Screenshots of real data are a judgment call each time, because they show internal ticket
titles.

## Product Principles

- Answer only what Linear structurally cannot. Anything Linear's own views already cover points back
  at Linear
- Read and preview before write. Every change to Linear is shown as a dry run and confirmed by a
  person, because the edits being corrected were often made in bulk by an AI
- Say what is a forecast. Modeled landing dates, deflated capacity, and chain risk are labeled as
  estimates and never dressed as fact
- Local-first, and private by default. Real workspace data stays on the machine; the public artifact
  runs on synthetic data
- Pure logic stays testable. Analysis is separated from I/O and rendering, which is why there is no
  framework and no build step

## Accessibility & Inclusion

No formal external standard is claimed, but two bars are real.

Contrast is held to WCAG AA and enforced in tests, because the repo has shipped unreadable text more
than once. Any new color must be checked against the background it actually renders on, in every
flavor and accent pair.

Keyboard navigation is first-class, not a fallback. This is a dense operator tool used in short
sessions, so every action should be reachable without the mouse. The mechanism is undecided: a
command palette and vim-style bindings are both on the table. Today the app has aria states on
toggles, popovers, and banners, but no focus-visible styling, no skip link, and no
`prefers-reduced-motion` handling.
