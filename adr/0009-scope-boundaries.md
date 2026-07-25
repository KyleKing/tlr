# 0009 — Scope boundaries

- Status: accepted
- Date: 2026-07-24

## Context

Five calls kept resurfacing in ROADMAP.md and surviving every prune, because nothing had settled them
in a durable place. A roadmap holds what is next. A standing "we are not doing this" belongs here.

## Decision

### No MCP server, and no writes from the CLI

`deno task cli` is the read-and-preview surface for Claude Code. It pulls facts Linear does not
aggregate and shows what an op would change, and it never writes. There is no MCP server and none is
planned.

Bulk AI edits already run through the Linear MCP in Claude Code. A tlr write command would duplicate
that surface and split the review path in two. tlr writes only from the web UI, where a person sees
the diff and confirms. If tlr is ever hosted, the CLI gains a mode that calls the hosted API instead of
reading local files, reusing the same handlers.

### Actor attribution stays out

A snapshot diff cannot separate an AI-via-MCP edit from a hand edit, because both land under the same
Linear account. Splitting them needs a distinct agent token or a write-time hook, covered in
[0004](0004-catching-slop-and-ai-edits.md). The Review page does not try. It shows every change since
the last review pointer and lets you clear each one, which catches what a bulk run touched without
knowing who ran it.

### The snapshot schema stays thin

Snapshot, diff, review, and the op model read the current Linear shape rather than
[0006](0006-normalized-tracker-schema.md)'s normalized model. Normalizing now would cost a migration
and buy nothing while Linear is the only tracker. The normalized model stays the target for when a
second tracker lands.

### Out of Linear's way

No GitHub adapter or any third tracker, no cross-project load view, and no stale-issue detection.
Linear's own views cover all three, and tlr exists for what Linear structurally cannot show.

### No front-end framework, no vendored assets

The web app is vanilla ES modules with no build step, so pure logic in `web/lib/*.js` runs unchanged in
the browser and in Deno tests. Nothing loads from a CDN and nothing is vendored. A build task that
downloads assets would only be worth adding if the app ever takes a dependency like HTMX.

## Consequences

- Claude Code drives tlr through the CLI's JSON output and the files it reads, with no server to run
  and no protocol to maintain
- A person sees every write before it lands, at the cost of no unattended batch fixes
- A second tracker means a schema migration, taken deliberately at that point rather than paid for now
- Requests to view work across projects, or to find stale tickets, point back at Linear
