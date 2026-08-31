# tlr

| To understand                                 | Read                                     |
| --------------------------------------------- | ---------------------------------------- |
| The shape, how it works, and its known limits | [ARCHITECTURE.md](ARCHITECTURE.md)       |
| What is next, ranked                          | [ROADMAP.md](ROADMAP.md)                 |
| What tlr will not do                          | [adr/0009](adr/0009-scope-boundaries.md) |
| Credentials and how to get them               | [SETUP.md](SETUP.md)                     |
| Why a thing is the way it is                  | [adr/](adr)                              |

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

One hard rule that falls out of this: writes to Linear happen only from the web app, never the CLI or an
MCP. Bulk edits already go through the Linear MCP in Claude Code, so a CLI write path would only
duplicate it. Do not add one. [ADR 0009](adr/0009-scope-boundaries.md) has this and the other scope
limits.

## Layout and commands

tlr has no mise `dev` or `build` task; use the `deno task` equivalents in [README.md](README.md) instead.
Routes register in `web/`, not `src/routes.ts`, and templates live under `web/templates/`, not
`src/templates/`.

Run `hk run pre-commit --all` (or let the installed git hook run it on staged files): `deno task check`,
`deno fmt`, `deno lint`, `deno task biome check`, `dprint` over JSON/Markdown/TOML, `deno test`, and the
Chrome e2e project. Biome is the one most often missed, and it fails the hook on rules `deno lint` does
not carry (`useTemplate`, `noControlCharactersInRegex`). Keep pure logic in `web/lib/*.js` free
of I/O so tests drive it without a network. Never commit real ticket data or echo a key (see
[ADR 0003](adr/0003-local-data-public-repo.md) and [SETUP.md](SETUP.md)). Conventional Commits,
lowercase, one subject line, a body only when the "why" is not obvious.
