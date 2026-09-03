"""Per-person capacity: allocated and delivered points, deflated capacity, and the standup view.

Every function here is pure: frames and config values in, a frame out. No network, no store
connection, no config file read.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from datetime import datetime
from typing import Final

import polars as pl

from tlr.config import Person

DELIVERED_STATE_TYPES: Final[frozenset[str]] = frozenset({'completed'})
ALLOCATED_STATE_TYPES: Final[frozenset[str]] = frozenset({'backlog', 'unstarted', 'started', 'completed', 'triage'})
"""Every Linear state_type except `canceled`, which is work nobody is carrying."""

_GROUP_COL_DTYPES = {
    'assignee_name': pl.Utf8,
    'team_key': pl.Utf8,
    'cycle_number': pl.Int64,
}

_POINTS_SUMMARY_COLS: Final[tuple[str, str]] = ('points', 'unestimated_count')

_STANDUP_SCHEMA = {
    'Person': pl.Utf8,
    'Allocated points': pl.Float64,
    'Allocated unestimated': pl.Int64,
    'Delivered points': pl.Float64,
    'Delivered unestimated': pl.Int64,
    'Deflated capacity': pl.Float64,
    'Capacity remaining': pl.Float64,
}

_DEFLATION_SCHEMA = {
    'person': pl.Utf8,
    'points_per_cycle': pl.Float64,
    'out_day_points': pl.Float64,
    'on_call_points': pl.Float64,
    'meeting_points': pl.Float64,
    'deflated_capacity': pl.Float64,
}


def _points_summary(
    issues: pl.DataFrame,
    group_cols: tuple[str, ...],
    state_types: Collection[str] | None,
) -> pl.DataFrame:
    schema = {col: _GROUP_COL_DTYPES[col] for col in group_cols} | {
        'points': pl.Float64,
        'unestimated_count': pl.Int64,
    }
    scoped = issues.filter(pl.col('state_type').is_in(list(state_types))) if state_types is not None else issues
    if scoped.is_empty():
        return pl.DataFrame(schema=schema)
    return (
        scoped.group_by(list(group_cols), maintain_order=True)
        .agg(
            pl.col('estimate').sum().alias('points'),
            pl.col('estimate').is_null().sum().cast(pl.Int64).alias('unestimated_count'),
        )
        .select([*group_cols, *_POINTS_SUMMARY_COLS])
    )


def points_by_person_cycle(issues: pl.DataFrame, *, state_types: Collection[str] | None = None) -> pl.DataFrame:
    """Sum `estimate` per (assignee_name, team_key, cycle_number), with a null-estimate count beside each total."""
    return _points_summary(issues, ('assignee_name', 'team_key', 'cycle_number'), state_types)


def points_by_person(issues: pl.DataFrame, *, state_types: Collection[str] | None = None) -> pl.DataFrame:
    """Sum `estimate` per assignee_name, with a null-estimate count beside the total."""
    return _points_summary(issues, ('assignee_name',), state_types)


def current_cycle(cycles: pl.DataFrame, at: datetime) -> pl.DataFrame:
    """Return the cycle rows whose window contains `at`.

    A cycle is identified by (team_key, number), not number alone, so more than one row can come
    back when several teams' cycles overlap `at`.
    """
    return cycles.filter((pl.col('starts_at') <= at) & (pl.col('ends_at') > at))


def deflate_capacity(
    roster: Sequence[Person],
    deflation: pl.DataFrame,
    *,
    working_days_per_cycle: float,
    working_hours_per_day: float,
) -> pl.DataFrame:
    """Reduce each roster member's `points_per_cycle` by their out-days, on-call days, and meeting hours.

    `deflation` carries raw units per person (`out_days`, `on_call_days`, `meeting_hours`); a person
    missing from it, or an empty frame, deflates by zero. Each deflation stays its own column so the
    number behind it can be argued with.
    """
    if not roster:
        return pl.DataFrame(schema=_DEFLATION_SCHEMA)

    roster_frame = pl.DataFrame(
        {
            'person': [person.name for person in roster],
            'points_per_cycle': [person.points_per_cycle for person in roster],
        },
    )
    if deflation.is_empty():
        joined = roster_frame.with_columns(
            pl.lit(0.0).alias('out_days'),
            pl.lit(0.0).alias('on_call_days'),
            pl.lit(0.0).alias('meeting_hours'),
        )
    else:
        joined = roster_frame.join(deflation, on='person', how='left').with_columns(
            pl.col('out_days').fill_null(0.0),
            pl.col('on_call_days').fill_null(0.0),
            pl.col('meeting_hours').fill_null(0.0),
        )

    points_per_day = pl.col('points_per_cycle') / working_days_per_cycle
    deflated = joined.with_columns(
        (pl.col('out_days') * points_per_day).alias('out_day_points'),
        (pl.col('on_call_days') * points_per_day).alias('on_call_points'),
        (pl.col('meeting_hours') / working_hours_per_day * points_per_day).alias('meeting_points'),
    )
    return deflated.with_columns(
        (pl.col('points_per_cycle') - pl.col('out_day_points') - pl.col('on_call_points') - pl.col('meeting_points'))
        .clip(lower_bound=0.0)
        .alias('deflated_capacity'),
    ).select(list(_DEFLATION_SCHEMA))


def standup_capacity(
    issues: pl.DataFrame,
    roster: Sequence[Person],
    deflation: pl.DataFrame,
    *,
    working_days_per_cycle: float,
    working_hours_per_day: float,
) -> pl.DataFrame:
    """Build the standup-ready frame: one row per roster person, ready for `frame_to_markdown`.

    `issues` should already be scoped to the cycle being reported. Every roster member appears even
    with no issues; an issue assigned to someone off the roster is not counted for anyone.
    """
    if not roster:
        return pl.DataFrame(schema=_STANDUP_SCHEMA)

    capacity = deflate_capacity(
        roster,
        deflation,
        working_days_per_cycle=working_days_per_cycle,
        working_hours_per_day=working_hours_per_day,
    )
    allocated = points_by_person(issues, state_types=ALLOCATED_STATE_TYPES).rename(
        {'assignee_name': 'person', 'points': 'allocated_points', 'unestimated_count': 'allocated_unestimated'},
    )
    delivered = points_by_person(issues, state_types=DELIVERED_STATE_TYPES).rename(
        {'assignee_name': 'person', 'points': 'delivered_points', 'unestimated_count': 'delivered_unestimated'},
    )

    merged = (
        capacity.join(allocated, on='person', how='left')
        .join(delivered, on='person', how='left')
        .with_columns(
            pl.col('allocated_points').fill_null(0.0),
            pl.col('allocated_unestimated').fill_null(0),
            pl.col('delivered_points').fill_null(0.0),
            pl.col('delivered_unestimated').fill_null(0),
        )
        .with_columns((pl.col('deflated_capacity') - pl.col('allocated_points')).alias('capacity_remaining'))
    )
    return merged.select(
        pl.col('person').alias('Person'),
        pl.col('allocated_points').alias('Allocated points'),
        pl.col('allocated_unestimated').alias('Allocated unestimated'),
        pl.col('delivered_points').alias('Delivered points'),
        pl.col('delivered_unestimated').alias('Delivered unestimated'),
        pl.col('deflated_capacity').alias('Deflated capacity'),
        pl.col('capacity_remaining').alias('Capacity remaining'),
    )
