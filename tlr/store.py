"""Local DuckDB store: schema migrations, provenance-aware upserts, polars-in-polars-out queries.

DuckDB's Python client normally moves data to and from polars through Arrow, which pulls in
`pyarrow`. That is not a project dependency, so every path here goes through plain
parameterized SQL and `pl.DataFrame`'s row constructor instead of `connection.register`/`.pl()`.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb
import polars as pl

SCHEMA_VERSION = 2

_PROVENANCE_COL = 'field_provenance'
_LOCKED_COL = 'locked_fields'
_UPDATED_AT_COL = 'updated_at'

_MIGRATIONS: tuple[tuple[int, tuple[str, ...]], ...] = (
    (
        1,
        (
            'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)',
            """
            CREATE TABLE issues (
                id TEXT PRIMARY KEY,
                identifier TEXT NOT NULL,
                title TEXT,
                description TEXT,
                url TEXT,
                archived_at TIMESTAMP,
                created_at TIMESTAMP,
                estimate DOUBLE,
                priority INTEGER,
                state_name TEXT,
                state_type TEXT,
                team_key TEXT,
                assignee_name TEXT,
                cycle_number INTEGER,
                project_name TEXT,
                project_milestone_id TEXT,
                parent_identifier TEXT,
                field_provenance TEXT NOT NULL,
                locked_fields TEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL
            )
            """,
            'CREATE UNIQUE INDEX issues_identifier_idx ON issues (identifier)',
            """
            CREATE TABLE issue_labels (
                issue_id TEXT NOT NULL,
                label TEXT NOT NULL,
                source TEXT NOT NULL,
                PRIMARY KEY (issue_id, label)
            )
            """,
            """
            CREATE TABLE issue_relations (
                issue_id TEXT NOT NULL,
                relation_type TEXT NOT NULL,
                related_identifier TEXT NOT NULL,
                source TEXT NOT NULL,
                PRIMARY KEY (issue_id, relation_type, related_identifier)
            )
            """,
            """
            CREATE TABLE cycles (
                team_key TEXT NOT NULL,
                number INTEGER NOT NULL,
                starts_at TIMESTAMP,
                ends_at TIMESTAMP,
                PRIMARY KEY (team_key, number)
            )
            """,
            """
            CREATE TABLE allocation_events (
                event_id TEXT PRIMARY KEY,
                person TEXT NOT NULL,
                cycle_team TEXT NOT NULL,
                cycle_number INTEGER NOT NULL,
                issue_id TEXT NOT NULL,
                event_kind TEXT NOT NULL,
                occurred_at TIMESTAMP NOT NULL,
                recorded_at TIMESTAMP NOT NULL,
                source TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE pylon_issues (
                id TEXT PRIMARY KEY,
                number INTEGER,
                title TEXT,
                body TEXT,
                created_at TIMESTAMP,
                link TEXT,
                requester_email TEXT,
                link_status TEXT NOT NULL,
                linear_identifier TEXT,
                field_provenance TEXT NOT NULL,
                locked_fields TEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL
            )
            """,
            """
            CREATE TABLE milestone_scope (
                captured_at TIMESTAMP NOT NULL,
                project_name TEXT,
                milestone_id TEXT NOT NULL,
                milestone_name TEXT,
                issue_id TEXT NOT NULL,
                issue_identifier TEXT,
                estimate DOUBLE,
                state_name TEXT,
                PRIMARY KEY (captured_at, milestone_id, issue_id)
            )
            """,
            """
            CREATE TABLE refresh_runs (
                source TEXT PRIMARY KEY,
                last_run_at TIMESTAMP NOT NULL,
                covered_from TIMESTAMP,
                covered_to TIMESTAMP,
                row_count INTEGER,
                note TEXT
            )
            """,
        ),
    ),
    (
        2,
        (
            'ALTER TABLE pylon_issues ADD COLUMN state TEXT',
            'ALTER TABLE pylon_issues ADD COLUMN state_category TEXT',
            'ALTER TABLE pylon_issues ADD COLUMN priority TEXT',
            'ALTER TABLE pylon_issues ADD COLUMN account_id TEXT',
            'ALTER TABLE pylon_issues ADD COLUMN assignee_id TEXT',
            'ALTER TABLE pylon_issues ADD COLUMN issue_type TEXT',
            'ALTER TABLE pylon_issues ADD COLUMN is_issue_group BOOLEAN',
            'ALTER TABLE pylon_issues ADD COLUMN resolution_time TIMESTAMP',
            'ALTER TABLE pylon_issues ADD COLUMN first_response_time TIMESTAMP',
            'ALTER TABLE pylon_issues ADD COLUMN latest_message_time TIMESTAMP',
            'ALTER TABLE pylon_issues ADD COLUMN source_updated_at TIMESTAMP',
            """
            CREATE TABLE pylon_issue_labels (
                issue_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                label TEXT NOT NULL,
                source TEXT NOT NULL,
                PRIMARY KEY (issue_id, kind, label)
            )
            """,
            """
            CREATE TABLE pylon_accounts (
                id TEXT PRIMARY KEY,
                name TEXT,
                tier TEXT,
                field_provenance TEXT NOT NULL,
                locked_fields TEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL
            )
            """,
        ),
    ),
)

# link_status values for pylon_issues, distinguishing an explicit "no link" from an
# unresolved lookup so a missing link is never mistaken for one that has not been checked.
LINK_STATUS_LINKED = 'linked'
LINK_STATUS_NO_LINK = 'no_link'
LINK_STATUS_UNKNOWN = 'unknown'

MANUAL_SOURCE = 'manual'
"""The one source exempt from the same-source-only rule: a hand correction may always
overwrite whatever source last wrote a field, though a locked field still refuses it."""

_ISSUE_KEY_COLS = ('id',)
_ISSUE_DOMAIN_COLS = (
    'identifier',
    'title',
    'description',
    'url',
    'archived_at',
    'created_at',
    'estimate',
    'priority',
    'state_name',
    'state_type',
    'team_key',
    'assignee_name',
    'cycle_number',
    'project_name',
    'project_milestone_id',
    'parent_identifier',
)
_ISSUE_SCHEMA: dict[str, Any] = {
    'id': pl.Utf8,
    'identifier': pl.Utf8,
    'title': pl.Utf8,
    'description': pl.Utf8,
    'url': pl.Utf8,
    'archived_at': pl.Datetime('us'),
    'created_at': pl.Datetime('us'),
    'estimate': pl.Float64,
    'priority': pl.Int64,
    'state_name': pl.Utf8,
    'state_type': pl.Utf8,
    'team_key': pl.Utf8,
    'assignee_name': pl.Utf8,
    'cycle_number': pl.Int64,
    'project_name': pl.Utf8,
    'project_milestone_id': pl.Utf8,
    'parent_identifier': pl.Utf8,
    _PROVENANCE_COL: pl.Utf8,
    _LOCKED_COL: pl.Utf8,
    _UPDATED_AT_COL: pl.Datetime('us'),
}

_PYLON_KEY_COLS = ('id',)
_PYLON_DOMAIN_COLS = (
    'number',
    'title',
    'body',
    'created_at',
    'link',
    'requester_email',
    'link_status',
    'linear_identifier',
    'state',
    'state_category',
    'priority',
    'account_id',
    'assignee_id',
    'issue_type',
    'is_issue_group',
    'resolution_time',
    'first_response_time',
    'latest_message_time',
    'source_updated_at',
)
_PYLON_SCHEMA: dict[str, Any] = {
    'id': pl.Utf8,
    'number': pl.Int64,
    'title': pl.Utf8,
    'body': pl.Utf8,
    'created_at': pl.Datetime('us'),
    'link': pl.Utf8,
    'requester_email': pl.Utf8,
    'link_status': pl.Utf8,
    'linear_identifier': pl.Utf8,
    'state': pl.Utf8,
    'state_category': pl.Utf8,
    'priority': pl.Utf8,
    'account_id': pl.Utf8,
    'assignee_id': pl.Utf8,
    'issue_type': pl.Utf8,
    'is_issue_group': pl.Boolean,
    'resolution_time': pl.Datetime('us'),
    'first_response_time': pl.Datetime('us'),
    'latest_message_time': pl.Datetime('us'),
    'source_updated_at': pl.Datetime('us'),
    _PROVENANCE_COL: pl.Utf8,
    _LOCKED_COL: pl.Utf8,
    _UPDATED_AT_COL: pl.Datetime('us'),
}

_PYLON_LABEL_COLS = ('issue_id', 'kind', 'label', 'source')
_PYLON_LABEL_SCHEMA: dict[str, Any] = {
    'issue_id': pl.Utf8,
    'kind': pl.Utf8,
    'label': pl.Utf8,
    'source': pl.Utf8,
}

PYLON_LABEL_KIND_TAG = 'tag'
PYLON_LABEL_KIND_QUESTION_TYPE = 'question_type'

_PYLON_ACCOUNT_KEY_COLS = ('id',)
_PYLON_ACCOUNT_DOMAIN_COLS = ('name', 'tier')
_PYLON_ACCOUNT_SCHEMA: dict[str, Any] = {
    'id': pl.Utf8,
    'name': pl.Utf8,
    'tier': pl.Utf8,
    _PROVENANCE_COL: pl.Utf8,
    _LOCKED_COL: pl.Utf8,
    _UPDATED_AT_COL: pl.Datetime('us'),
}

_CYCLE_COLS = ('team_key', 'number', 'starts_at', 'ends_at')
_CYCLE_SCHEMA: dict[str, Any] = {
    'team_key': pl.Utf8,
    'number': pl.Int64,
    'starts_at': pl.Datetime('us'),
    'ends_at': pl.Datetime('us'),
}

_ISSUE_LABEL_COLS = ('issue_id', 'label', 'source')
_ISSUE_LABEL_SCHEMA: dict[str, Any] = {'issue_id': pl.Utf8, 'label': pl.Utf8, 'source': pl.Utf8}

_ISSUE_RELATION_COLS = ('issue_id', 'relation_type', 'related_identifier', 'source')
_ISSUE_RELATION_SCHEMA: dict[str, Any] = {
    'issue_id': pl.Utf8,
    'relation_type': pl.Utf8,
    'related_identifier': pl.Utf8,
    'source': pl.Utf8,
}

_ALLOCATION_EVENT_COLS = (
    'event_id',
    'person',
    'cycle_team',
    'cycle_number',
    'issue_id',
    'event_kind',
    'occurred_at',
    'recorded_at',
    'source',
)
_ALLOCATION_EVENT_SCHEMA: dict[str, Any] = {
    'event_id': pl.Utf8,
    'person': pl.Utf8,
    'cycle_team': pl.Utf8,
    'cycle_number': pl.Int64,
    'issue_id': pl.Utf8,
    'event_kind': pl.Utf8,
    'occurred_at': pl.Datetime('us'),
    'recorded_at': pl.Datetime('us'),
    'source': pl.Utf8,
}

_MILESTONE_SCOPE_COLS = (
    'captured_at',
    'project_name',
    'milestone_id',
    'milestone_name',
    'issue_id',
    'issue_identifier',
    'estimate',
    'state_name',
)
_MILESTONE_SCOPE_SCHEMA: dict[str, Any] = {
    'captured_at': pl.Datetime('us'),
    'project_name': pl.Utf8,
    'milestone_id': pl.Utf8,
    'milestone_name': pl.Utf8,
    'issue_id': pl.Utf8,
    'issue_identifier': pl.Utf8,
    'estimate': pl.Float64,
    'state_name': pl.Utf8,
}

_REFRESH_RUN_COLS = ('source', 'last_run_at', 'covered_from', 'covered_to', 'row_count', 'note')
_REFRESH_RUN_SCHEMA: dict[str, Any] = {
    'source': pl.Utf8,
    'last_run_at': pl.Datetime('us'),
    'covered_from': pl.Datetime('us'),
    'covered_to': pl.Datetime('us'),
    'row_count': pl.Int64,
    'note': pl.Utf8,
}


@contextmanager
def _transaction(con: duckdb.DuckDBPyConnection) -> Iterator[None]:
    """Group statements so a crash mid-write cannot leave a delete without its insert."""
    con.begin()
    try:
        yield
    except Exception:
        con.rollback()
        raise
    else:
        con.commit()


def connect(db_path: Path) -> duckdb.DuckDBPyConnection:
    """Open (creating if absent) the DuckDB file and bring its schema up to `SCHEMA_VERSION`."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    _migrate(con)
    return con


def _current_schema_version(con: duckdb.DuckDBPyConnection) -> int:
    count_row = con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'schema_version'",
    ).fetchone()
    if count_row is None or not count_row[0]:
        return 0
    version_row = con.execute('SELECT version FROM schema_version').fetchone()
    return version_row[0] if version_row else 0


def _migrate(con: duckdb.DuckDBPyConnection) -> None:
    current = _current_schema_version(con)
    for version, statements in _MIGRATIONS:
        if version <= current:
            continue
        with _transaction(con):
            for statement in statements:
                con.execute(statement)
            con.execute('DELETE FROM schema_version')
            con.execute('INSERT INTO schema_version VALUES (?)', [version])


def _query_table(con: duckdb.DuckDBPyConnection, table: str, schema: Mapping[str, Any]) -> pl.DataFrame:
    cols = list(schema.keys())
    col_list = ', '.join(cols)
    rows = con.execute(f'SELECT {col_list} FROM {table}').fetchall()  # noqa: S608
    return pl.DataFrame(rows, schema=schema, orient='row') if rows else pl.DataFrame(schema=schema)


def _insert_rows(con: duckdb.DuckDBPyConnection, table: str, cols: Sequence[str], rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    placeholders = ', '.join(['?'] * len(cols))
    col_list = ', '.join(cols)
    values = [tuple(row[col] for col in cols) for row in rows]
    con.executemany(f'INSERT INTO {table} ({col_list}) VALUES ({placeholders})', values)  # noqa: S608


def _delete_keys(
    con: duckdb.DuckDBPyConnection, table: str, key_cols: Sequence[str], keys: list[tuple[Any, ...]]
) -> None:
    if not keys:
        return
    unique_keys = list(dict.fromkeys(keys))
    where = ' AND '.join(f'{col} = ?' for col in key_cols)
    con.executemany(f'DELETE FROM {table} WHERE {where}', unique_keys)  # noqa: S608


def _fetch_existing(
    con: duckdb.DuckDBPyConnection,
    table: str,
    key_cols: Sequence[str],
    domain_cols: Sequence[str],
    keys: list[tuple[Any, ...]],
) -> dict[tuple[Any, ...], dict[str, Any]]:
    unique_keys = list(dict.fromkeys(keys))
    if not unique_keys:
        return {}
    cols = [*key_cols, *domain_cols, _PROVENANCE_COL, _LOCKED_COL]
    col_list = ', '.join(cols)
    where = ' OR '.join('(' + ' AND '.join(f'{col} = ?' for col in key_cols) + ')' for _ in unique_keys)
    params = [value for key in unique_keys for value in key]
    rows = con.execute(f'SELECT {col_list} FROM {table} WHERE {where}', params).fetchall()  # noqa: S608
    existing = {}
    for row in rows:
        record = dict(zip(cols, row, strict=True))
        existing[tuple(record[col] for col in key_cols)] = record
    return existing


def _merge_row(
    existing: dict[str, Any] | None,
    incoming_row: dict[str, Any],
    present_cols: tuple[str, ...],
    domain_cols: tuple[str, ...],
    source: str,
) -> tuple[dict[str, Any], dict[str, str], list[str]]:
    if existing is None:
        provenance = dict.fromkeys(present_cols, source)
        locked: list[str] = []
        merged = {col: incoming_row.get(col) for col in domain_cols}
        return merged, provenance, locked

    provenance = dict(json.loads(existing[_PROVENANCE_COL]))
    locked = list(json.loads(existing[_LOCKED_COL]))
    merged = {col: existing.get(col) for col in domain_cols}
    for col in present_cols:
        if col in locked:
            continue
        prior_source = provenance.get(col)
        if source != MANUAL_SOURCE and prior_source is not None and prior_source != source:
            continue
        merged[col] = incoming_row.get(col)
        provenance[col] = source
    return merged, provenance, locked


def _upsert_with_provenance(
    con: duckdb.DuckDBPyConnection,
    *,
    table: str,
    key_cols: tuple[str, ...],
    domain_cols: tuple[str, ...],
    incoming: pl.DataFrame,
    source: str,
) -> None:
    if incoming.is_empty():
        return

    present_cols = tuple(col for col in domain_cols if col in incoming.columns)
    incoming_rows = incoming.to_dicts()
    keys = [tuple(row[col] for col in key_cols) for row in incoming_rows]
    existing_by_key = _fetch_existing(con, table, key_cols, domain_cols, keys)

    now = datetime.now(UTC).replace(tzinfo=None)
    all_cols = [*key_cols, *domain_cols, _PROVENANCE_COL, _LOCKED_COL, _UPDATED_AT_COL]
    merged_rows: list[dict[str, Any]] = []
    for incoming_row, key in zip(incoming_rows, keys, strict=True):
        merged, provenance, locked = _merge_row(
            existing_by_key.get(key),
            incoming_row,
            present_cols,
            domain_cols,
            source,
        )
        merged_rows.append(
            {
                **dict(zip(key_cols, key, strict=True)),
                **merged,
                _PROVENANCE_COL: json.dumps(provenance),
                _LOCKED_COL: json.dumps(locked),
                _UPDATED_AT_COL: now,
            }
        )

    with _transaction(con):
        _delete_keys(con, table, key_cols, keys)
        _insert_rows(con, table, all_cols, merged_rows)


def upsert_issues(con: duckdb.DuckDBPyConnection, df: pl.DataFrame, *, source: str) -> None:
    """Merge Linear issue rows keyed on `id`, overwriting only fields `source` is allowed to touch."""
    _upsert_with_provenance(
        con,
        table='issues',
        key_cols=_ISSUE_KEY_COLS,
        domain_cols=_ISSUE_DOMAIN_COLS,
        incoming=df,
        source=source,
    )


def upsert_pylon_issues(con: duckdb.DuckDBPyConnection, df: pl.DataFrame, *, source: str = 'pylon') -> None:
    """Merge Pylon issue rows keyed on `id`, same provenance rule as `upsert_issues`."""
    _upsert_with_provenance(
        con,
        table='pylon_issues',
        key_cols=_PYLON_KEY_COLS,
        domain_cols=_PYLON_DOMAIN_COLS,
        incoming=df,
        source=source,
    )


def upsert_pylon_accounts(con: duckdb.DuckDBPyConnection, df: pl.DataFrame, *, source: str = 'pylon') -> None:
    """Merge Pylon account rows keyed on `id`, same provenance rule as `upsert_issues`.

    No Pylon workspace is required to expose a tier field, so `tier` is often written by hand
    with `source='manual'` and must survive every later refresh.
    """
    _upsert_with_provenance(
        con,
        table='pylon_accounts',
        key_cols=_PYLON_ACCOUNT_KEY_COLS,
        domain_cols=_PYLON_ACCOUNT_DOMAIN_COLS,
        incoming=df,
        source=source,
    )


def upsert_pylon_issue_labels(con: duckdb.DuckDBPyConnection, df: pl.DataFrame, *, source: str = 'pylon') -> None:
    """Replace `source`'s tags and question types for every Pylon issue named in `df`."""
    if df.is_empty():
        return
    rows = df.select('issue_id', 'kind', 'label').to_dicts()
    for row in rows:
        row['source'] = source
    issue_ids = sorted({row['issue_id'] for row in rows})
    placeholders = ', '.join(['?'] * len(issue_ids))
    with _transaction(con):
        con.execute(
            f'DELETE FROM pylon_issue_labels WHERE source = ? AND issue_id IN ({placeholders})',  # noqa: S608
            [source, *issue_ids],
        )
        _insert_rows(con, 'pylon_issue_labels', _PYLON_LABEL_COLS, rows)


def set_locked_fields(con: duckdb.DuckDBPyConnection, *, table: str, key: str, fields: list[str]) -> None:
    """Replace the locked-field list for one `issues` or `pylon_issues` row, freezing it against refreshes."""
    if table not in {'issues', 'pylon_accounts', 'pylon_issues'}:
        msg = f'{table} has no provenance to lock'
        raise ValueError(msg)
    con.execute(f'UPDATE {table} SET locked_fields = ? WHERE id = ?', [json.dumps(fields), key])  # noqa: S608


def upsert_cycles(con: duckdb.DuckDBPyConnection, df: pl.DataFrame) -> None:
    """Upsert cycles keyed on (team_key, number); Linear is the only source, so no provenance merge applies."""
    if df.is_empty():
        return
    rows = df.select(list(_CYCLE_COLS)).to_dicts()
    keys = [(row['team_key'], row['number']) for row in rows]
    with _transaction(con):
        _delete_keys(con, 'cycles', ('team_key', 'number'), keys)
        _insert_rows(con, 'cycles', _CYCLE_COLS, rows)


def upsert_issue_labels(con: duckdb.DuckDBPyConnection, df: pl.DataFrame, *, source: str) -> None:
    """Replace `source`'s labels for every issue named in `df` with exactly the rows given."""
    if df.is_empty():
        return
    rows = df.select('issue_id', 'label').to_dicts()
    for row in rows:
        row['source'] = source
    issue_ids = sorted({row['issue_id'] for row in rows})
    placeholders = ', '.join(['?'] * len(issue_ids))
    with _transaction(con):
        con.execute(
            f'DELETE FROM issue_labels WHERE source = ? AND issue_id IN ({placeholders})',  # noqa: S608
            [source, *issue_ids],
        )
        _insert_rows(con, 'issue_labels', _ISSUE_LABEL_COLS, rows)


def upsert_issue_relations(con: duckdb.DuckDBPyConnection, df: pl.DataFrame, *, source: str) -> None:
    """Replace `source`'s relations for every issue named in `df`, recorded one-directionally as given."""
    if df.is_empty():
        return
    rows = df.select('issue_id', 'relation_type', 'related_identifier').to_dicts()
    for row in rows:
        row['source'] = source
    issue_ids = sorted({row['issue_id'] for row in rows})
    placeholders = ', '.join(['?'] * len(issue_ids))
    with _transaction(con):
        con.execute(
            f'DELETE FROM issue_relations WHERE source = ? AND issue_id IN ({placeholders})',  # noqa: S608
            [source, *issue_ids],
        )
        _insert_rows(con, 'issue_relations', _ISSUE_RELATION_COLS, rows)


def append_allocation_events(con: duckdb.DuckDBPyConnection, df: pl.DataFrame) -> None:
    """Append ledger events; never updates a prior row, since the ledger is append-only."""
    if df.is_empty():
        return
    now = datetime.now(UTC).replace(tzinfo=None)
    rows = df.to_dicts()
    for row in rows:
        row.setdefault('event_id', str(uuid.uuid4()))
        row.setdefault('recorded_at', now)
    _insert_rows(con, 'allocation_events', _ALLOCATION_EVENT_COLS, rows)


def capture_milestone_scope(con: duckdb.DuckDBPyConnection, df: pl.DataFrame) -> None:
    """Append a dated milestone-scope snapshot; the only local record of scope over time."""
    if df.is_empty():
        return
    now = datetime.now(UTC).replace(tzinfo=None)
    rows = df.to_dicts()
    for row in rows:
        row.setdefault('captured_at', now)
    _insert_rows(con, 'milestone_scope', _MILESTONE_SCOPE_COLS, rows)


def record_refresh(
    con: duckdb.DuckDBPyConnection,
    *,
    source: str,
    last_run_at: datetime,
    covered_from: datetime | None = None,
    covered_to: datetime | None = None,
    row_count: int | None = None,
    note: str | None = None,
) -> None:
    """Record the latest refresh for `source`, replacing any prior record for it."""
    with _transaction(con):
        con.execute('DELETE FROM refresh_runs WHERE source = ?', [source])
        con.execute(
            'INSERT INTO refresh_runs VALUES (?, ?, ?, ?, ?, ?)',
            [source, last_run_at, covered_from, covered_to, row_count, note],
        )


def get_issues(con: duckdb.DuckDBPyConnection) -> pl.DataFrame:
    """Return every issue row, provenance and lock columns included."""
    return _query_table(con, 'issues', _ISSUE_SCHEMA)


def get_issue_labels(con: duckdb.DuckDBPyConnection) -> pl.DataFrame:
    """Return every issue-label row."""
    return _query_table(con, 'issue_labels', _ISSUE_LABEL_SCHEMA)


def get_issue_relations(con: duckdb.DuckDBPyConnection, *, symmetrize: bool = False) -> pl.DataFrame:
    """Return relations as recorded, or with the inverse edge added on request.

    Linear reports each relation once on the owning issue, so `symmetrize=True` adds the
    mirrored row rather than assuming the store ever fetched the other side.
    """
    stored = _query_table(con, 'issue_relations', _ISSUE_RELATION_SCHEMA)
    if not symmetrize or stored.is_empty():
        return stored

    issues = _query_table(con, 'issues', {'id': pl.Utf8, 'identifier': pl.Utf8})
    owner_named = stored.join(issues, left_on='issue_id', right_on='id', how='left').rename(
        {'identifier': 'owner_identifier'},
    )
    related_resolved = owner_named.join(issues, left_on='related_identifier', right_on='identifier', how='left').rename(
        {'id': 'related_id'},
    )
    # A related issue outside the fetched scope has no row in `issues`, so its inverse edge
    # cannot be placed and is dropped rather than invented.
    inverse = related_resolved.filter(pl.col('related_id').is_not_null()).select(
        pl.col('related_id').alias('issue_id'),
        pl.col('relation_type'),
        pl.col('owner_identifier').alias('related_identifier'),
        pl.col('source'),
    )
    return pl.concat([stored, inverse], how='vertical').unique(maintain_order=True)


def get_cycles(con: duckdb.DuckDBPyConnection) -> pl.DataFrame:
    """Return every cycle row, keyed on (team_key, number)."""
    return _query_table(con, 'cycles', _CYCLE_SCHEMA)


def get_allocation_events(con: duckdb.DuckDBPyConnection) -> pl.DataFrame:
    """Return the full allocation ledger."""
    return _query_table(con, 'allocation_events', _ALLOCATION_EVENT_SCHEMA)


def get_pylon_issues(con: duckdb.DuckDBPyConnection) -> pl.DataFrame:
    """Return every Pylon issue row, including its link state to a Linear issue."""
    return _query_table(con, 'pylon_issues', _PYLON_SCHEMA)


def get_pylon_issue_labels(con: duckdb.DuckDBPyConnection) -> pl.DataFrame:
    """Return every Pylon tag and question-type row."""
    return _query_table(con, 'pylon_issue_labels', _PYLON_LABEL_SCHEMA)


def get_pylon_accounts(con: duckdb.DuckDBPyConnection) -> pl.DataFrame:
    """Return every Pylon account row, including a tier that may have been set by hand."""
    return _query_table(con, 'pylon_accounts', _PYLON_ACCOUNT_SCHEMA)


def get_milestone_scope(con: duckdb.DuckDBPyConnection) -> pl.DataFrame:
    """Return every captured milestone-scope snapshot."""
    return _query_table(con, 'milestone_scope', _MILESTONE_SCOPE_SCHEMA)


def get_refresh_status(con: duckdb.DuckDBPyConnection) -> pl.DataFrame:
    """Return the latest refresh record per source."""
    return _query_table(con, 'refresh_runs', _REFRESH_RUN_SCHEMA)
