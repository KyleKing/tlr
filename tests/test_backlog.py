"""Tests for the backlog domain: pure frame-in, frame-out functions."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import polars as pl
import pytest

from tlr.config import SlaConfig, ThresholdsConfig
from tlr.domain import backlog

NOW = datetime(2026, 9, 2, 12, 0, tzinfo=UTC).replace(tzinfo=None)
_EXPECTED_CLOSED_COUNT = 2
_EXPECTED_TARGET_DAYS = 2
_EXPECTED_STUCK_THRESHOLD = 5

_ISSUE_DEFAULTS = {
    'id': 'issue-1',
    'number': 1,
    'created_at': NOW - timedelta(days=1),
    'state': 'open',
    'state_category': 'new',
    'priority': 'medium',
    'account_id': 'acct-1',
    'assignee_id': None,
    'resolution_time': None,
    'first_response_time': None,
}


def _issue(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = dict(_ISSUE_DEFAULTS)
    row.update(overrides)
    return row


def _issues(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(
        list(rows),
        schema={
            'id': pl.Utf8,
            'number': pl.Int64,
            'created_at': pl.Datetime('us'),
            'state': pl.Utf8,
            'state_category': pl.Utf8,
            'priority': pl.Utf8,
            'account_id': pl.Utf8,
            'assignee_id': pl.Utf8,
            'resolution_time': pl.Datetime('us'),
            'first_response_time': pl.Datetime('us'),
        },
    )


def test_open_at_instant_excludes_ticket_closed_before_it() -> None:
    thresholds = ThresholdsConfig(backlog_age_days=[0])
    closed_before = _issue(
        id='closed-before',
        created_at=NOW - timedelta(days=5),
        resolution_time=NOW - timedelta(hours=1),
    )
    closed_after = _issue(
        id='closed-after',
        created_at=NOW - timedelta(days=5),
        resolution_time=NOW + timedelta(hours=1),
    )
    issues = _issues(closed_before, closed_after)

    result = backlog.age_buckets(issues, thresholds, now=NOW)

    assert result['open_count'].item() == 1


def test_age_bucket_delta_nonzero_when_ticket_crosses_boundary_in_last_24_hours() -> None:
    thresholds = ThresholdsConfig(backlog_age_days=[1])
    aged_in = _issue(id='aged-in', created_at=NOW - timedelta(days=1, hours=12))
    issues = _issues(aged_in)

    result = backlog.age_buckets(issues, thresholds, now=NOW)

    row = result.filter(pl.col('threshold_days') == 1).to_dicts()[0]
    assert row['open_count'] == 1
    assert row['day_over_day_delta'] == 1


def test_age_buckets_stay_in_configured_order() -> None:
    thresholds = ThresholdsConfig(backlog_age_days=[90, 30, 60])
    result = backlog.age_buckets(_issues(), thresholds, now=NOW)
    assert result['threshold_days'].to_list() == [90, 30, 60]


def test_nar_slug_with_closed_category_is_excluded_from_stuck_tickets() -> None:
    thresholds = ThresholdsConfig(in_progress_days=1)
    nar_ticket = _issue(
        id='nar-ticket',
        state='nar',
        state_category='closed',
        created_at=NOW - timedelta(days=10),
        resolution_time=None,
    )
    issues = _issues(nar_ticket)

    result = backlog.stuck_tickets(issues, thresholds, now=NOW)

    assert result['stuck_count'].item() == 0


def test_close_time_percentiles_and_null_target_when_unconfigured() -> None:
    issues = _issues(
        _issue(id='a', priority='high', created_at=NOW - timedelta(days=10), resolution_time=NOW - timedelta(days=8)),
        _issue(id='b', priority='high', created_at=NOW - timedelta(days=20), resolution_time=NOW - timedelta(days=10)),
    )
    sla = SlaConfig(target_days_by_priority={})

    result = backlog.close_time(issues, sla, window_start=NOW - timedelta(days=30), window_end=NOW)

    overall = result.filter(pl.col('priority') == 'overall').to_dicts()[0]
    assert overall['closed_count'] == _EXPECTED_CLOSED_COUNT
    assert overall['p50_days'] == pytest.approx(6.0)
    assert overall['p95_days'] == pytest.approx(9.6)
    assert overall['target_days'] is None


def test_close_time_reports_configured_target_per_priority() -> None:
    issues = _issues(
        _issue(id='a', priority='urgent', created_at=NOW - timedelta(days=5), resolution_time=NOW - timedelta(days=4)),
    )
    sla = SlaConfig(target_days_by_priority={'urgent': 2})

    result = backlog.close_time(issues, sla, window_start=NOW - timedelta(days=30), window_end=NOW)

    urgent = result.filter(pl.col('priority') == 'urgent').to_dicts()[0]
    assert urgent['target_days'] == _EXPECTED_TARGET_DAYS


def test_stuck_tickets_counts_only_open_days_since_creation() -> None:
    thresholds = ThresholdsConfig(in_progress_days=5)
    stuck = _issue(id='stuck', state_category='waiting_on_you', created_at=NOW - timedelta(days=10))
    too_new = _issue(id='too-new', state_category='waiting_on_you', created_at=NOW - timedelta(days=1))
    excluded_new_category = _issue(id='new-cat', state_category='new', created_at=NOW - timedelta(days=10))
    issues = _issues(stuck, too_new, excluded_new_category)

    result = backlog.stuck_tickets(issues, thresholds, now=NOW)

    row = result.to_dicts()[0]
    assert row['stuck_count'] == 1
    assert row['open_days_over_threshold'] == _EXPECTED_STUCK_THRESHOLD


def test_week_over_week_splits_by_ticket_age() -> None:
    recent = _issue(id='recent', created_at=NOW - timedelta(days=3))
    older = _issue(id='older', created_at=NOW - timedelta(days=10))
    issues = _issues(recent, older)

    result = backlog.week_over_week_created(issues, now=NOW)

    row = result.to_dicts()[0]
    assert row['last_7_days'] == 1
    assert row['prior_7_days'] == 1
    assert row['delta'] == 0


@pytest.mark.parametrize(
    ('agent_ids', 'expected_agent', 'expected_human'),
    [
        (['agent-1'], 1, 1),
        ([], 0, 2),
    ],
)
def test_resolved_split_by_configured_agent_ids(agent_ids: list[str], expected_agent: int, expected_human: int) -> None:
    agent_closed = _issue(
        id='agent-closed',
        assignee_id='agent-1',
        created_at=NOW - timedelta(days=5),
        resolution_time=NOW - timedelta(days=1),
    )
    human_closed = _issue(
        id='human-closed',
        assignee_id='human-1',
        created_at=NOW - timedelta(days=5),
        resolution_time=NOW - timedelta(days=1),
    )
    issues = _issues(agent_closed, human_closed)

    result = backlog.resolved_split(issues, agent_ids, window_start=NOW - timedelta(days=30), window_end=NOW)

    counts = dict(zip(result['resolved_by'].to_list(), result['closed_count'].to_list(), strict=True))
    assert counts['agent'] == expected_agent
    assert counts['human'] == expected_human


@pytest.mark.parametrize(
    ('frame', 'int_cols'),
    [
        (backlog.age_buckets(_issues(_issue()), ThresholdsConfig(), now=NOW), ['open_count', 'day_over_day_delta']),
        (backlog.stuck_tickets(_issues(_issue()), ThresholdsConfig(), now=NOW), ['stuck_count']),
        (backlog.week_over_week_created(_issues(_issue()), now=NOW), ['last_7_days', 'prior_7_days', 'delta']),
    ],
)
def test_counts_are_integer_dtype(frame: pl.DataFrame, int_cols: list[str]) -> None:
    for col in int_cols:
        assert frame[col].dtype == pl.Int64


def test_an_unmapped_status_category_still_counts_as_stuck() -> None:
    issues = _issues(_issue(id='p1', created_at=NOW - timedelta(days=30), state_category=None))

    result = backlog.stuck_tickets(issues, ThresholdsConfig(), now=NOW)

    assert result['stuck_count'].to_list() == [1], 'a status tlr cannot categorize is still an open ticket'
