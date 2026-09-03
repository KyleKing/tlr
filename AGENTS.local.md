# tlr

| To understand                             | Read                                   |
| ----------------------------------------- | -------------------------------------- |
| What is next, ranked, and why             | [ROADMAP.md](ROADMAP.md)               |
| Why a thing is the way it is              | [DECISIONS.md](DECISIONS.md)           |
| What each API actually does, quirks first | [docs/api-notes.md](docs/api-notes.md) |
| Credentials and how to get them           | [SETUP.md](SETUP.md)                   |

## State of the repo

The Deno app is deleted. `docs/api-notes.md` carries what it knew about Linear, Pylon,
Incident.io, and
Google Calendar, and the code itself is at commit `f16cb07`.
The hourly snapshot LaunchAgent is
unloaded.
What it already captured sits untracked in `web/data/tlr.sqlite`, and phase 2 imports it
once.

Everything is scaffolded from `calcipy_template`.
Follow the template in all things: prek for hooks,
ruff and ty configured in `pyproject.toml`, `./run` for every gate.
Nothing from the app-template era
survives, so do not reintroduce hk or dprint.

## The one rule: spike, then productionize

The project moves by spikes: prove a slice fast, then harden it.
A spike may take a shortcut, but only
behind an interface (a capacity source, a secret store, a context source), so
productionizing is a new
adapter and a delete rather than a caller rewrite.

MCP connectors are for exploring in a session, not for the shipped path.
The product reads through a
direct REST or GraphQL call with a secret from the secret store (an env var, else the
macOS keychain),
because an MCP dependency at runtime does not survive a scheduled run.

Two hard rules that fall out of this, both in DECISIONS.md: writes to Linear or Pylon
happen only after
a preview a person confirms in the UI, never from a piped CLI command or an MCP.
And nothing specific to
one employer (names, labels, customer tiers, thresholds) goes in code; it lives in the
gitignored local
config with a committed sample.

## Conventions

`tail-cw` is the reference implementation for the shape of this package: argparse split
across a thin
`__main__.py` and a fat `cli.py` whose heavy imports are deferred, XDG paths through
`platformdirs`,
nested dataclass config sections mapping one-to-one onto TOML tables, and DuckDB for the
local store.
Read it before inventing something here.

Pure functions take frames and return frames, so tests need no network.
API fixtures come from
pytest-recording, scrubbed as the cassette is written and verified again before it can
be committed.

Never commit real ticket data or echo a key.
See [SETUP.md](SETUP.md).
