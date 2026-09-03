# tlr

tlr, pronounced "teller"

Linear and Pylon each know the current state of their own tickets.
Neither answers the questions a tech
lead carries into a daily triage meeting, a standup, or a report up the chain: which
support ticket to
look at next and whether anyone is already on it, who is over their real capacity once
on-call, days
out, meetings, and review load are counted, and whether the milestone will land.

tlr answers those from the two systems' APIs plus a calendar and an on-call roster, in a
terminal, in
the few minutes before a meeting starts.
It is a single-user tool with no server to run.

## Status

A Deno web app and CLI lived here until September 2026.
Its daily paths never held up well enough to
use, so it is gone and a Python rebuild with a Textual TUI replaces it.
Nothing runs yet.

- [ROADMAP.md](https://github.com/kyleking/tlr/blob/main/ROADMAP.md) has the phases, in
    order, with
    what each one has to deliver
- [DECISIONS.md](https://github.com/kyleking/tlr/blob/main/DECISIONS.md) has every
    decision, its
    sources, and what it superseded
- [api-notes.md](./api-notes.md) has what Linear, Pylon, Incident.io, and Google Calendar
    actually do,
    including the quirks that cost a day each to find
- [SETUP.md](https://github.com/kyleking/tlr/blob/main/SETUP.md) has every credential and
    where to get
    it

The Deno implementation is readable at commit
[`f16cb07`](https://github.com/kyleking/tlr/commit/f16cb07) if you need to see how
something worked.

## Installation

```sh
uv tool install tlr
```

## Design

Reads come from a local DuckDB file, so opening the tool is instant and refreshing is an
explicit
action whose age shows on screen.
Every outside dependency sits behind an interface with a direct REST
or GraphQL call, because an MCP dependency does not survive a scheduled run.

Writes reach Linear or Pylon only after a preview a person confirms in the UI, and never
from a piped
command.
Bulk edits stay with the Linear MCP in Claude Code.

Nothing specific to one employer (names, labels, customer tiers, thresholds) appears in
the source.
It
lives in a TOML config outside the repo, with a committed sample.

## Project Status

See the `Open Issues` and/or the [CODE_TAG_SUMMARY].
For release history, see the [CHANGELOG].

## Contributing

We welcome pull requests! For your pull request to be accepted smoothly, we suggest that
you first open
a GitHub issue to discuss your idea.
For resources on getting started with Open Source, see the
[Open Source Guides].

## Code of Conduct

We follow the [Contributor Covenant Code of Conduct][contributor-covenant].

## Open Source Status

We try to reasonably meet most aspects of the "OpenSSF scorecard" from
[Open Source Insights](https://deps.dev/pypi/tlr)

## Responsible Disclosure

If you have any security issue to report, contact project maintainers privately.
You can reach us at
[dev.act.kyle@gmail.com](mailto:dev.act.kyle@gmail.com)

## License

[LICENSE](https://github.com/kyleking/tlr/blob/main/LICENSE)

[changelog]: https://tlr.kyleking.me/docs/CHANGELOG
[code_tag_summary]: https://tlr.kyleking.me/docs/CODE_TAG_SUMMARY
[contributor-covenant]: https://www.contributor-covenant.org
[open source guides]: https://opensource.guide/how-to-contribute
