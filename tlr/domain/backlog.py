"""Backlog health metrics: age buckets, close time, stuck tickets, and resolved splits.

Every function here is pure: frames and config values in, a frame out. No network, no store
connection, no config file read.

The store keeps only `created_at` and `resolution_time` for each Pylon issue, not a daily
snapshot of backlog size. Every "as of a past instant" count in this module is reconstructed
from those two timestamps: a ticket was open at instant `t` if `created_at <= t` and
(`resolution_time` is null or `resolution_time > t`).

Every open/closed decision reads `state_category`, never the `state` slug: several distinct
slugs (`closed`, `nar`, `resolved`, `won_t_fix`, and whatever else a workspace adds) all map to
the `closed` category.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Final

import polars as pl

from tlr.config import SlaConfig, ThresholdsConfig

STATE_CATEGORY_NEW: Final = 'new'
STATE_CATEGORY_CLOSED: Final = 'closed'

_OVERALL_PRIORITY: Final = 'overall'

_AGE_BUCKETS_SCHEMA: dict[str, Any] = {
    'threshold_days': pl.Int64,
    'open_count': pl.Int64,
    'day_over_day_delta': pl.Int64,
}

_CLOSE_TIME_SCHEMA: dict[str, Any] = {
    'priority': pl.Utf8,
    'closed_count': pl.Int64,
    'p50_days': pl.Float64,
    'p95_days': pl.Float64,
    'target_days': pl.Int64,
}

_STUCK_SCHEMA: dict[str, Any] = {
    'stuck_count': pl.Int64,
    'open_days_over_threshold': pl.Int64,
}

_WEEK_OVER_WEEK_SCHEMA: dict[str, Any] = {
    'last_7_days': pl.Int64,
    'prior_7_days': pl.Int64,
    'delta': pl.Int64,
}

_RESOLVED_SPLIT_SCHEMA: dict[str, Any] = {
    'resolved_by': pl.Utf8,
    'closed_count': pl.Int64,
}


def _open_at(issues: pl.DataFrame, at: datetime) -> pl.DataFrame:
    return issues.filter(
        (pl.col('created_at') <= at) & (pl.col('resolution_time').is_null() | (pl.col('resolution_time') > at)),
    )


def age_buckets(issues: pl.DataFrame, thresholds: ThresholdsConfig, *, now: datetime) -> pl.DataFrame:
    """Count currently-open tickets older than each configured threshold, with a day-over-day delta.

    Buckets are reported in the order given by `thresholds.backlog_age_days`, unsorted. The delta
    is the same count computed 24 hours earlier (see the module docstring for the reconstruction
    rule) subtracted from the count as of `now`.
    """
    open_now = _open_at(issues, now)
    open_yesterday = _open_at(issues, now - timedelta(days=1))
    rows = []
    for threshold in thresholds.backlog_age_days:
        cutoff = now - timedelta(days=threshold)
        cutoff_yesterday = (now - timedelta(days=1)) - timedelta(days=threshold)
        count_now = open_now.filter(pl.col('created_at') <= cutoff).height
        count_yesterday = open_yesterday.filter(pl.col('created_at') <= cutoff_yesterday).height
        rows.append(
            {
                'threshold_days': threshold,
                'open_count': count_now,
                'day_over_day_delta': count_now - count_yesterday,
            }
        )
    if not rows:
        return pl.DataFrame(schema=_AGE_BUCKETS_SCHEMA)
    return pl.DataFrame(rows, schema=_AGE_BUCKETS_SCHEMA)


def close_time(
    issues: pl.DataFrame,
    sla: SlaConfig,
    *,
    window_start: datetime,
    window_end: datetime,
) -> pl.DataFrame:
    """P50 and P95 close time in days, per priority plus an overall row, against the configured SLA target.

    Scoped to tickets whose `resolution_time` falls in `[window_start, window_end)`. Percentiles use
    polars' `quantile` with `interpolation='linear'`. A priority absent from
    `sla.target_days_by_priority` (which defaults empty) reports a null target rather than a
    fabricated one.
    """
    closed = issues.filter(
        pl.col('resolution_time').is_not_null()
        & (pl.col('resolution_time') >= window_start)
        & (pl.col('resolution_time') < window_end),
    ).with_columns(
        ((pl.col('resolution_time') - pl.col('created_at')).dt.total_seconds() / 86400).alias('_close_days'),
    )
    if closed.is_empty():
        return pl.DataFrame(schema=_CLOSE_TIME_SCHEMA)

    def _summarize(scoped: pl.DataFrame, priority: str) -> dict[str, Any]:
        target = sla.target_days_by_priority.get(priority) if priority != _OVERALL_PRIORITY else None
        return {
            'priority': priority,
            'closed_count': scoped.height,
            'p50_days': scoped.select(pl.col('_close_days').quantile(0.5, interpolation='linear')).item(),
            'p95_days': scoped.select(pl.col('_close_days').quantile(0.95, interpolation='linear')).item(),
            'target_days': target,
        }

    priorities = sorted(closed['priority'].drop_nulls().unique().to_list())
    rows = [_summarize(closed, _OVERALL_PRIORITY)]
    rows.extend(_summarize(closed.filter(pl.col('priority') == priority), priority) for priority in priorities)
    return pl.DataFrame(rows, schema=_CLOSE_TIME_SCHEMA)


def stuck_tickets(issues: pl.DataFrame, thresholds: ThresholdsConfig, *, now: datetime) -> pl.DataFrame:
    """Count open tickets neither new nor closed whose age exceeds `thresholds.in_progress_days`.

    A null `state_category` means the status slug was not in the workspace's status list, and
    such a row counts as stuck rather than being skipped.

    This is age since `created_at`, not time in the current status: Pylon exposes a native
    current-state duration (`issue_in_current_state_duration`, `time_in_status_seconds`) that tlr
    does not store, so a ticket that spent most of its life in `new` before moving to an active
    status still counts here once its total age crosses the threshold.
    """
    cutoff = now - timedelta(days=thresholds.in_progress_days)
    stuck = _open_at(issues, now).filter(
        ~pl.col('state_category').is_in([STATE_CATEGORY_NEW, STATE_CATEGORY_CLOSED]).fill_null(value=False)
        & (pl.col('created_at') <= cutoff),
    )
    return pl.DataFrame(
        [{'stuck_count': stuck.height, 'open_days_over_threshold': thresholds.in_progress_days}],
        schema=_STUCK_SCHEMA,
    )


def week_over_week_created(issues: pl.DataFrame, *, now: datetime) -> pl.DataFrame:
    """Count tickets created in the last 7 days versus the 7 days before that."""
    last_start = now - timedelta(days=7)
    prior_start = now - timedelta(days=14)
    last_count = issues.filter((pl.col('created_at') > last_start) & (pl.col('created_at') <= now)).height
    prior_count = issues.filter((pl.col('created_at') > prior_start) & (pl.col('created_at') <= last_start)).height
    return pl.DataFrame(
        [{'last_7_days': last_count, 'prior_7_days': prior_count, 'delta': last_count - prior_count}],
        schema=_WEEK_OVER_WEEK_SCHEMA,
    )


def resolved_split(
    issues: pl.DataFrame,
    agent_assignee_ids: list[str],
    *,
    window_start: datetime,
    window_end: datetime,
) -> pl.DataFrame:
    """Split tickets closed in `[window_start, window_end)` by whether `assignee_id` is a configured agent.

    Pylon has richer native signals for this (`issue_ai_agent_has_resolved`, `issue_ai_agent_id`)
    that tlr does not store yet, so this split is only as good as `agent_assignee_ids`: with an
    empty list, every closed ticket counts as human.
    """
    closed = issues.filter(
        pl.col('resolution_time').is_not_null()
        & (pl.col('resolution_time') >= window_start)
        & (pl.col('resolution_time') < window_end),
    )
    agent_count = closed.filter(pl.col('assignee_id').is_in(agent_assignee_ids)).height
    return pl.DataFrame(
        [
            {'resolved_by': 'agent', 'closed_count': agent_count},
            {'resolved_by': 'human', 'closed_count': closed.height - agent_count},
        ],
        schema=_RESOLVED_SPLIT_SCHEMA,
    )


def backlog_health_sections(
    issues: pl.DataFrame,
    thresholds: ThresholdsConfig,
    sla: SlaConfig,
    agent_assignee_ids: list[str],
    *,
    now: datetime,
    close_time_window_days: int = 30,
) -> list[tuple[str, pl.DataFrame]]:
    """Assemble the meeting-ready view, ready for `tlr.render.markdown.sections_to_markdown`."""
    window_start = now - timedelta(days=close_time_window_days)
    return [
        ('Backlog age', age_buckets(issues, thresholds, now=now)),
        ('Close time', close_time(issues, sla, window_start=window_start, window_end=now)),
        ('Stuck tickets', stuck_tickets(issues, thresholds, now=now)),
        ('Week over week', week_over_week_created(issues, now=now)),
        ('Resolved split', resolved_split(issues, agent_assignee_ids, window_start=window_start, window_end=now)),
    ]
