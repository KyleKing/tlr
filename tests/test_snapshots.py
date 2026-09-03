"""Tests for the one-time Deno snapshot importer, against synthetic SQLite files."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path

import polars as pl
import pytest

from tlr.imports import snapshots

_ISSUE: dict[str, object] = {
    'id': 'DEV-1',
    'linearId': 'uuid-1',
    'milestone': 'M1',
    'estimate': 3.0,
    'status': 'Backlog',
}


def _make_db(tmp_path: Path, rows: list[tuple[int, int, str, str]]) -> Path:
    db_path = tmp_path / 'tlr.sqlite'
    con = sqlite3.connect(db_path)
    con.execute(
        """
        CREATE TABLE snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at INTEGER NOT NULL, label TEXT,
            project_name TEXT NOT NULL, as_of TEXT NOT NULL, json TEXT NOT NULL, project_key TEXT
        )
        """,
    )
    values = [
        (row_id, captured_at, 'scheduled', project_name, '2026-01-01', json_text)
        for row_id, captured_at, project_name, json_text in rows
    ]
    con.executemany(
        'INSERT INTO snapshots (id, captured_at, label, project_name, as_of, json) VALUES (?, ?, ?, ?, ?, ?)',
        values,
    )
    con.commit()
    con.close()
    return db_path


def _document(*issues: Mapping[str, object], milestones: list[dict[str, object]] | None = None) -> str:
    body = {
        'project': {'name': 'Rebuild'},
        'milestones': milestones if milestones is not None else [{'key': 'M1', 'name': 'Foundations'}],
        'issues': list(issues),
    }
    return json.dumps(body)


def test_read_snapshot_rows_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        list(snapshots.read_snapshot_rows(tmp_path / 'missing.sqlite'))


def test_read_snapshot_rows_missing_table_raises(tmp_path: Path) -> None:
    db_path = tmp_path / 'empty.sqlite'
    sqlite3.connect(db_path).execute('CREATE TABLE unrelated (id INTEGER)').connection.commit()
    with pytest.raises(ValueError, match='snapshots'):
        list(snapshots.read_snapshot_rows(db_path))


def test_epoch_ms_converts_to_naive_datetime() -> None:
    document = json.loads(_document(_ISSUE))
    frame, _dropped = snapshots.build_milestone_scope_frame(
        document,
        captured_at_ms=1_735_689_600_000,
        project_name='Rebuild',
    )
    captured_at = frame['captured_at'].to_list()[0]
    assert captured_at == datetime(2025, 1, 1)  # noqa: DTZ001
    assert captured_at.tzinfo is None


def test_issue_with_no_milestone_is_dropped_and_counted() -> None:
    with_milestone = {**_ISSUE, 'id': 'DEV-1', 'linearId': 'uuid-1'}
    without_milestone = {**_ISSUE, 'id': 'DEV-2', 'linearId': 'uuid-2', 'milestone': None}
    document = json.loads(_document(with_milestone, without_milestone))
    frame, dropped = snapshots.build_milestone_scope_frame(document, captured_at_ms=0, project_name='Rebuild')
    assert frame['issue_identifier'].to_list() == ['DEV-1']
    assert dropped == 1


def test_issue_with_no_linear_id_is_dropped_without_counting_as_missing_milestone() -> None:
    document = json.loads(_document({**_ISSUE, 'linearId': None}))
    frame, dropped = snapshots.build_milestone_scope_frame(document, captured_at_ms=0, project_name='Rebuild')
    assert frame.height == 0
    assert dropped == 0


@pytest.mark.parametrize(
    ('milestone_key', 'expected_name'),
    [
        ('M1', 'Foundations'),
        ('M9', None),
    ],
)
def test_milestone_key_resolves_to_name(milestone_key: str, expected_name: str | None) -> None:
    document = json.loads(_document({**_ISSUE, 'milestone': milestone_key}))
    frame, _dropped = snapshots.build_milestone_scope_frame(document, captured_at_ms=0, project_name='Rebuild')
    assert frame['milestone_name'].to_list() == [expected_name]


def test_linear_id_and_identifier_land_in_the_right_columns() -> None:
    document = json.loads(_document(_ISSUE))
    frame, _dropped = snapshots.build_milestone_scope_frame(document, captured_at_ms=0, project_name='Rebuild')
    assert frame['issue_id'].to_list() == ['uuid-1']
    assert frame['issue_identifier'].to_list() == ['DEV-1']


def test_malformed_json_names_the_snapshot_id() -> None:
    with pytest.raises(ValueError, match='Snapshot 7'):
        snapshots.parse_snapshot_document('not json', snapshot_id=7)


def test_malformed_document_shape_names_the_snapshot_id() -> None:
    with pytest.raises(TypeError, match='Snapshot 3'):
        snapshots.parse_snapshot_document(json.dumps({'no': 'issues'}), snapshot_id=3)


def test_import_snapshots_streams_rather_than_parsing_every_row_upfront(tmp_path: Path) -> None:
    db_path = _make_db(
        tmp_path,
        [
            (1, 0, 'Rebuild', _document(_ISSUE)),
            (2, 0, 'Rebuild', 'not json at all'),
        ],
    )
    written: list[pl.DataFrame] = []

    with pytest.raises(ValueError, match='Snapshot 2'):
        snapshots.import_snapshots(db_path, written.append)

    assert len(written) == 1, 'the first snapshot must reach the writer before the second is parsed'
