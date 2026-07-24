# TLR - Tech Lead Reporter

TLR, pronounced "Teller"

A capacity- and dependency-aware planning board for Linear projects: one Deno/TypeScript core, a
static web front-end, and a handful of scripts that refresh its data from Linear, Incident.io, and
Google Calendar. See [ARCHITECTURE.md](ARCHITECTURE.md) for the shape and [AGENTS.md](AGENTS.md) for
where to start.

## Setup

```sh
mise install
deno install
hk install
```

`mise install` pins Deno, [hk](https://hk.jdx.dev) (git hooks), and [dprint](https://dprint.dev)
(JSON/Markdown/TOML formatting) to this repo's versions. `hk install` wires `hk.pkl`'s `pre-commit`
hook into git so fmt/lint/test run automatically.

See [SETUP.md](SETUP.md) for the credentials (Linear, Incident.io, Google Calendar) the data-refresh
scripts need.

## Usage

```sh
deno task dev              # serve the web board at localhost:8000
deno task capacity         # refresh on-call / out-days / velocity into web/data/cpu.json
deno task roster           # resolve assignee names to emails from Linear
deno task gcal:freebusy    # spike: read teammates' free/busy from Google Calendar
```

## Development

```sh
deno task test           # run tests
deno task fmt             # format *.ts/*.js
deno task lint            # lint *.ts/*.js
deno task check           # type-check
hk run pre-commit --all   # everything the pre-commit hook runs, on the whole repo
```

## Architecture

```
scripts/          data-refresh and dev-server scripts (capacity, roster, gcal-freebusy, serve)
web/              the board: index.html, style.css, app.js
web/lib/          pure logic (capacity.js, planning.js), imported by both the browser and Deno tests
tests/            Deno tests for web/lib
adr/              decisions and why
```
