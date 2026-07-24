# Working in this repo

The front door for anyone (human or agent) making changes. This file stays short on purpose: it points
at the canonical source for each topic instead of restating it, so nothing here goes stale when a
decision changes.

| To understand                                  | Read                               |
| ---------------------------------------------- | ---------------------------------- |
| The shape and the stack                        | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Direction, phases, backlog, and open questions | [ROADMAP.md](ROADMAP.md)           |
| Credentials and how to get them                | [SETUP.md](SETUP.md)               |
| Why a thing is the way it is                   | [adr/](adr)                        |

## The one rule: spike, then productionize

The project moves by spikes: prove a slice fast, then harden it. A spike may take a shortcut, but only
behind a port. The caller depends on an interface (`CapacitySource`, `SecretStore`, `TrackerSource`),
never on the shortcut, so productionizing is a new adapter and a delete rather than a caller rewrite.

In practice that means MCP connectors are for exploring in a session, not for the shipped path. The
product reads through a script with a direct REST or GraphQL call and a secret from `src/secrets.ts` (an
env var, else the macOS keychain), because an MCP dependency at runtime does not survive a hosted runner.
`secrets.ts` is the realized `SecretStore` port; on-call (Incident.io) and the roster (Linear) follow the
spike-then-productionize rule, and Google Calendar out-days are the remaining spike. The full reasoning
and domain boundaries are in [ADR 0007](adr/0007-productization-and-domains.md).

One hard rule that falls out of this: writes to Linear happen only from the web app's Review page, never
the CLI or an MCP. Bulk edits already go through the Linear MCP in Claude Code, so a CLI write path would
only duplicate it. Do not add one.

## Before a commit

Run `hk run pre-commit --all` (or let the installed git hook run it on staged files): `deno test`,
`deno fmt`, `deno lint`, and `dprint` over JSON/Markdown/TOML. Keep pure logic in `web/lib/*.js` free
of I/O so tests drive it without a network. Never commit real ticket data or echo a key (see
[ADR 0003](adr/0003-local-data-public-repo.md) and [SETUP.md](SETUP.md)). Conventional Commits,
lowercase, one subject line, a body only when the "why" is not obvious.
