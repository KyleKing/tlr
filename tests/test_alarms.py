"""Tests for the alarms domain and the NDJSON exporter adapter."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import polars as pl
import pytest

from tlr.config import AlarmsConfig
from tlr.domain import alarms
from tlr.domain.snapshot import PeriodWindow
from tlr.sources import alarms as alarms_source

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=UTC).replace(tzinfo=None)  # a Thursday
WEEK = timedelta(days=7)


def _window(days: int = 7) -> PeriodWindow:
    span = timedelta(days=days)
    return PeriodWindow(start=NOW - span, end=NOW, previous_start=NOW - 2 * span, previous_end=NOW - span)


def _config(**overrides: Any) -> AlarmsConfig:
    return replace(
        AlarmsConfig(
            command=['export-alarms'],
            profiles={'prod': 'read-prod', 'stage': 'read-stage'},
            categories={'api': ['*-api-*'], 'worker': ['*-worker-*']},
            severity_suffixes=['critical', 'warning'],
        ),
        **overrides,
    )


def _frame(by_title: dict[str, pl.DataFrame | str], title: str) -> pl.DataFrame:
    body = by_title[title]
    assert isinstance(body, pl.DataFrame)
    return body


def _alarm_row(env: str = 'prod', name: str = 'svc-prod-api-5xx-critical', **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        'env': env,
        'name': name,
        'state': 'OK',
        'state_updated': None,
        'namespace': None,
        'metric_name': None,
    }
    row.update(overrides)
    return row


def _alarms_frame(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(list(rows), schema=alarms_source.ALARMS_SCHEMA)


def _transition(
    env: str,
    name: str,
    at: datetime,
    to_state: str,
    from_state: str = 'OK',
) -> dict[str, object]:
    return {'env': env, 'alarm_name': name, 'occurred_at': at, 'from_state': from_state, 'to_state': to_state}


def _transitions_frame(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(list(rows), schema=alarms_source.TRANSITIONS_SCHEMA)


def _issues_frame(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(
        list(rows),
        schema={
            'id': pl.Utf8,
            'identifier': pl.Utf8,
            'title': pl.Utf8,
            'url': pl.Utf8,
            'created_at': pl.Datetime('us'),
            'archived_at': pl.Datetime('us'),
            'completed_at': pl.Datetime('us'),
            'canceled_at': pl.Datetime('us'),
            'state_name': pl.Utf8,
        },
    )


def _issue(number: int, title: str, *, completed: bool = False) -> dict[str, object]:
    return {
        'id': f'uuid-{number}',
        'identifier': f'DEV-{number}',
        'title': title,
        'url': f'https://linear.test/issue/DEV-{number}',
        'created_at': NOW - timedelta(days=30),
        'archived_at': None,
        'completed_at': (NOW - timedelta(days=1)) if completed else None,
        'canceled_at': None,
        'state_name': 'Done' if completed else 'Todo',
    }


def test_export_argv_appends_profile_and_window() -> None:
    argv = alarms_source.export_argv(
        ['uv', 'run', '--project', '~/tail-cw', 'tail-cw', 'export', 'alarms'],
        profile='read-prod',
        start=NOW - WEEK,
        end=NOW,
    )

    assert '~' not in argv[3]
    assert argv[-7:] == [
        '--profile',
        'read-prod',
        '--history',
        '--start',
        (NOW - WEEK).isoformat(),
        '--end',
        NOW.isoformat(),
    ]


def test_parse_export_reads_alarms_and_transitions() -> None:
    record = {
        'name': 'svc-prod-api-5xx-critical',
        'state': 'OK',
        'state_updated': '2026-10-07T06:13:23.393000+00:00',
        'namespace': 'svc/prod',
        'metric_name': 'Http5xx',
        'history': [
            {'moment': '2026-10-07T06:09:23+00:00', 'summary': 'Alarm updated from OK to ALARM'},
            {'moment': '2026-10-07T06:13:23+00:00', 'summary': 'Alarm updated from ALARM to OK'},
        ],
    }

    parsed = alarms_source.parse_export(json.dumps(record) + '\n', env='prod')

    assert parsed.alarms.to_dicts() == [
        {
            'env': 'prod',
            'name': 'svc-prod-api-5xx-critical',
            'state': 'OK',
            'state_updated': datetime(2026, 10, 7, 6, 13, 23, 393000, tzinfo=UTC).replace(tzinfo=None),
            'namespace': 'svc/prod',
            'metric_name': 'Http5xx',
        },
    ]
    assert parsed.transitions['to_state'].to_list() == ['ALARM', 'OK']
    assert parsed.transitions['from_state'].to_list() == ['OK', 'ALARM']
    expected_moment = datetime(2026, 10, 7, 6, 9, 23, tzinfo=UTC).replace(tzinfo=None)
    assert parsed.transitions['occurred_at'].item(0) == expected_moment


def test_parse_export_tolerates_unrecognized_history_summaries() -> None:
    record = {
        'name': 'a-critical',
        'state': 'OK',
        'state_updated': None,
        'history': [{'moment': '2026-10-07T00:00:00+00:00', 'summary': 'something AWS did not phrase as expected'}],
    }

    parsed = alarms_source.parse_export(json.dumps(record), env='prod')

    row = parsed.transitions.to_dicts()[0]
    assert row['from_state'] is None
    assert row['to_state'] is None


def test_parse_export_empty_input_yields_empty_frames() -> None:
    parsed = alarms_source.parse_export('', env='prod')

    assert parsed.alarms.is_empty()
    assert parsed.alarms.columns == list(alarms_source.ALARMS_SCHEMA)
    assert parsed.transitions.is_empty()


def test_fetch_alarms_runs_once_per_profile_and_tags_env() -> None:
    record: dict[str, object] = {'name': 'svc-api-critical', 'state': 'OK', 'state_updated': None, 'history': []}
    calls: list[list[str]] = []

    def runner(argv: list[str]) -> str:
        calls.append(argv)
        return json.dumps(record)

    config = _config()
    fetched = alarms_source.fetch_alarms(config, start=NOW - WEEK, end=NOW, runner=runner)

    assert len(calls) == len(config.profiles)
    assert calls[0][calls[0].index('--profile') + 1] == 'read-prod'
    assert calls[1][calls[1].index('--profile') + 1] == 'read-stage'
    assert fetched.alarms['env'].to_list() == ['prod', 'stage']


_CATEGORIES = {'api': ['*-api-*'], 'worker': ['*-worker-*']}


@pytest.mark.parametrize(
    ('name', 'categories', 'suffixes', 'expected'),
    [
        ('svc-api-5xx-critical', _CATEGORIES, ['critical'], ('api', 'critical')),
        ('svc-worker-stop-critical', _CATEGORIES, ['critical'], ('worker', 'critical')),
        ('svc-api-5xx-critical', {'broad': ['*'], 'api': ['*-api-*']}, ['critical'], ('broad', 'critical')),
        ('other-thing', _CATEGORIES, ['critical'], (alarms.UNCATEGORIZED, '')),
        ('svc-api-5xx-flaky', _CATEGORIES, ['critical'], ('api', '')),
        ('svc-api-review-timed-out-low-urgency', _CATEGORIES, ['low-urgency', 'warning'], ('api', 'low-urgency')),
        ('svc-low-urgency-api-errors-warning', _CATEGORIES, ['low-urgency', 'warning'], ('api', 'warning')),
    ],
    ids=[
        'api-hit',
        'worker-hit',
        'first-match-wins',
        'uncategorized',
        'no-severity-suffix',
        'multi-word-suffix',
        'suffix-not-category',
    ],
)
def test_categorize_name(name, categories, suffixes, expected) -> None:
    assert alarms.categorize_name(name, categories=categories, severity_suffixes=suffixes) == expected


def test_fire_counts_only_transitions_into_alarm_within_the_window() -> None:
    transitions = _transitions_frame(
        _transition('prod', 'a', NOW - timedelta(days=1), 'ALARM'),
        _transition('prod', 'a', NOW - timedelta(hours=1), 'ALARM'),
        _transition('prod', 'a', NOW - timedelta(minutes=30), 'OK', from_state='ALARM'),
        _transition('prod', 'b', NOW - timedelta(days=1), 'INSUFFICIENT_DATA'),
        _transition('prod', 'a', NOW - WEEK - timedelta(hours=1), 'ALARM'),  # before the window
        _transition('prod', 'a', NOW, 'ALARM'),  # end is exclusive
    )

    counts = alarms.fire_counts(transitions, start=NOW - WEEK, end=NOW)

    assert counts.to_dicts() == [{'env': 'prod', 'name': 'a', 'fires': 2}]


def test_alarm_period_table_reports_fires_previous_and_delta() -> None:
    meta = alarms.with_alarm_meta(
        _alarms_frame(_alarm_row(name='svc-prod-api-5xx-critical'), _alarm_row(name='svc-prod-quiet-critical')),
        _config(),
    )
    transitions = _transitions_frame(
        _transition('prod', 'svc-prod-api-5xx-critical', NOW - timedelta(days=1), 'ALARM'),
        _transition('prod', 'svc-prod-api-5xx-critical', NOW - timedelta(days=2), 'ALARM'),
        _transition('prod', 'svc-prod-api-5xx-critical', NOW - WEEK - timedelta(days=1), 'ALARM'),
    )

    table = alarms.alarm_period_table(meta, transitions, window=_window())

    rows = {row['name']: row for row in table.to_dicts()}
    fired = rows['svc-prod-api-5xx-critical']
    assert (fired['fires'], fired['previous'], fired['delta']) == (2, 1, 1)
    assert fired['category'] == 'api'
    quiet = rows['svc-prod-quiet-critical']
    assert (quiet['fires'], quiet['previous'], quiet['delta']) == (0, 0, 0)
    assert quiet['category'] == alarms.UNCATEGORIZED


def test_time_in_alarm_sums_dwell_between_alarm_and_recovery() -> None:
    meta = alarms.with_alarm_meta(_alarms_frame(_alarm_row(name='svc-prod-api-5xx-critical')), _config())
    transitions = _transitions_frame(
        _transition('prod', 'svc-prod-api-5xx-critical', NOW - timedelta(days=2), 'ALARM'),
        _transition(
            'prod', 'svc-prod-api-5xx-critical', NOW - timedelta(days=2) + timedelta(minutes=30), 'OK',
            from_state='ALARM',
        ),
        _transition('prod', 'svc-prod-api-5xx-critical', NOW - timedelta(hours=1), 'ALARM'),
    )

    dwell = alarms.time_in_alarm(meta, transitions, start=NOW - WEEK, end=NOW)

    assert dwell['mins_in_alarm'].to_list() == [90]  # 30m recovered + 60m still in ALARM at window end


def test_time_in_alarm_falls_back_to_meta_state_when_history_is_empty() -> None:
    meta = alarms.with_alarm_meta(
        _alarms_frame(
            _alarm_row(name='svc-prod-api-stuck-critical', state='ALARM', state_updated=NOW - timedelta(days=40)),
            _alarm_row(name='svc-prod-api-quiet-critical'),
        ),
        _config(),
    )

    dwell = alarms.time_in_alarm(meta, pl.DataFrame(schema=alarms_source.TRANSITIONS_SCHEMA), start=NOW - WEEK, end=NOW)

    rows = {row['name']: row['mins_in_alarm'] for row in dwell.to_dicts()}
    assert rows['svc-prod-api-stuck-critical'] == int(WEEK.total_seconds() // 60)
    assert rows['svc-prod-api-quiet-critical'] == 0


_FLAP_FIRES = 6
_FLAP_DWELL_MINUTES = 5


def test_alarm_period_table_marks_flapping_against_sustained() -> None:
    flapping_start = NOW - timedelta(days=1)
    meta = alarms.with_alarm_meta(
        _alarms_frame(
            _alarm_row(name='svc-prod-api-flap-critical'),
            _alarm_row(name='svc-prod-api-stuck-critical', state='ALARM', state_updated=NOW - timedelta(days=3)),
        ),
        _config(),
    )
    transitions = _transitions_frame(
        *[
            _transition('prod', 'svc-prod-api-flap-critical', flapping_start + timedelta(minutes=30 * i), 'ALARM')
            for i in range(_FLAP_FIRES)
        ],
        *[
            _transition(
                'prod',
                'svc-prod-api-flap-critical',
                flapping_start + timedelta(minutes=30 * i + _FLAP_DWELL_MINUTES),
                'OK',
                from_state='ALARM',
            )
            for i in range(_FLAP_FIRES)
        ],
    )

    table = alarms.alarm_period_table(meta, transitions, window=_window())

    rows = {row['name']: row for row in table.to_dicts()}
    flap = rows['svc-prod-api-flap-critical']
    assert flap['kind'] == 'flapping'
    assert flap['mins_in_alarm'] == _FLAP_FIRES * _FLAP_DWELL_MINUTES
    stuck = rows['svc-prod-api-stuck-critical']
    assert stuck['kind'] == 'sustained'
    assert stuck['mins_in_alarm'] == 3 * 24 * 60


def test_env_rollup_sums_fires_counts_changes_and_ticket_coverage() -> None:
    meta = alarms.with_alarm_meta(
        _alarms_frame(
            _alarm_row(env='prod', name='a-critical'),
            _alarm_row(env='prod', name='b-critical', state='ALARM'),
            _alarm_row(env='stage', name='c-critical'),
        ),
        _config(),
    )
    transitions = _transitions_frame(_transition('prod', 'a-critical', NOW - timedelta(days=1), 'ALARM'))
    table = alarms.alarm_period_table(meta, transitions, window=_window())
    linked = alarms.with_linear_matches(table, _issues_frame(), now=NOW)

    rollup = alarms.env_rollup(linked)

    rows = {row['env']: row for row in rollup.to_dicts()}
    assert rows['prod'] == {
        'env': 'prod',
        'tracked': 2,
        'in_alarm_now': 1,
        'alarms_fired': 1,
        'new': 1,
        'quieted': 0,
        'fired_no_ticket': 1,
        'fires': 1,
        'previous': 0,
        'delta': 1,
    }
    assert rows['stage']['tracked'] == 1


def test_category_rollup_skips_groups_that_never_fired() -> None:
    meta = alarms.with_alarm_meta(
        _alarms_frame(
            _alarm_row(name='svc-prod-api-5xx-critical'),
            _alarm_row(name='svc-prod-quiet-critical'),
        ),
        _config(),
    )
    transitions = _transitions_frame(_transition('prod', 'svc-prod-api-5xx-critical', NOW - timedelta(days=1), 'ALARM'))
    table = alarms.alarm_period_table(meta, transitions, window=_window())

    rollup = alarms.category_rollup(table)

    assert rollup.to_dicts() == [
        {'env': 'prod', 'category': 'api', 'alarms_fired': 1, 'fires': 1, 'previous': 0, 'delta': 1},
    ]


def test_with_linear_matches_splits_open_from_closed_title_matches() -> None:
    meta = alarms.with_alarm_meta(
        _alarms_frame(
            _alarm_row(name='svc-prod-api-5xx-critical'),
            _alarm_row(name='svc-prod-no-ticket-critical'),
        ),
        _config(),
    )
    table = alarms.alarm_period_table(meta, pl.DataFrame(schema=alarms_source.TRANSITIONS_SCHEMA), window=_window())
    issues = _issues_frame(
        _issue(1, 'svc-prod-api-5xx-critical: gateway timeouts'),
        _issue(2, 'svc-prod-api-5xx-critical: earlier fire', completed=True),
        _issue(3, 'unrelated ticket'),
    )

    linked = alarms.with_linear_matches(table, issues, now=NOW)

    rows = {row['name']: row for row in linked.to_dicts()}
    assert rows['svc-prod-api-5xx-critical']['linear_open'] == '[DEV-1](https://linear.test/issue/DEV-1) (Todo)'
    assert rows['svc-prod-api-5xx-critical']['linear_closed'] == 1
    assert not rows['svc-prod-no-ticket-critical']['linear_open']
    assert rows['svc-prod-no-ticket-critical']['linear_closed'] == 0


def test_build_alarm_sections_emits_every_heading() -> None:
    meta_alarms = _alarms_frame(
        _alarm_row(name='svc-prod-api-5xx-critical', state='ALARM', state_updated=NOW - timedelta(hours=3)),
        _alarm_row(name='svc-prod-api-quiet-critical'),
    )
    transitions = _transitions_frame(_transition('prod', 'svc-prod-api-5xx-critical', NOW - timedelta(days=1), 'ALARM'))
    issues = _issues_frame(_issue(1, 'unrelated'))

    sections = alarms.build_alarm_sections(
        meta_alarms,
        transitions,
        issues,
        window=_window(),
        config=_config(),
        fetched_at=NOW,
    )

    assert [title for title, _ in sections] == [
        'Alarms: fires by environment',
        'Alarms: fires by category',
        'Alarms: fires per day — prod',
        'Alarms: new this period',
        'Alarms: quieted since last period',
        'Alarms: leading this period',
        'Alarms: flapping',
        'Alarms: in ALARM now',
        'Alarms: fired with no open Linear ticket',
    ]
    by_title = dict(sections)
    assert _frame(by_title, 'Alarms: in ALARM now')['name'].to_list() == ['svc-prod-api-5xx-critical']
    assert _frame(by_title, 'Alarms: new this period')['name'].to_list() == ['svc-prod-api-5xx-critical']
    assert _frame(by_title, 'Alarms: fired with no open Linear ticket')['name'].to_list() == [
        'svc-prod-api-5xx-critical',
    ]


def test_new_and_quieted_sections_split_alarms_by_period_change() -> None:
    meta_alarms = _alarms_frame(
        _alarm_row(name='svc-prod-api-new-critical'),
        _alarm_row(name='svc-prod-api-quieted-critical'),
    )
    transitions = _transitions_frame(
        _transition('prod', 'svc-prod-api-new-critical', NOW - timedelta(days=1), 'ALARM'),
        _transition('prod', 'svc-prod-api-quieted-critical', NOW - WEEK - timedelta(days=1), 'ALARM'),
    )

    sections = dict(
        alarms.build_alarm_sections(
            meta_alarms,
            transitions,
            _issues_frame(),
            window=_window(),
            config=_config(),
            fetched_at=NOW,
        ),
    )

    assert _frame(sections, 'Alarms: new this period')['name'].to_list() == ['svc-prod-api-new-critical']
    assert _frame(sections, 'Alarms: quieted since last period')['name'].to_list() == [
        'svc-prod-api-quieted-critical',
    ]


def test_build_alarm_sections_warns_when_the_window_exceeds_history_retention() -> None:
    sections = alarms.build_alarm_sections(
        _alarms_frame(_alarm_row()),
        pl.DataFrame(schema=alarms_source.TRANSITIONS_SCHEMA),
        _issues_frame(),
        window=_window(days=45),
        config=_config(),
        fetched_at=NOW,
    )

    titles = [title for title, _ in sections]
    assert 'Alarms: history note' in titles
    note = _frame(dict(sections), 'Alarms: history note')['note'].item()
    assert f'{alarms.HISTORY_RETENTION_DAYS} days' in note


def test_build_alarm_sections_detail_adds_the_full_table() -> None:
    sections = alarms.build_alarm_sections(
        _alarms_frame(_alarm_row()),
        pl.DataFrame(schema=alarms_source.TRANSITIONS_SCHEMA),
        _issues_frame(),
        window=_window(),
        config=_config(),
        fetched_at=NOW,
        include_detail=True,
    )

    titles = [title for title, _ in sections]
    assert 'Alarms: all tracked' in titles
    assert _frame(dict(sections), 'Alarms: all tracked').height == 1


def test_fires_chart_buckets_per_day_and_emits_mermaid() -> None:
    transitions = _transitions_frame(
        _transition('prod', 'a-critical', NOW - timedelta(days=2), 'ALARM'),
        _transition('prod', 'a-critical', NOW - timedelta(days=1, hours=1), 'ALARM'),
        _transition('prod', 'a-critical', NOW - timedelta(days=1), 'ALARM'),
    )

    per_day = alarms.fires_per_day(transitions, window=_window())
    chart = alarms.fires_chart(per_day, env='prod', window=_window())

    assert per_day['fires'].to_list() == [1, 2]
    assert chart is not None
    assert chart.startswith('```mermaid\nxychart-beta')
    assert chart.endswith('bar [0, 0, 0, 0, 0, 1, 2, 0]\n```')
    assert alarms.fires_chart(per_day, env='stage', window=_window()) is None


def test_console_region_links_alarm_names() -> None:
    sections = dict(
        alarms.build_alarm_sections(
            _alarms_frame(_alarm_row(name='svc-prod-api-5xx-critical', state='ALARM', state_updated=NOW)),
            _transitions_frame(
                _transition('prod', 'svc-prod-api-5xx-critical', NOW - timedelta(hours=1), 'ALARM'),
            ),
            _issues_frame(),
            window=_window(),
            config=_config(console_region='us-east-1'),
            fetched_at=NOW,
        ),
    )

    name = _frame(sections, 'Alarms: in ALARM now')['name'].item()
    assert name == (
        '[svc-prod-api-5xx-critical](https://us-east-1.console.aws.amazon.com/cloudwatch/home'
        '?region=us-east-1#alarmsV2:alarm/svc-prod-api-5xx-critical)'
    )
