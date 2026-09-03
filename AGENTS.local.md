# tlr

| To understand                            | Read                         |
| ---------------------------------------- | ---------------------------- |
| What is next, ranked, and why            | [ROADMAP.md](ROADMAP.md)     |
| Why a thing is the way it is             | [DECISIONS.md](DECISIONS.md) |
| What Linear and adjacent tools do (2026) | [RESEARCH.md](RESEARCH.md)   |
| Credentials and how to get them          | [SETUP.md](SETUP.md)         |

## State of the repo

The Deno app on `main` is frozen. It still runs (the hourly snapshot LaunchAgent depends on it) but gets
no new features. A Python rebuild with a Textual TUI replaces it in the phases ROADMAP.md lays out. Fix a
Deno path only when it blocks the snapshot job or a rebuild phase.

## The one rule: spike, then productionize

The project moves by spikes: prove a slice fast, then harden it. A spike may take a shortcut, but only
behind an interface (a capacity source, a secret store, a context source), so productionizing is a new
adapter and a delete rather than a caller rewrite.

MCP connectors are for exploring in a session, not for the shipped path. The product reads through a
direct REST or GraphQL call with a secret from the secret store (an env var, else the macOS keychain),
because an MCP dependency at runtime does not survive a scheduled run.

Two hard rules that fall out of this, both in DECISIONS.md: writes to Linear or Pylon happen only after a
preview a person confirms in the UI, never from a piped CLI command or an MCP. And nothing specific to
one employer (names, labels, customer tiers, thresholds) goes in code; it lives in the gitignored local
config with a committed sample.

## Layout and commands

tlr has no mise `dev` or `build` task; use the `deno task` equivalents in [README.md](README.md) instead.
Routes register in `scripts/serve.ts`, and templates live under `web/templates/`, not `src/templates/`.

Run `hk run pre-commit --all` (or let the installed git hook run it on staged files): `deno task check`,
`deno fmt`, `deno lint`, `deno task biome check`, `dprint` over JSON/Markdown/TOML, `deno test`, and the
Chrome e2e project. Biome is the one most often missed, and it fails the hook on rules `deno lint` does
not carry (`useTemplate`, `noControlCharactersInRegex`). Keep pure logic in `web/lib/*.js` free of I/O so
tests drive it without a network. Never commit real ticket data or echo a key (see [SETUP.md](SETUP.md)).
Conventional Commits, lowercase, one subject line, a body only when the "why" is not obvious.
