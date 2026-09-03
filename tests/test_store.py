"""Tests for the DuckDB store, run against a real file under `tmp_path`."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import duckdb
import polars as pl
import pytest

from tlr import store

_ORIGINAL_ESTIMATE = 3.0
_EXPECTED_SYMMETRIZED_ROWS = 2
_EXPECTED_CYCLE_ROWS = 2
_EXPECTED_SCOPE_ROWS = 2


def _issue_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        'id': 'uuid-1',
        'identifier': 'DEV-1',
        'title': 'Original title',
        'description': 'desc',
        'url': 'https://example.test/DEV-1',
        'archived_at': None,
        'created_at': datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None),
        'estimate': 3.0,
        'priority': 2,
        'state_name': 'Todo',
        'state_type': 'unstarted',
        'team_key': 'DEV',
        'assignee_name': 'Unassigned',
        'cycle_number': 5,
        'project_name': 'Rebuild',
        'project_milestone_id': None,
        'parent_identifier': None,
    }
    row.update(overrides)
    return row


def test_connect_creates_schema_and_is_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / 'tlr.duckdb'
    con = store.connect(db_path)
    assert store._current_schema_version(con) == store.SCHEMA_VERSION  # noqa: SLF001
    con.close()

    reopened = store.connect(db_path)
    assert store._current_schema_version(reopened) == store.SCHEMA_VERSION  # noqa: SLF001
    reopened.close()


def test_upsert_issues_requires_uuid_key(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')
    df = pl.DataFrame([_issue_row()])
    store.upsert_issues(con, df, source='linear')

    result = store.get_issues(con)
    assert result['id'].to_list() == ['uuid-1']
    assert result['identifier'].to_list() == ['DEV-1']
    con.close()


def test_refresh_merges_by_provenance_and_respects_lock(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')

    store.upsert_issues(con, pl.DataFrame([_issue_row(title='From Linear', estimate=3.0)]), source='linear')

    # A hand correction to `title` alone, attributed to a different source.
    store.upsert_issues(
        con,
        pl.DataFrame([{'id': 'uuid-1', 'title': 'Hand-corrected title'}]),
        source='manual',
    )

    # Lock `estimate` so no automated refresh may ever touch it again.
    store.set_locked_fields(con, table='issues', key='uuid-1', fields=['estimate'])

    # A Linear refresh tries to overwrite both the manually-corrected title and the locked estimate.
    store.upsert_issues(
        con,
        pl.DataFrame([_issue_row(title='From Linear, refreshed', estimate=8.0, state_name='In Progress')]),
        source='linear',
    )

    row = store.get_issues(con).to_dicts()[0]
    assert row['title'] == 'Hand-corrected title', 'linear must not overwrite a field manual last wrote'
    assert row['estimate'] == pytest.approx(_ORIGINAL_ESTIMATE), 'a locked field must survive an automated refresh'
    assert row['state_name'] == 'In Progress', 'fields linear owns still refresh normally'

    provenance = json.loads(row['field_provenance'])
    assert provenance['title'] == 'manual'
    assert provenance['state_name'] == 'linear'
    assert json.loads(row['locked_fields']) == ['estimate']

    con.close()


def test_upsert_pylon_issues_link_states(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')
    df = pl.DataFrame(
        [
            {
                'id': 'pylon-1',
                'number': 100,
                'title': 'Ticket',
                'body': 'body',
                'created_at': datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None),
                'link': 'https://usepylon.test/1',
                'requester_email': 'a@example.test',
                'link_status': store.LINK_STATUS_NO_LINK,
                'linear_identifier': None,
            },
        ]
    )
    store.upsert_pylon_issues(con, df)

    result = store.get_pylon_issues(con).to_dicts()[0]
    assert result['link_status'] == store.LINK_STATUS_NO_LINK
    assert result['linear_identifier'] is None
    con.close()


def test_issue_relations_stored_one_directional_and_symmetrize_adds_inverse(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')
    store.upsert_issues(con, pl.DataFrame([_issue_row(id='uuid-1', identifier='DEV-1')]), source='linear')
    store.upsert_issues(con, pl.DataFrame([_issue_row(id='uuid-2', identifier='DEV-2')]), source='linear')

    store.upsert_issue_relations(
        con,
        pl.DataFrame([{'issue_id': 'uuid-1', 'relation_type': 'blocks', 'related_identifier': 'DEV-2'}]),
        source='linear',
    )

    as_recorded = store.get_issue_relations(con)
    assert len(as_recorded) == 1
    assert as_recorded['issue_id'].to_list() == ['uuid-1']

    symmetrized = store.get_issue_relations(con, symmetrize=True)
    assert len(symmetrized) == _EXPECTED_SYMMETRIZED_ROWS
    assert set(symmetrized['issue_id'].to_list()) == {'uuid-1', 'uuid-2'}
    con.close()


def test_allocation_events_are_append_only(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')
    occurred_at = datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)
    event = {
        'person': 'Alex',
        'cycle_team': 'DEV',
        'cycle_number': 5,
        'issue_id': 'uuid-1',
        'event_kind': 'assigned',
        'occurred_at': occurred_at,
        'source': 'linear',
    }
    store.append_allocation_events(con, pl.DataFrame([event]))
    store.append_allocation_events(con, pl.DataFrame([{**event, 'event_kind': 'done'}]))

    events = store.get_allocation_events(con)
    assert sorted(events['event_kind'].to_list()) == ['assigned', 'done']
    con.close()


def test_cycles_keyed_on_team_and_number(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')
    starts_at = datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)
    ends_at = datetime(2026, 1, 15, tzinfo=UTC).replace(tzinfo=None)
    store.upsert_cycles(
        con,
        pl.DataFrame(
            [
                {'team_key': 'DEV', 'number': 12, 'starts_at': starts_at, 'ends_at': ends_at},
                {'team_key': 'CUS', 'number': 12, 'starts_at': starts_at, 'ends_at': ends_at},
            ]
        ),
    )
    cycles = store.get_cycles(con)
    assert len(cycles) == _EXPECTED_CYCLE_ROWS, 'cycle 12 for two teams must not collide'
    con.close()


def test_milestone_scope_capture_is_append_only(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')
    snapshot = {
        'captured_at': datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None),
        'project_name': 'Rebuild',
        'milestone_id': 'm1',
        'milestone_name': 'Phase 1',
        'issue_id': 'uuid-1',
        'issue_identifier': 'DEV-1',
        'estimate': 3.0,
        'state_name': 'Todo',
    }
    store.capture_milestone_scope(con, pl.DataFrame([snapshot]))
    store.capture_milestone_scope(
        con, pl.DataFrame([{**snapshot, 'captured_at': datetime(2026, 1, 2, tzinfo=UTC).replace(tzinfo=None)}])
    )

    scope = store.get_milestone_scope(con)
    assert len(scope) == _EXPECTED_SCOPE_ROWS
    con.close()


def test_record_refresh_tracks_latest_run_per_source(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')
    now = datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)
    store.record_refresh(con, source='linear', last_run_at=now, row_count=10)
    later = datetime(2026, 1, 2, tzinfo=UTC).replace(tzinfo=None)
    store.record_refresh(con, source='linear', last_run_at=later, row_count=20)

    status = store.get_refresh_status(con)
    assert len(status) == 1, 'only the latest run per source is kept'
    assert status['row_count'].to_list() == [20]
    con.close()


def test_failed_upsert_rolls_back_the_delete(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')
    store.upsert_issue_labels(con, pl.DataFrame({'issue_id': ['uuid-1'], 'label': ['bug']}), source='linear')

    with pytest.raises(duckdb.ConstraintException):
        store.upsert_issue_labels(con, pl.DataFrame({'issue_id': ['uuid-1'], 'label': [None]}), source='linear')

    labels = store.get_issue_labels(con)
    assert labels['label'].to_list() == ['bug'], 'a rolled-back replace must not leave the row deleted'
    con.close()


def test_migration_two_upgrades_a_v1_file_keeping_its_rows(tmp_path: Path) -> None:
    db_path = tmp_path / 'v1.duckdb'
    con = duckdb.connect(str(db_path))
    for statement in store._MIGRATIONS[0][1]:  # noqa: SLF001
        con.execute(statement)
    con.execute('INSERT INTO schema_version VALUES (1)')
    con.execute(
        'INSERT INTO pylon_issues (id, link_status, field_provenance, locked_fields, updated_at)'
        " VALUES ('issue-1', 'linked', '{}', '[]', now())",
    )
    con.close()

    upgraded = store.connect(db_path)
    rows = store.get_pylon_issues(upgraded)

    assert rows['id'].to_list() == ['issue-1'], 'the upgrade must not drop existing rows'
    assert rows['state_category'].to_list() == [None]
    assert store.get_pylon_issue_labels(upgraded).is_empty()
    assert store.get_pylon_accounts(upgraded).is_empty()
    upgraded.close()


def test_a_hand_set_tier_survives_a_later_pylon_refresh(tmp_path: Path) -> None:
    con = store.connect(tmp_path / 'tlr.duckdb')
    store.upsert_pylon_accounts(con, pl.DataFrame({'id': ['acct-1'], 'name': ['Example'], 'tier': [None]}))
    store.upsert_pylon_accounts(
        con,
        pl.DataFrame({'id': ['acct-1'], 'tier': ['enterprise']}),
        source=store.MANUAL_SOURCE,
    )
    store.upsert_pylon_accounts(con, pl.DataFrame({'id': ['acct-1'], 'name': ['Example Renamed'], 'tier': [None]}))

    row = store.get_pylon_accounts(con).row(0, named=True)

    assert row['tier'] == 'enterprise'
    assert row['name'] == 'Example Renamed'
    con.close()
