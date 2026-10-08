"""Weekly/monthly snapshot: Linear and Pylon backlog picture, Sentry when configured, notable movement.

Every function here is pure: frames, config values, and a `now`/window in, a frame out. No
network, no store connection, no config file read, no secret access.

What the period-over-period delta can and cannot reconstruct:

- Pylon's open-at-instant-`t` reconstruction (`tlr.domain.backlog._open_at`) assumes
  `resolution_time` is set once and never cleared, so a ticket reopened after resolution reads as
  still open at every instant after its real resolution rather than as reopened and closed twice.
- The Linear equivalent here reads `completed_at` and `canceled_at`, which Linear clears back to
  null when an issue leaves a completed or canceled state. That erases the timestamp a past-instant
  query needs, so an issue reopened since the previous period's start is undercounted as having
  been open the whole time.
- Priority carries no timestamp in either source as tlr stores it, so "crossed a priority upward"
  needs a persisted snapshot from a prior run to diff against. tlr keeps none, so it is not
  computed; see `NOT_COMPUTED_NOTE`.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any, Final

import polars as pl

from tlr.config import SlaConfig
from tlr.domain.backlog import _open_at as _pylon_open_at
from tlr.domain.backlog import close_time
from tlr.store import PYLON_LABEL_KIND_TAG

LINEAR_PRIORITY_LABELS: Final[dict[int, str]] = {1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low', 0: 'None'}
LINEAR_PRIORITY_ORDER: Final[list[str]] = ['Urgent', 'High', 'Medium', 'Low', 'None']
UNASSIGNED = 'Unassigned'

_CREATED_CLOSED_SCHEMA: dict[str, Any] = {'created': pl.Int64, 'closed': pl.Int64}
_CREATED_RESOLVED_SCHEMA: dict[str, Any] = {'created': pl.Int64, 'resolved': pl.Int64}
_UNTRACKED_SCHEMA: dict[str, Any] = {'no_priority': pl.Int64, 'no_assignee': pl.Int64}
_LABEL_SCHEMA: dict[str, Any] = {'label': pl.Utf8, 'count': pl.Int64}
_OLDEST_LINEAR_SCHEMA: dict[str, Any] = {
    'priority': pl.Utf8,
    'identifier': pl.Utf8,
    'title': pl.Utf8,
    'age_days': pl.Int64,
}
_OLDEST_PYLON_SCHEMA: dict[str, Any] = {'number': pl.Int64, 'title': pl.Utf8, 'priority': pl.Utf8, 'age_days': pl.Int64}
_OVER_SLA_SCHEMA: dict[str, Any] = {
    'number': pl.Int64,
    'title': pl.Utf8,
    'priority': pl.Utf8,
    'age_days': pl.Int64,
    'sla_target_days': pl.Int64,
}
_NOTE_SCHEMA: dict[str, Any] = {'note': pl.Utf8}
_BOT_SPLIT_SCHEMA: dict[str, Any] = {'category': pl.Utf8, 'open_count': pl.Int64}

NOT_COMPUTED_NOTE = pl.DataFrame(
    {
        'note': [
            (
                'Priority-crossed-upward and reopened-ticket detection need a snapshot from a prior '
                'run to diff against; tlr keeps none, so these are not computed.'
            ),
        ],
    },
    schema=_NOTE_SCHEMA,
)


@dataclass(frozen=True)
class PeriodWindow:
    """A period's `[start, end)` plus the same-length period immediately before it."""

    start: datetime
    end: datetime
    previous_start: datetime
    previous_end: datetime


def _week_bounds(on: date) -> tuple[date, date]:
    start = on - timedelta(days=on.weekday())
    return start, start + timedelta(days=7)


_DECEMBER = 12


def _month_bounds(on: date) -> tuple[date, date]:
    start = on.replace(day=1)
    end = date(start.year + 1, 1, 1) if start.month == _DECEMBER else date(start.year, start.month + 1, 1)
    return start, end


def _midnight(on: date) -> datetime:
    return datetime.combine(on, time.min)


def period_window(period: str, as_of: datetime) -> PeriodWindow:
    """Compute `[start, end)` for `period` ('week' or 'month') containing `as_of`, and the period before it.

    A week runs Monday through Sunday; a month runs the 1st through its last day. Both bounds are
    midnight-aligned regardless of the time of day carried by `as_of`.
    """
    bounds = _week_bounds if period == 'week' else _month_bounds
    start_date, end_date = bounds(as_of.date())
    previous_start_date, previous_end_date = bounds(start_date - timedelta(days=1))
    return PeriodWindow(
        start=_midnight(start_date),
        end=_midnight(end_date),
        previous_start=_midnight(previous_start_date),
        previous_end=_midnight(previous_end_date),
    )


def _linear_open_at(issues: pl.DataFrame, at: datetime, closed_like_state_names: Sequence[str] = ()) -> pl.DataFrame:
    """Issues open at `at`: created, not archived, not completed/canceled, and not in a closed-like state.

    Archived is excluded because Linear archives issues out of the default view independent of
    `completedAt`/`canceledAt`; an archived backlog issue with neither timestamp set otherwise reads
    as open forever. `closed_like_state_names` covers a workspace state (e.g. a literal "Duplicate"
    status) whose type does not set either timestamp.
    """
    return issues.filter(
        (pl.col('created_at') <= at)
        & pl.col('archived_at').is_null()
        & (pl.col('completed_at').is_null() | (pl.col('completed_at') > at))
        & (pl.col('canceled_at').is_null() | (pl.col('canceled_at') > at))
        & ~pl.col('state_name').is_in(list(closed_like_state_names)),
    )


def _linear_priority_label() -> pl.Expr:
    return pl.col('priority').fill_null(0).replace_strict(LINEAR_PRIORITY_LABELS, default='None', return_dtype=pl.Utf8)


def _priority_rank(column: str, ranked_values: list[str]) -> pl.Expr:
    rank_map = {value: index for index, value in enumerate(ranked_values)}
    return pl.col(column).replace_strict(rank_map, default=len(ranked_values), return_dtype=pl.Int64)


def _priority_breakdown(
    current: pl.DataFrame,
    previous: pl.DataFrame,
    priority_col: str,
    order: list[str],
) -> pl.DataFrame:
    current_counts = current.group_by(priority_col).len(name='open_count').cast({'open_count': pl.Int64})
    previous_counts = previous.group_by(priority_col).len(name='previous_count').cast({'previous_count': pl.Int64})
    return (
        pl.DataFrame({priority_col: order})
        .join(current_counts, on=priority_col, how='left', maintain_order='left')
        .join(previous_counts, on=priority_col, how='left', maintain_order='left')
        .with_columns(pl.col('open_count').fill_null(0), pl.col('previous_count').fill_null(0))
        .with_columns((pl.col('open_count') - pl.col('previous_count')).alias('delta'))
        .select(pl.col(priority_col).alias('priority'), 'open_count', 'delta')
    )


def linear_priority_breakdown(
    issues: pl.DataFrame,
    *,
    now: datetime,
    previous_at: datetime,
    closed_like_state_names: Sequence[str] = (),
) -> pl.DataFrame:
    """Open Linear issues by priority as of `now`, with the delta against the same count as of `previous_at`."""
    current = _linear_open_at(issues, now, closed_like_state_names).with_columns(
        _linear_priority_label().alias('priority_label'),
    )
    previous = _linear_open_at(issues, previous_at, closed_like_state_names).with_columns(
        _linear_priority_label().alias('priority_label'),
    )
    return _priority_breakdown(current, previous, 'priority_label', LINEAR_PRIORITY_ORDER)


def linear_created_closed(issues: pl.DataFrame, *, window_start: datetime, window_end: datetime) -> pl.DataFrame:
    """Count Linear issues created, and completed or canceled, in `[window_start, window_end)`."""
    created = issues.filter((pl.col('created_at') >= window_start) & (pl.col('created_at') < window_end)).height
    closed_at = pl.coalesce(pl.col('completed_at'), pl.col('canceled_at'))
    closed = issues.filter(closed_at.is_not_null() & (closed_at >= window_start) & (closed_at < window_end)).height
    return pl.DataFrame([{'created': created, 'closed': closed}], schema=_CREATED_CLOSED_SCHEMA)


def linear_untracked(
    issues: pl.DataFrame,
    *,
    now: datetime,
    closed_like_state_names: Sequence[str] = (),
) -> pl.DataFrame:
    """Currently-open Linear issues with no priority set and with no assignee, as of `now`."""
    open_now = _linear_open_at(issues, now, closed_like_state_names)
    no_priority = open_now.filter(pl.col('priority').fill_null(0) == 0).height
    no_assignee = open_now.filter(pl.col('assignee_name').is_null() | (pl.col('assignee_name') == UNASSIGNED)).height
    return pl.DataFrame([{'no_priority': no_priority, 'no_assignee': no_assignee}], schema=_UNTRACKED_SCHEMA)


def linear_oldest_open(
    issues: pl.DataFrame,
    *,
    now: datetime,
    limit: int = 5,
    closed_like_state_names: Sequence[str] = (),
) -> pl.DataFrame:
    """The `limit` oldest open Linear issues per priority, ordered Urgent, High, Medium, Low, None."""
    open_now = _linear_open_at(issues, now, closed_like_state_names).with_columns(
        _linear_priority_label().alias('priority'),
        (pl.lit(now) - pl.col('created_at')).dt.total_days().cast(pl.Int64).alias('age_days'),
    )
    if open_now.is_empty():
        return open_now.select(list(_OLDEST_LINEAR_SCHEMA))
    ranked = open_now.with_columns(_priority_rank('priority', LINEAR_PRIORITY_ORDER).alias('_rank')).sort(
        ['_rank', 'age_days'],
        descending=[False, True],
        maintain_order=True,
    )
    within_group = ranked.with_columns(pl.int_range(pl.len()).over('priority').alias('_within'))
    return within_group.filter(pl.col('_within') < limit).select(list(_OLDEST_LINEAR_SCHEMA))


def labels_are_sparse(
    issues: pl.DataFrame,
    issue_labels: pl.DataFrame,
    *,
    window_start: datetime,
    window_end: datetime,
    threshold: float = 0.5,
) -> bool:
    """True when fewer than `threshold` of the issues created in the period carry at least one label."""
    created = issues.filter((pl.col('created_at') >= window_start) & (pl.col('created_at') < window_end))
    if created.is_empty():
        return False
    labeled_ids = set(issue_labels['issue_id'].to_list()) if not issue_labels.is_empty() else set()
    labeled_count = created.filter(pl.col('id').is_in(labeled_ids)).height
    return (labeled_count / created.height) < threshold


def linear_label_distribution(
    issues: pl.DataFrame,
    issue_labels: pl.DataFrame,
    *,
    window_start: datetime,
    window_end: datetime,
    top_n: int = 10,
) -> pl.DataFrame:
    """Top `top_n` labels on Linear issues created in `[window_start, window_end)`, most common first.

    Labels are the only categorization Linear issues carry in this store, so this doubles as the
    period's only categorical view of what came in.
    """
    created = issues.filter((pl.col('created_at') >= window_start) & (pl.col('created_at') < window_end)).select('id')
    if created.is_empty() or issue_labels.is_empty():
        return pl.DataFrame(schema=_LABEL_SCHEMA)
    joined = created.join(issue_labels, left_on='id', right_on='issue_id', how='inner')
    if joined.is_empty():
        return pl.DataFrame(schema=_LABEL_SCHEMA)
    return (
        joined.group_by('label')
        .len(name='count')
        .cast({'count': pl.Int64})
        .sort('count', descending=True)
        .head(top_n)
        .select(list(_LABEL_SCHEMA))
    )


def linear_bot_filed_split(
    issues: pl.DataFrame,
    issue_labels: pl.DataFrame,
    *,
    bot_label: str,
    now: datetime,
    closed_like_state_names: Sequence[str] = (),
) -> pl.DataFrame:
    """Currently-open Linear issues carrying `bot_label`, against every other open issue.

    Excluded from the "human backlog" reading of the other sections, which count every open issue
    regardless of this split; this row is what to subtract to get the human-filed count.
    """
    open_now = _linear_open_at(issues, now, closed_like_state_names)
    bot_ids = (
        set(issue_labels.filter(pl.col('label') == bot_label)['issue_id'].to_list())
        if bot_label and not issue_labels.is_empty()
        else set()
    )
    bot_count = open_now.filter(pl.col('id').is_in(bot_ids)).height
    human_count = open_now.height - bot_count
    return pl.DataFrame(
        [{'category': 'bot-filed', 'open_count': bot_count}, {'category': 'human', 'open_count': human_count}],
        schema=_BOT_SPLIT_SCHEMA,
    )


def _age_text(age: timedelta) -> str:
    if age.total_seconds() <= 0:
        return '0m'
    if age.days >= 1:
        return f'{age.days}d'
    hours = age.seconds // 3600
    if hours >= 1:
        return f'{hours}h'
    return f'{age.seconds // 60}m'


def freshness_line(refreshes: pl.DataFrame, *, sources: Sequence[str], now: datetime) -> str:
    """One-line store freshness: 'Data freshness: linear refreshed … (2d ago), pylon never refreshed.'."""
    latest = {row['source']: row['last_run_at'] for row in refreshes.to_dicts()}
    parts: list[str] = []
    for source in sources:
        stamp = latest.get(source)
        parts.append(
            f'{source} refreshed {stamp:%Y-%m-%d %H:%M} ({_age_text(now - stamp)} ago)'
            if stamp is not None
            else f'{source} never refreshed',
        )
    return 'Data freshness: ' + ', '.join(parts) + '.'


def snapshot_header(
    window: PeriodWindow,
    *,
    period: str,
    closed_like_state_names: Sequence[str],
    bot_label: str,
    refreshes: pl.DataFrame,
    tracked_sources: Sequence[str],
    now: datetime,
) -> pl.DataFrame:
    """Period bounds, the open/bot-filed definitions, and store freshness, for the check-in's header."""
    closed_like = ', '.join(closed_like_state_names) if closed_like_state_names else 'none configured'
    period_line = (
        f'{period.capitalize()}: {window.start.date()} to {window.end.date()} (exclusive), '
        f'compared against {window.previous_start.date()} to {window.previous_end.date()}.'
    )
    open_line = (
        'Open: created by this instant, not archived, not completed/canceled, and not in a '
        f'closed-like state ({closed_like}).'
    )
    bot_line = (
        f'Bot-filed: open issues carrying the label {bot_label!r}.' if bot_label else 'Bot-filed: not configured.'
    )
    lines = [period_line, open_line, bot_line]
    if tracked_sources:
        lines.append(freshness_line(refreshes, sources=tracked_sources, now=now))
    return pl.DataFrame({'note': lines}, schema=_NOTE_SCHEMA)


def pylon_priority_breakdown(
    pylon_issues: pl.DataFrame,
    priority_values: list[str],
    *,
    now: datetime,
    previous_at: datetime,
) -> pl.DataFrame:
    """Open Pylon issues by priority as of `now`, with the delta against the same count as of `previous_at`."""
    order = [*priority_values, 'none']
    current = _pylon_open_at(pylon_issues, now).with_columns(pl.col('priority').fill_null('none'))
    previous = _pylon_open_at(pylon_issues, previous_at).with_columns(pl.col('priority').fill_null('none'))
    return _priority_breakdown(current, previous, 'priority', order)


def pylon_created_resolved(pylon_issues: pl.DataFrame, *, window_start: datetime, window_end: datetime) -> pl.DataFrame:
    """Count Pylon issues created, and resolved, in `[window_start, window_end)`."""
    created = pylon_issues.filter((pl.col('created_at') >= window_start) & (pl.col('created_at') < window_end)).height
    resolved = pylon_issues.filter(
        pl.col('resolution_time').is_not_null()
        & (pl.col('resolution_time') >= window_start)
        & (pl.col('resolution_time') < window_end),
    ).height
    return pl.DataFrame([{'created': created, 'resolved': resolved}], schema=_CREATED_RESOLVED_SCHEMA)


def pylon_oldest_open(pylon_issues: pl.DataFrame, *, now: datetime, limit: int = 5) -> pl.DataFrame:
    """The `limit` oldest currently-open Pylon issues, oldest first."""
    open_now = _pylon_open_at(pylon_issues, now).with_columns(
        pl.col('priority').fill_null('none'),
        (pl.lit(now) - pl.col('created_at')).dt.total_days().cast(pl.Int64).alias('age_days'),
    )
    return open_now.sort('age_days', descending=True).head(limit).select(list(_OLDEST_PYLON_SCHEMA))


def pylon_top_tags(pylon_issue_labels: pl.DataFrame, *, top_n: int = 10) -> pl.DataFrame:
    """Top `top_n` Pylon tags across every currently stored issue, most common first."""
    if pylon_issue_labels.is_empty():
        return pl.DataFrame(schema=_LABEL_SCHEMA)
    tags = pylon_issue_labels.filter(pl.col('kind') == PYLON_LABEL_KIND_TAG)
    if tags.is_empty():
        return pl.DataFrame(schema=_LABEL_SCHEMA)
    return (
        tags.group_by('label')
        .len(name='count')
        .cast({'count': pl.Int64})
        .sort('count', descending=True)
        .head(top_n)
        .select(list(_LABEL_SCHEMA))
    )


def pylon_over_sla(
    pylon_issues: pl.DataFrame,
    sla: SlaConfig,
    *,
    now: datetime,
    top_n: int = 25,
) -> pl.DataFrame:
    """The `top_n` open Pylon issues past their priority's SLA target, oldest overage first."""
    open_now = _pylon_open_at(pylon_issues, now).with_columns(
        (pl.lit(now) - pl.col('created_at')).dt.total_days().cast(pl.Int64).alias('age_days'),
    )
    if open_now.is_empty() or not sla.target_days_by_priority:
        return pl.DataFrame(schema=_OVER_SLA_SCHEMA)
    target = pl.col('priority').replace_strict(sla.target_days_by_priority, default=None, return_dtype=pl.Int64)
    over = open_now.with_columns(target.alias('sla_target_days')).filter(
        pl.col('sla_target_days').is_not_null() & (pl.col('age_days') > pl.col('sla_target_days')),
    )
    return over.sort('age_days', descending=True).head(top_n).select(list(_OVER_SLA_SCHEMA))


def sentry_section(
    sentry_issues: pl.DataFrame,
    *,
    configured: bool,
    window_start: datetime,
    window_end: datetime,
    top_n: int = 10,
) -> list[tuple[str, pl.DataFrame]]:
    """Sentry's slice of the snapshot: new unresolved issues this period, and the top ones by event count.

    Sentry's issue-list endpoint carries no Linear-link field (that needs `expand=integrationIssues`
    or the issue-detail endpoint, neither of which tlr fetches), so the linked-vs-not split is
    skipped and said so in the output rather than guessed at.
    """
    if not configured:
        return [('Sentry', pl.DataFrame({'note': ['Sentry: not configured']}, schema=_NOTE_SCHEMA))]
    new_in_period = sentry_issues.filter(
        (pl.col('first_seen') >= window_start) & (pl.col('first_seen') < window_end),
    ).height
    top = (
        sentry_issues.sort('times_seen', descending=True)
        .head(top_n)
        .select('project_slug', 'title', 'times_seen', 'first_seen', 'permalink')
    )
    summary = pl.DataFrame(
        [{'new_unresolved_this_period': new_in_period, 'total_unresolved_tracked': sentry_issues.height}],
    )
    return [
        ('Sentry: summary', summary),
        ('Sentry: top by event count', top),
        (
            'Sentry: linked to Linear',
            pl.DataFrame({'note': ['not available from the issue-list endpoint; skipped']}, schema=_NOTE_SCHEMA),
        ),
    ]


def build_snapshot_sections(
    issues: pl.DataFrame,
    issue_labels: pl.DataFrame,
    pylon_issues: pl.DataFrame,
    pylon_issue_labels: pl.DataFrame,
    sentry_issues: pl.DataFrame,
    *,
    window: PeriodWindow,
    pylon_priority_values: list[str],
    sla: SlaConfig,
    sentry_configured: bool,
    oldest_limit: int = 5,
    top_n: int = 10,
    period: str = 'week',
    closed_like_state_names: Sequence[str] = (),
    bot_label: str = '',
    refreshes: pl.DataFrame | None = None,
    tracked_sources: Sequence[str] = (),
    now: datetime | None = None,
) -> list[tuple[str, pl.DataFrame | str]]:
    """Assemble every snapshot section, ready for `tlr.render.markdown.sections_to_markdown`.

    `refreshes` (the store's refresh_runs frame) with `tracked_sources` stamps the header
    with each source's last refresh; `now` ages those stamps and may differ from
    `window.end` when the caller pins `--as-of` to a past instant.
    """
    sparse = labels_are_sparse(issues, issue_labels, window_start=window.start, window_end=window.end)
    label_heading = 'Linear: top labels created this period' + (' (labels are sparse this period)' if sparse else '')

    linear_priority = linear_priority_breakdown(
        issues,
        now=window.end,
        previous_at=window.previous_end,
        closed_like_state_names=closed_like_state_names,
    )
    linear_created_closed_counts = linear_created_closed(issues, window_start=window.start, window_end=window.end)
    linear_oldest = linear_oldest_open(
        issues,
        now=window.end,
        limit=oldest_limit,
        closed_like_state_names=closed_like_state_names,
    )
    linear_labels = linear_label_distribution(
        issues,
        issue_labels,
        window_start=window.start,
        window_end=window.end,
        top_n=top_n,
    )
    pylon_priority = pylon_priority_breakdown(
        pylon_issues,
        pylon_priority_values,
        now=window.end,
        previous_at=window.previous_end,
    )
    pylon_created_resolved_counts = pylon_created_resolved(
        pylon_issues,
        window_start=window.start,
        window_end=window.end,
    )
    pylon_resolution_time = close_time(pylon_issues, sla, window_start=window.start, window_end=window.end)

    sections: list[tuple[str, pl.DataFrame | str]] = [
        (
            'Snapshot',
            snapshot_header(
                window,
                period=period,
                closed_like_state_names=closed_like_state_names,
                bot_label=bot_label,
                refreshes=refreshes if refreshes is not None else pl.DataFrame(),
                tracked_sources=tracked_sources,
                now=now if now is not None else window.end,
            ),
        ),
        ('Linear: open by priority', linear_priority),
        (
            'Linear: bot-filed vs human, open now',
            linear_bot_filed_split(
                issues,
                issue_labels,
                bot_label=bot_label,
                now=window.end,
                closed_like_state_names=closed_like_state_names,
            ),
        ),
        ('Linear: created/closed this period', linear_created_closed_counts),
        (
            'Linear: untracked',
            linear_untracked(issues, now=window.end, closed_like_state_names=closed_like_state_names),
        ),
        ('Linear: oldest open by priority', linear_oldest),
        (label_heading, linear_labels),
        ('Pylon: open by priority', pylon_priority),
        ('Pylon: created/resolved this period', pylon_created_resolved_counts),
        ('Pylon: resolution time this period', pylon_resolution_time),
        ('Pylon: oldest open', pylon_oldest_open(pylon_issues, now=window.end, limit=oldest_limit)),
        ('Pylon: top tags', pylon_top_tags(pylon_issue_labels, top_n=top_n)),
    ]
    sections.extend(
        sentry_section(
            sentry_issues,
            configured=sentry_configured,
            window_start=window.start,
            window_end=window.end,
            top_n=top_n,
        ),
    )
    sections.extend(
        [
            ('Notable: Pylon past SLA', pylon_over_sla(pylon_issues, sla, now=window.end)),
            ('Notable: not computed', NOT_COMPUTED_NOTE),
        ],
    )
    return sections
