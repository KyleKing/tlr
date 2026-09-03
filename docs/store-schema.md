# Store schema

`tlr/store.py` holds the local DuckDB file every other phase reads and writes.
The DDL lives in its `_MIGRATIONS`. What follows is why each table is keyed the way it
is,
and how a refresh touches a row without clobbering a hand correction.

## Tables

| Table               | Key                                             | Purpose                                                                                            |
| ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `schema_version`    | (single row)                                    | Tracks which migrations have run, so an older file upgrades on open                                |
| `issues`            | `id` (Linear UUID)                              | Linear issues, merged by provenance so a refresh never overwrites a locked or hand-corrected field |
| `issue_labels`      | `(issue_id, label)`                             | Many-to-many labels, replaced per source per issue on each refresh                                 |
| `issue_relations`   | `(issue_id, relation_type, related_identifier)` | Relations exactly as Linear reports them: one-directional                                          |
| `cycles`            | `(team_key, number)`                            | Cycles, since a number is unique only within one team                                              |
| `allocation_events` | `event_id` (append-only)                        | The phase 4 ledger: dated events per person, cycle, and issue                                      |
| `pylon_issues`      | `id` (Pylon UUID)                               | Pylon issues plus their link state to a Linear issue                                               |
| `milestone_scope`   | `(captured_at, milestone_id, issue_id)`         | Dated snapshots of which issues sat in which milestone                                             |
| `refresh_runs`      | `source`                                        | The latest refresh per source: when it ran and what it covered                                     |

## Provenance-aware merge

`issues` and `pylon_issues` are the two tables a scheduled refresh rewrites, and both
carry
`field_provenance` (JSON, column name to the source that last wrote it) and
`locked_fields`
(JSON list) alongside `updated_at`.
`_upsert_with_provenance` (in `tlr/store.py`) enforces one
rule per field on every upsert:

- a locked field is never touched, regardless of which source is writing
- otherwise, a field already owned by a different source is left alone, so an automated
    refresh from `linear` cannot silently overwrite a value `pylon` or a person wrote
- `MANUAL_SOURCE` ('manual') is the one exception to the second rule: a hand correction
    may
    overwrite whatever source owned the field before it, because correcting is the point of
    a
    manual write.
    Locking is still the only way to freeze a value against a *later* manual edit
    or a same-source refresh

A field a source never mentions in its DataFrame is left exactly as it was; only columns
actually present in the incoming frame participate in the merge for that call.
This is what
lets a narrow Pylon-only update (say, just `link_status`) coexist with the fuller row
Linear
already wrote, without either source needing to know the other's columns.

`set_locked_fields` replaces the whole locked list for one row; there is no partial lock
or
unlock helper because freezing a field is a deliberate, whole-value operation done from
the
TUI, not something a refresh should ever need to compute.

## Why the keys are shaped this way

`issues.id` is the Linear UUID because a write back to Linear is refused without it;
`identifier`
(`DEV-123`) is a separate unique-indexed column so lookups by the human-readable id stay
fast
without making it the primary key an issue could theoretically outlive (a team transfer
changes
the identifier, never the UUID).

`cycles` is keyed on `(team_key, number)` because cycle numbers repeat across teams: two
teams
can each have a "cycle 12" with different, overlapping dates.
Number alone would silently merge
them.

`issue_relations` stores exactly what Linear's API returns: a relation appears once, on
the
issue that owns it.
The store never invents the inverse edge; `get_issue_relations(symmetrize=True)`
adds it as a read-time convenience, and only for issues already present in `issues`,
since a
related issue outside the fetched scope has no id to construct the mirrored row from.

`pylon_issues.link_status` is `linked` / `no_link` / `unknown` rather than a nullable
`linear_identifier` alone, because "Pylon confirmed there is no Linear ticket" and "tlr
has not
looked yet" are different facts the triage queue needs to tell apart.

`allocation_events` and `milestone_scope` are both append-only.
The ledger is the source phase 4
derives every capacity number from (DECISIONS.md: "Allocation is a ledger, not a sum of
open
estimates"), so a bug in a downstream aggregation can be fixed by re-deriving, never by
trusting
a mutated summary row.
Milestone scope is captured the same way because it is the one fact
Linear's own history does not retroactively provide, which is why the old snapshot job
existed
in the first place.

`refresh_runs` keeps only the latest row per source (not a log) because the TUI's use of
it is
"how stale is this screen right now", not an audit trail.

## Migrations

`SCHEMA_VERSION` and `_MIGRATIONS` in `tlr/store.py` are the whole mechanism: an ordered
list of
`(version, statements)` tuples, applied in a single pass by `connect()` against whatever
version
the file is already at (0 for a brand new file).
Adding a table or column later means appending a
new `(version, statements)` entry, never editing an already-shipped one.

Every write that replaces rows (the provenance upserts, the label and relation
replacements,
`upsert_cycles`, `record_refresh`, and each migration) runs inside `_transaction`,
because each
one deletes before it inserts and DuckDB otherwise autocommits the delete on its own.
Any new
write that follows that delete-then-insert shape needs the same wrapper or a crash
between the
two statements loses the rows.
