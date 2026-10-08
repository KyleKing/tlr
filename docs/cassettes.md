# Cassettes

tlr's adapter tests replay real API responses recorded once against a real Linear and
Pylon
workspace, using [pytest-recording](https://github.com/kiwicom/pytest-recording) (vcrpy
under the
hood).
A raw response carries customer names, ticket text, roadmap content, emails, and API
keys,
and tlr is a public repo, so none of that may ever reach a commit.

## How it stays safe

Scrubbing happens twice, for two different reasons.

**At record time**, `tests/conftest.py`'s `vcr_config` fixture wires `scrub_request` and
`scrub_response` (`tests/cassette_scrub.py`) into vcrpy's `before_record_request` /
`before_record_response` hooks.
They rewrite the interaction as the cassette is written, so an
unscrubbed cassette never exists on disk, not even transiently.

**At commit time**, the `cassette-scrub` pre-commit hook runs
`uv run python -m tests.cassette_scrub`, which rescans every committed cassette from
scratch.
It does not try to
scrub anything: it fails the commit on any header or JSON key it does not recognize, any
Authorization-like header that survived, or any value that looks like a credential or a
real
email.
Unknown always means rejected. This is the actual gate; record-time scrubbing is only
what keeps a cassette clean by the time it reaches that gate.

## Recording a new cassette

1. Set the real credential in the environment or keychain per `SETUP.md`.
    Recorded tests live under `tests/live/` and resolve each secret through
    `secret_or_placeholder` (`tests/live/conftest.py`), so replaying needs no credential:
    the cassette match ignores the `Authorization` header entirely.
1. Run the test that needs a fixture:
    `uv run pytest tests/live/test_thing.py --record-mode=once`.
    pytest-recording writes the cassette under `tests/live/cassettes/` — the package's
    `vcr_cassette_dir` override puts it directly inside `cassettes/`, which is where both
    the scrub verifier and the pre-commit glob look.
1. Run `uv run prek run --all-files` (or just `uv run python -m tests.cassette_scrub`)
    before
    staging the cassette.
    If it fails, see below.
1. Read the generated YAML once. The verifier only proves that no *known-sensitive* field
    leaked, so skim the file for anything that surprises you.

Never hand-edit a recorded cassette to "fix" a scrub failure.
Fix the classification instead (see
below), then re-record so the fix is real.

## When the verifier rejects a field

The verifier's output names the file, the JSON path (or header name), and why: an
unclassified
key, a redacted-class key holding something other than its placeholder, a surviving
Authorization-shaped header, or a value that matches a credential or real-email pattern.

An unclassified key means a new field showed up in a response that
`tests/cassette_scrub.py`
has never seen.
Classify it before it can be committed:

- **Structural** (kept verbatim): the field carries no workspace-specific content, e.g. a
    count, an enum, a boolean, a small integer.
    Add the key name to
    `STRUCTURAL_JSON_KEYS`.
    A pagination cursor is the exception that proves the rule: it looks structural, but
    Pylon's cursors match the credential-shaped pattern check, so `cursor` is a redacted
    class and `scrub_request` rewrites `?cursor=` in the recorded URI to the same
    placeholder to keep replay matching.
- **Keyed-map** (keys kept, values classified): a dict keyed by workspace data rather than
    a fixed field vocabulary, like Pylon's `custom_fields` (keyed by field slug) and the
    `time_in_status_seconds` breakdowns (keyed by status slug).
    Add the container's key name to `KEYED_MAP_JSON_KEYS`.
    A scalar sitting directly under a keyed-map key redacts as text, so an unexpected flat
    shape still fails closed.
- **Redacted** (replaced by a stable, shape-preserving placeholder): the field is an id, a
    name,
    a timestamp, free text, an email, or a URL.
    Add the key name to `_REDACTED_KEY_CLASS`, pointing
    at whichever placeholder class in `REDACTED_PLACEHOLDERS` matches its shape (a UUID
    stays
    UUID-shaped, an ISO timestamp stays a valid ISO timestamp, an identifier stays
    `TEAM-123`-shaped), and re-record so the cassette actually contains the placeholder.

The same header-name rule applies to `STRUCTURAL_HEADERS`.
There is no "allow everything under
this prefix" shortcut and no environment variable to bypass the check.
Classifying an
unclassified field costs a two-line diff to `tests/cassette_scrub.py`.

## What is not classified yet

Linear GraphQL and Pylon REST fields are classified, from the first recorded cassettes
under `tests/live/cassettes/`.
Incident.io, Google Calendar, and Slack fields are added when their first cassette is
recorded,
and until then the verifier rejects them by design.
A dict keyed by workspace data (Google Calendar's `calendars`, keyed by calendar id)
belongs in `KEYED_MAP_JSON_KEYS` — the mechanism exists now, because
`custom_fields` forced it.

## Matching without matching on body

`vcr_config`'s `match_on` is `method, scheme, host, port, path, query`, deliberately
excluding the
request body.
Linear's GraphQL endpoint is a single path for every query, and matching on the
scrubbed body (fixed placeholders in place of every id and timestamp) can't distinguish
one
recorded operation from another anyway.
Keep one interaction per distinct operation in a given
cassette (pytest-recording already scopes one cassette per test by default) rather than
relying on
body matching to disambiguate.
