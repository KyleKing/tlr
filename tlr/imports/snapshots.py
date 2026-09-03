"""One-time reader for the frozen Deno app's `tlr.sqlite` snapshot export.

Each `snapshots` row holds a whole plan document as JSON, up to 11.5 MB and 8552 issues.
The reader streams rows one at a time so the importer never holds more than one
snapshot's parsed document in memory.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import polars as pl

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

_EPOCH = datetime(1970, 1, 1)  # noqa: DTZ001


@dataclass
class SnapshotRow:
    """One `snapshots` table row, JSON still unparsed."""

    id: int
    captured_at_ms: int
    project_name: str
    json_text: str


@dataclass
class ImportSummary:
    """Counts the CLI reports after driving the import to completion."""

    snapshots_read: int
    rows_written: int
    rows_dropped_no_milestone: int


def read_snapshot_rows(sqlite_path: Path) -> Iterator[SnapshotRow]:
    """Stream every `snapshots` row from `sqlite_path`, opened read-only.

    Iterates the cursor directly rather than `fetchall()`, so at most one row's JSON
    blob is held in memory at a time.

    Yields:
        One `SnapshotRow` per `snapshots` table row, ordered by `id`.

    """
    if not sqlite_path.exists():
        msg = f'Snapshot database not found: {sqlite_path}'
        raise FileNotFoundError(msg)
    con = sqlite3.connect(f'file:{sqlite_path}?mode=ro', uri=True)
    try:
        table = con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'",
        ).fetchone()
        if table is None:
            msg = f'{sqlite_path} has no `snapshots` table'
            raise ValueError(msg)
        cursor = con.execute('SELECT id, captured_at, project_name, json FROM snapshots ORDER BY id')
        for row_id, captured_at_ms, project_name, json_text in cursor:
            yield SnapshotRow(
                id=row_id,
                captured_at_ms=captured_at_ms,
                project_name=project_name,
                json_text=json_text,
            )
    finally:
        con.close()


def parse_snapshot_document(json_text: str, snapshot_id: int) -> dict[str, Any]:
    """Parse one snapshot's `json` blob, failing loud with the snapshot `id` on any defect."""
    try:
        document = json.loads(json_text)
    except json.JSONDecodeError as error:
        msg = f'Snapshot {snapshot_id} has invalid JSON: {error}'
        raise ValueError(msg) from error
    if not isinstance(document, dict):
        msg = f'Snapshot {snapshot_id} is not a JSON object'
        raise TypeError(msg)
    if not isinstance(document.get('issues'), list):
        msg = f'Snapshot {snapshot_id} has no `issues` list'
        raise TypeError(msg)
    return document


def build_milestone_scope_frame(
    document: dict[str, Any],
    *,
    captured_at_ms: int,
    project_name: str,
) -> tuple[pl.DataFrame, int]:
    """Turn one parsed snapshot document into a `milestone_scope`-shaped frame.

    Drops an issue with no milestone (it cannot be keyed) and one with no `linearId`,
    deduplicating on the `(milestone_id, issue_id)` primary key within the snapshot.
    Returns the frame and the count dropped for a missing milestone.
    """
    milestone_names = {milestone['key']: milestone.get('name') for milestone in document.get('milestones') or []}
    captured_at = _EPOCH + timedelta(milliseconds=captured_at_ms)
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    dropped_no_milestone = 0
    for issue in document['issues']:
        milestone_id = issue.get('milestone')
        if not milestone_id:
            dropped_no_milestone += 1
            continue
        issue_id = issue.get('linearId')
        if not issue_id:
            continue
        key = (milestone_id, issue_id)
        if key in rows:
            continue
        rows[key] = {
            'captured_at': captured_at,
            'project_name': project_name,
            'milestone_id': milestone_id,
            'milestone_name': milestone_names.get(milestone_id),
            'issue_id': issue_id,
            'issue_identifier': issue.get('id'),
            'estimate': issue.get('estimate'),
            'state_name': issue.get('status'),
        }
    frame = (
        pl.DataFrame(list(rows.values()), schema=_MILESTONE_SCOPE_SCHEMA)
        if rows
        else pl.DataFrame(schema=_MILESTONE_SCOPE_SCHEMA)
    )
    return frame, dropped_no_milestone


def import_snapshots(sqlite_path: Path, writer: Callable[[pl.DataFrame], None]) -> ImportSummary:
    """Drive the one-time import: read, parse, and hand each snapshot's frame to `writer`.

    Passing a writer that counts and discards its argument gives a dry run.
    """
    snapshots_read = 0
    rows_written = 0
    rows_dropped_no_milestone = 0
    for row in read_snapshot_rows(sqlite_path):
        document = parse_snapshot_document(row.json_text, row.id)
        frame, dropped = build_milestone_scope_frame(
            document,
            captured_at_ms=row.captured_at_ms,
            project_name=row.project_name,
        )
        writer(frame)
        snapshots_read += 1
        rows_written += frame.height
        rows_dropped_no_milestone += dropped
    return ImportSummary(
        snapshots_read=snapshots_read,
        rows_written=rows_written,
        rows_dropped_no_milestone=rows_dropped_no_milestone,
    )
