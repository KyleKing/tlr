"""Command dispatch, exercised through the real parser against a real store file."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import polars as pl
import pytest

from tlr import store
from tlr.cli import build_parser
from tlr.services import run
from tlr.sources.alarms import ALARMS_SCHEMA, TRANSITIONS_SCHEMA, AlarmFetch

_CYCLE = 5
_ALEX_ALLOCATED = 8.0

_ROSTER_TOML = """[[capacity.roster]]
name = "Alex Doe"
email = "alex@example.invalid"
points_per_cycle = 10

[[capacity.roster]]
name = "Sam Roe"
email = "sam@example.invalid"
points_per_cycle = 8
"""


def _issue(number: int, *, assignee: str, estimate: float | None, state_type: str) -> dict[str, object]:
    return {
        'id': f'uuid-{number}',
        'identifier': f'DEV-{number}',
        'title': 'Fix the widget',
        'description': None,
        'url': f'https://example.test/DEV-{number}',
        'archived_at': None,
        'created_at': datetime(2026, 8, 1, tzinfo=UTC).replace(tzinfo=None),
        'estimate': estimate,
        'priority': 2,
        'state_name': 'workspace-specific',
        'state_type': state_type,
        'team_key': 'DEV',
        'assignee_name': assignee,
        'cycle_number': _CYCLE,
        'project_name': 'Rebuild',
        'project_milestone_id': None,
        'parent_identifier': None,
    }


@pytest.fixture
def seeded_db(tmp_path: Path) -> Path:
    db_path = tmp_path / 'tlr.duckdb'
    con = store.connect(db_path)
    store.upsert_issues(
        con,
        pl.DataFrame(
            [
                _issue(1, assignee='Alex Doe', estimate=5.0, state_type='completed'),
                _issue(2, assignee='Alex Doe', estimate=3.0, state_type='started'),
                _issue(3, assignee='Alex Doe', estimate=None, state_type='started'),
                _issue(4, assignee='Sam Roe', estimate=13.0, state_type='canceled'),
            ],
        ),
        source='linear',
    )
    store.upsert_cycles(
        con,
        pl.DataFrame(
            {
                'team_key': ['DEV'],
                'number': [_CYCLE],
                'starts_at': [datetime(2026, 8, 25, tzinfo=UTC).replace(tzinfo=None)],
                'ends_at': [datetime(2026, 9, 8, tzinfo=UTC).replace(tzinfo=None)],
            },
        ),
    )
    con.close()
    return db_path


@pytest.fixture
def config_file(tmp_path: Path) -> Path:
    path = tmp_path / 'config.toml'
    path.write_text(_ROSTER_TOML, encoding='utf-8')
    return path


def _run(argv: list[str]) -> int:
    parser = build_parser()
    return run(parser.parse_args(argv), parser)


def test_capacity_reports_every_roster_member_with_an_unestimated_count(
    seeded_db: Path,
    config_file: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = _run(['--config', str(config_file), '--db', str(seeded_db), 'capacity', '--cycle', str(_CYCLE)])

    assert exit_code == 0
    rows = json.loads(capsys.readouterr().out)
    by_person = {row['Person']: row for row in rows}
    assert by_person['Alex Doe']['Allocated points'] == pytest.approx(_ALEX_ALLOCATED)
    assert by_person['Alex Doe']['Allocated unestimated'] == 1
    assert by_person['Sam Roe']['Allocated points'] == pytest.approx(0.0), 'a canceled issue is allocated to nobody'


def test_capacity_markdown_is_pasteable(
    seeded_db: Path,
    config_file: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _run(['--config', str(config_file), '--db', str(seeded_db), 'capacity', '--format', 'md'])

    lines = capsys.readouterr().out.splitlines()
    assert lines[0].startswith('| Person')
    assert 'Allocated unestimated' in lines[0]


def test_capacity_without_a_roster_says_so(tmp_path: Path, seeded_db: Path, capsys: pytest.CaptureFixture[str]) -> None:
    empty = tmp_path / 'empty.toml'
    empty.write_text('', encoding='utf-8')

    exit_code = _run(['--config', str(empty), '--db', str(seeded_db), 'capacity'])

    assert exit_code == 1
    assert 'no roster' in capsys.readouterr().err


def test_config_init_refuses_to_overwrite(config_file: Path, capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = _run(['--config', str(config_file), 'config', 'init'])

    assert exit_code == 1
    assert 'already exists' in capsys.readouterr().err


def test_config_init_writes_the_committed_sample(tmp_path: Path) -> None:
    target = tmp_path / 'nested' / 'config.toml'

    assert _run(['--config', str(target), 'config', 'init']) == 0
    assert '[[capacity.roster]]' in target.read_text(encoding='utf-8')


def test_refresh_dry_run_touches_no_store(
    config_file: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    absent = tmp_path / 'never-created.duckdb'

    exit_code = _run(['--config', str(config_file), '--db', str(absent), 'refresh', '--dry-run'])

    assert exit_code == 0
    assert 'would fetch' in capsys.readouterr().out
    assert not absent.exists(), 'a dry run must not create the database'


def test_refresh_rejects_an_unknown_source(config_file: Path, seeded_db: Path) -> None:
    with pytest.raises(ValueError, match='unknown source'):
        _run(['--config', str(config_file), '--db', str(seeded_db), 'refresh', '--source', 'jira'])


def test_refresh_skips_unconfigured_sources_but_fails_the_run(
    monkeypatch: pytest.MonkeyPatch,
    config_file: Path,
    seeded_db: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def no_pylon_secret(name: str) -> str:
        msg = f'no secret for {name!r}'
        raise LookupError(msg)

    monkeypatch.setattr('tlr.sources.pylon.read_secret', no_pylon_secret)

    exit_code = _run(['--config', str(config_file), '--db', str(seeded_db), 'refresh'])

    assert exit_code == 1
    err = capsys.readouterr().err
    assert 'linear: skipped' in err
    assert 'pylon: skipped' in err
    assert 'sentry: skipped' in err


def _seed_pylon(db_path: Path) -> None:
    con = store.connect(db_path)
    store.upsert_pylon_issues(
        con,
        pl.DataFrame(
            {
                'id': ['py-1', 'py-2', 'py-3'],
                'number': [101, 102, 103],
                'title': ['Widget broke', 'Feature idea', 'Closed one'],
                'created_at': [datetime(2026, 8, 1, tzinfo=UTC).replace(tzinfo=None)] * 3,
                'link': ['https://example.invalid/1', 'https://example.invalid/2', 'https://example.invalid/3'],
                'link_status': ['linked', 'no_link', 'no_link'],
                'linear_identifier': ['DEV-1', None, None],
                'state': ['waiting_on_you', 'waiting_on_you', 'nar'],
                'state_category': ['waiting_on_you', 'waiting_on_you', 'closed'],
                'priority': ['high', 'low', 'low'],
            },
        ),
        source='pylon',
    )
    store.upsert_pylon_issue_labels(
        con,
        pl.DataFrame({'issue_id': ['py-2'], 'kind': ['question_type'], 'label': ['feature_request']}),
    )
    con.close()


def test_triage_orders_the_queue_and_holds_back_an_excluded_row(
    seeded_db: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _seed_pylon(seeded_db)
    config = tmp_path / 'triage.toml'
    config.write_text('[triage]\n[triage.exclusions]\nfeature_request = ["feature_request"]\n', encoding='utf-8')

    exit_code = _run(['--config', str(config), '--db', str(seeded_db), 'triage', '--include-excluded'])

    assert exit_code == 0
    sections = json.loads(capsys.readouterr().out)
    assert [row['Pylon'] for row in sections['Triage queue']] == [101], 'closed and excluded rows leave the queue'
    assert [row['Pylon'] for row in sections['feature_request']] == [102]


def test_triage_markdown_is_pasteable(seeded_db: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _seed_pylon(seeded_db)

    _run(['--db', str(seeded_db), 'triage', '--format', 'md'])

    out = capsys.readouterr().out
    assert out.startswith('## Triage queue')
    assert '| Pylon' in out


def test_backlog_reports_every_section(seeded_db: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _seed_pylon(seeded_db)

    exit_code = _run(['--db', str(seeded_db), 'backlog'])

    assert exit_code == 0
    sections = json.loads(capsys.readouterr().out)
    assert set(sections) == {'Backlog age', 'Close time', 'Stuck tickets', 'Week over week', 'Resolved split'}


def test_snapshot_reports_sentry_not_configured_and_a_pinned_period(
    monkeypatch: pytest.MonkeyPatch,
    seeded_db: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv('SENTRY_AUTH_TOKEN', raising=False)
    monkeypatch.setattr('tlr.secrets.EnvKeychainSecretStore._read_keychain', lambda self, spec: None)  # noqa: ARG005
    _seed_pylon(seeded_db)

    exit_code = _run(['--db', str(seeded_db), 'snapshot', '--period', 'week', '--as-of', '2026-09-03'])

    assert exit_code == 0
    sections = json.loads(capsys.readouterr().out)
    assert sections['Sentry'] == [{'note': 'Sentry: not configured'}]
    assert 'Linear: open by priority' in sections
    assert 'Pylon: top tags' in sections
    freshness = [row['note'] for row in sections['Snapshot'] if row['note'].startswith('Data freshness')]
    assert freshness == ['Data freshness: linear never refreshed, pylon never refreshed, sentry never refreshed.']


_ALARMS_TOML = """[alarms]
command = ["export-alarms"]

[alarms.profiles]
prod = "read-prod"
stage = "read-stage"
"""


def _fake_fetch(alarms_rows: list[dict[str, object]], transition_rows: list[dict[str, object]]) -> object:
    def fetch(_config: object, *, start: datetime, end: datetime | None = None, **_kwargs: object) -> AlarmFetch:
        return AlarmFetch(
            alarms=pl.DataFrame(alarms_rows, schema=ALARMS_SCHEMA),
            transitions=pl.DataFrame(transition_rows, schema=TRANSITIONS_SCHEMA),
        )

    return fetch


def test_alarms_without_configuration_fails(
    config_file: Path,
    seeded_db: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = _run(['--config', str(config_file), '--db', str(seeded_db), 'alarms'])

    assert exit_code == 1
    assert 'no [alarms]' in capsys.readouterr().err


def test_alarms_reports_sections_and_linear_matches(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    seeded_db: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    config = tmp_path / 'alarms.toml'
    config.write_text(_ALARMS_TOML, encoding='utf-8')
    monkeypatch.setattr(
        'tlr.sources.alarms.fetch_alarms',
        _fake_fetch(
            [
                {
                    'env': 'prod',
                    'name': 'svc-prod-api-5xx-critical',
                    'state': 'ALARM',
                    'state_updated': datetime(2026, 10, 7, tzinfo=UTC).replace(tzinfo=None),
                    'namespace': None,
                    'metric_name': None,
                },
            ],
            [
                {
                    'env': 'prod',
                    'alarm_name': 'svc-prod-api-5xx-critical',
                    'occurred_at': datetime(2026, 10, 7, tzinfo=UTC).replace(tzinfo=None),
                    'from_state': 'OK',
                    'to_state': 'ALARM',
                },
            ],
        ),
    )

    exit_code = _run(['--config', str(config), '--db', str(seeded_db), 'alarms', '--days', '7'])

    assert exit_code == 0
    sections = json.loads(capsys.readouterr().out)
    assert 'Alarms: fires by environment' in sections
    assert 'Alarms: all tracked' in sections
    assert sections['Alarms: fires per day — prod'].startswith('```mermaid')
    assert sections['Data freshness'][0]['note'] == 'Data freshness: linear never refreshed.'
    in_alarm = sections['Alarms: in ALARM now']
    assert in_alarm[0]['name'] == 'svc-prod-api-5xx-critical'


def test_alarms_rejects_an_unknown_env(tmp_path: Path, seeded_db: Path, capsys: pytest.CaptureFixture[str]) -> None:
    config = tmp_path / 'alarms.toml'
    config.write_text(_ALARMS_TOML, encoding='utf-8')

    exit_code = _run(['--config', str(config), '--db', str(seeded_db), 'alarms', '--env', 'qa'])

    assert exit_code == 1
    assert 'unknown env' in capsys.readouterr().err


def test_snapshot_reports_alarms_not_configured(
    seeded_db: Path,
    config_file: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = _run(['--config', str(config_file), '--db', str(seeded_db), 'snapshot'])

    assert exit_code == 0
    sections = json.loads(capsys.readouterr().out)
    assert sections['Alarms'] == [{'note': 'Alarms: not configured'}]


def test_snapshot_degrades_to_a_note_when_the_alarm_fetch_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    seeded_db: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    config = tmp_path / 'alarms.toml'
    config.write_text(_ALARMS_TOML, encoding='utf-8')

    def failing_fetch(_config: object, **_kwargs: object) -> object:
        raise FileNotFoundError('export-alarms')

    monkeypatch.setattr('tlr.sources.alarms.fetch_alarms', failing_fetch)

    exit_code = _run(['--config', str(config), '--db', str(seeded_db), 'snapshot'])

    assert exit_code == 0
    sections = json.loads(capsys.readouterr().out)
    assert 'fetch failed' in sections['Alarms'][0]['note']
    assert 'Linear: open by priority' in sections, 'a dead exporter must not take the rest of the snapshot down'


def test_snapshot_includes_alarm_sections_before_the_notable_block(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    seeded_db: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    config = tmp_path / 'alarms.toml'
    config.write_text(_ALARMS_TOML, encoding='utf-8')
    monkeypatch.setattr('tlr.sources.alarms.fetch_alarms', _fake_fetch([], []))

    exit_code = _run(['--config', str(config), '--db', str(seeded_db), 'snapshot', '--as-of', '2026-10-08'])

    assert exit_code == 0
    sections = json.loads(capsys.readouterr().out)
    titles = list(sections)
    assert 'Alarms: fires by environment' in titles
    assert titles.index('Alarms: fires by environment') < titles.index('Notable: not computed')


def test_import_snapshots_dry_run_writes_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    sqlite_path = tmp_path / 'deno.sqlite'
    con = sqlite3.connect(sqlite_path)
    con.execute(
        'CREATE TABLE snapshots (id INTEGER PRIMARY KEY, captured_at INTEGER NOT NULL, label TEXT,'
        ' project_name TEXT NOT NULL, as_of TEXT NOT NULL, json TEXT NOT NULL, project_key TEXT)',
    )
    document = json.dumps(
        {
            'milestones': [{'key': 'M1', 'name': 'Phase 1'}],
            'issues': [{'id': 'DEV-1', 'linearId': 'uuid-1', 'milestone': 'M1', 'estimate': 3, 'status': 'Backlog'}],
        },
    )
    con.execute(
        'INSERT INTO snapshots (id, captured_at, label, project_name, as_of, json) VALUES (1, 0, NULL, ?, ?, ?)',
        ('Rebuild', '2026-01-01', document),
    )
    con.commit()
    con.close()
    absent = tmp_path / 'never-created.duckdb'

    exit_code = _run(['--db', str(absent), 'import-snapshots', str(sqlite_path), '--dry-run'])

    assert exit_code == 0
    assert 'would import 1 row(s)' in capsys.readouterr().out
    assert not absent.exists(), 'a dry run must not create the database'


def test_import_snapshots_refuses_a_second_run(
    seeded_db: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    con = store.connect(seeded_db)
    store.capture_milestone_scope(
        con,
        pl.DataFrame(
            {
                'captured_at': [datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)],
                'project_name': ['Rebuild'],
                'milestone_id': ['M1'],
                'milestone_name': ['Phase 1'],
                'issue_id': ['uuid-1'],
                'issue_identifier': ['DEV-1'],
                'estimate': [3.0],
                'state_name': ['Backlog'],
            },
        ),
    )
    con.close()

    exit_code = _run(['--db', str(seeded_db), 'import-snapshots', str(tmp_path / 'unused.sqlite')])

    assert exit_code == 1
    assert 'runs once' in capsys.readouterr().err
