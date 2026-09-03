"""Command dispatch, exercised through the real parser against a real store file."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import polars as pl
import pytest

from tlr import store
from tlr.cli import build_parser
from tlr.services import run

_CYCLE = 5
_ALEX_ALLOCATED = 8.0
_UNBUILT_EXIT = 2

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


@pytest.mark.parametrize('command', ['triage', 'backlog'])
def test_unbuilt_commands_exit_two_naming_the_phase(command: str, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc_info:
        _run([command])

    assert exc_info.value.code == _UNBUILT_EXIT
    assert 'phase 2' in capsys.readouterr().err
