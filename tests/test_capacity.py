"""Tests for the capacity domain: pure frame-in, frame-out functions."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import polars as pl
import pytest

from tlr.config import CapacityConfig, Person
from tlr.domain import capacity

BASE_TIME = datetime(2026, 9, 1, tzinfo=UTC).replace(tzinfo=None)
_DEFAULT_CAPACITY = 10.0
_ESTIMATE = 3.0
_OTHER_ESTIMATE = 5.0
_CYCLE_DAYS = 14

_ISSUE_DEFAULTS = {
    'id': 'issue-1',
    'identifier': 'DEV-1',
    'assignee_name': 'ada',
    'team_key': 'DEV',
    'cycle_number': 5,
    'estimate': _ESTIMATE,
    'state_type': 'started',
}


def _issue(**overrides: object) -> dict[str, object]:
    row = dict(_ISSUE_DEFAULTS)
    row.update(overrides)
    return row


def _issues(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(list(rows))


def _empty_issues() -> pl.DataFrame:
    return pl.DataFrame(
        schema={
            'id': pl.Utf8,
            'identifier': pl.Utf8,
            'assignee_name': pl.Utf8,
            'team_key': pl.Utf8,
            'cycle_number': pl.Int64,
            'estimate': pl.Float64,
            'state_type': pl.Utf8,
        },
    )


def _cycles(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(list(rows))


def _empty_cycles() -> pl.DataFrame:
    return pl.DataFrame(
        schema={
            'team_key': pl.Utf8,
            'number': pl.Int64,
            'starts_at': pl.Datetime('us'),
            'ends_at': pl.Datetime('us'),
        },
    )


def _person(name: str = 'ada', points_per_cycle: float = _DEFAULT_CAPACITY) -> Person:
    return Person(name=name, email=f'{name}@example.test', points_per_cycle=points_per_cycle)


@pytest.mark.parametrize('summary_fn', [capacity.points_by_person_cycle, capacity.points_by_person])
def test_empty_issues_returns_empty_frame_with_columns(summary_fn):
    result = summary_fn(_empty_issues())

    assert result.is_empty()
    assert 'points' in result.columns
    assert 'unestimated_count' in result.columns


def test_null_estimate_counted_as_unestimated_and_excluded_from_sum():
    issues = _issues(_issue(estimate=_ESTIMATE), _issue(estimate=None))

    result = capacity.points_by_person(issues)

    row = result.row(0, named=True)
    assert row['points'] == pytest.approx(_ESTIMATE)
    assert row['unestimated_count'] == 1


def test_delivered_filters_by_state_type_not_name():
    issues = _issues(
        _issue(identifier='DEV-1', estimate=_ESTIMATE, state_type='completed'),
        _issue(identifier='DEV-2', estimate=_OTHER_ESTIMATE, state_type='started'),
    )

    delivered = capacity.points_by_person(issues, state_types=capacity.DELIVERED_STATE_TYPES)

    row = delivered.row(0, named=True)
    assert row['points'] == pytest.approx(_ESTIMATE)


def test_same_cycle_number_on_two_teams_stays_distinct():
    issues = _issues(
        _issue(identifier='DEV-1', team_key='DEV', cycle_number=5, estimate=_ESTIMATE),
        _issue(identifier='OPS-1', team_key='OPS', cycle_number=5, estimate=_OTHER_ESTIMATE),
    )

    result = capacity.points_by_person_cycle(issues).sort('team_key')

    assert result['points'].to_list() == pytest.approx([_ESTIMATE, _OTHER_ESTIMATE])
    assert result['team_key'].to_list() == ['DEV', 'OPS']


def test_empty_cycles_returns_empty_frame():
    result = capacity.current_cycle(_empty_cycles(), BASE_TIME)

    assert result.is_empty()


@pytest.mark.parametrize(
    ('at', 'expect_match'),
    [
        (BASE_TIME, True),
        (BASE_TIME + timedelta(days=_CYCLE_DAYS - 1), True),
        (BASE_TIME + timedelta(days=_CYCLE_DAYS), False),
        (BASE_TIME - timedelta(seconds=1), False),
    ],
    ids=['at-start', 'inside-window', 'at-end-excluded', 'before-start-excluded'],
)
def test_current_cycle_resolves_window_boundaries(at, expect_match):
    cycles = _cycles(
        {'team_key': 'DEV', 'number': 5, 'starts_at': BASE_TIME, 'ends_at': BASE_TIME + timedelta(days=_CYCLE_DAYS)},
    )

    result = capacity.current_cycle(cycles, at)

    assert (not result.is_empty()) == expect_match


def test_current_cycle_keeps_repeated_numbers_across_teams_distinct():
    cycles = _cycles(
        {'team_key': 'DEV', 'number': 5, 'starts_at': BASE_TIME, 'ends_at': BASE_TIME + timedelta(days=_CYCLE_DAYS)},
        {'team_key': 'OPS', 'number': 5, 'starts_at': BASE_TIME, 'ends_at': BASE_TIME + timedelta(days=_CYCLE_DAYS)},
    )

    result = capacity.current_cycle(cycles, BASE_TIME).sort('team_key')

    assert result['team_key'].to_list() == ['DEV', 'OPS']
    assert result['number'].to_list() == [5, 5]


_CYCLE_SHAPE = {
    'working_days_per_cycle': CapacityConfig().working_days_per_cycle,
    'working_hours_per_day': CapacityConfig().working_hours_per_day,
}


def test_deflate_capacity_empty_roster_returns_empty_frame():
    result = capacity.deflate_capacity([], pl.DataFrame(schema={'person': pl.Utf8}), **_CYCLE_SHAPE)

    assert result.is_empty()
    assert 'deflated_capacity' in result.columns


def test_deflate_capacity_with_empty_deflation_frame_leaves_capacity_untouched():
    result = capacity.deflate_capacity([_person()], pl.DataFrame(), **_CYCLE_SHAPE)

    row = result.row(0, named=True)
    assert row['deflated_capacity'] == pytest.approx(_DEFAULT_CAPACITY)


def test_deflate_capacity_reduces_by_out_days_on_call_and_meetings():
    out_days = 2.0
    deflation = pl.DataFrame(
        {'person': ['ada'], 'out_days': [out_days], 'on_call_days': [0.0], 'meeting_hours': [0.0]},
    )

    result = capacity.deflate_capacity([_person()], deflation, **_CYCLE_SHAPE)

    row = result.row(0, named=True)
    assert row['out_day_points'] == pytest.approx(out_days)
    assert row['deflated_capacity'] == pytest.approx(_DEFAULT_CAPACITY - out_days)


def test_deflate_capacity_person_missing_from_deflation_frame_deflates_by_zero():
    deflation = pl.DataFrame(
        {'person': ['someone-else'], 'out_days': [5.0], 'on_call_days': [0.0], 'meeting_hours': [0.0]},
    )

    result = capacity.deflate_capacity([_person(name='ada')], deflation, **_CYCLE_SHAPE)

    row = result.row(0, named=True)
    assert row['deflated_capacity'] == pytest.approx(_DEFAULT_CAPACITY)


def test_standup_capacity_empty_roster_returns_empty_frame():
    result = capacity.standup_capacity(_empty_issues(), [], pl.DataFrame(), **_CYCLE_SHAPE)

    assert result.is_empty()
    assert result.columns == [
        'Person',
        'Allocated points',
        'Allocated unestimated',
        'Delivered points',
        'Delivered unestimated',
        'Deflated capacity',
        'Capacity remaining',
    ]


def test_standup_capacity_person_with_no_issues_appears_with_zeros():
    result = capacity.standup_capacity(_empty_issues(), [_person(name='ada')], pl.DataFrame(), **_CYCLE_SHAPE)

    row = result.row(0, named=True)
    assert row['Person'] == 'ada'
    assert row['Allocated points'] == pytest.approx(0.0)
    assert row['Allocated unestimated'] == 0
    assert row['Delivered points'] == pytest.approx(0.0)
    assert row['Deflated capacity'] == pytest.approx(_DEFAULT_CAPACITY)
    assert row['Capacity remaining'] == pytest.approx(_DEFAULT_CAPACITY)


def test_standup_capacity_drops_issues_assigned_off_roster():
    issues = _issues(_issue(assignee_name='not-on-roster', estimate=_ESTIMATE))

    result = capacity.standup_capacity(issues, [_person(name='ada')], pl.DataFrame(), **_CYCLE_SHAPE)

    row = result.row(0, named=True)
    assert row['Person'] == 'ada'
    assert row['Allocated points'] == pytest.approx(0.0)


def test_standup_capacity_counts_unestimated_separately_for_allocated_and_delivered():
    issues = _issues(
        _issue(identifier='DEV-1', assignee_name='ada', estimate=_ESTIMATE, state_type='completed'),
        _issue(identifier='DEV-2', assignee_name='ada', estimate=None, state_type='started'),
    )

    result = capacity.standup_capacity(issues, [_person(name='ada')], pl.DataFrame(), **_CYCLE_SHAPE)

    row = result.row(0, named=True)
    assert row['Allocated points'] == pytest.approx(_ESTIMATE)
    assert row['Allocated unestimated'] == 1
    assert row['Delivered points'] == pytest.approx(_ESTIMATE)
    assert row['Delivered unestimated'] == 0
    assert row['Capacity remaining'] == pytest.approx(_DEFAULT_CAPACITY - _ESTIMATE)


def test_canceled_work_is_not_allocated_to_anyone():
    issues = _issues(
        _issue(identifier='DEV-1', assignee_name='ada', estimate=_ESTIMATE, state_type='started'),
        _issue(identifier='DEV-2', assignee_name='ada', estimate=_OTHER_ESTIMATE, state_type='canceled'),
    )

    result = capacity.standup_capacity(issues, [_person(name='ada')], pl.DataFrame(), **_CYCLE_SHAPE)

    row = result.row(0, named=True)
    assert row['Allocated points'] == pytest.approx(_ESTIMATE), 'a canceled issue is work nobody is carrying'
