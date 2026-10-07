"""Alarm categorization, fire counting, and Linear mapping for the check-in.

Every function is pure: frames and config values in, a frame out. `env` is not parsed
out of alarm names; it is the profile label the fetch ran under, so the prod/stage
split stays correct even for names that break the naming convention.

A "fire" is a state transition *into* ALARM, so an alarm that flaps OK->ALARM->OK->ALARM
counts twice, which is the number a meeting wants.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta
from fnmatch import fnmatchcase
from operator import itemgetter
from typing import Any, Final
from urllib.parse import quote

import polars as pl

from tlr.config import AlarmsConfig
from tlr.domain.snapshot import PeriodWindow, _linear_open_at

ALARM_STATE: Final = 'ALARM'
UNCATEGORIZED: Final = 'uncategorized'
HISTORY_RETENTION_DAYS: Final = 30
"""CloudWatch keeps alarm history roughly a month (observed ~31 days on a 60-day
request), so windows asking further back get a truncation note rather than silently
reading as quiet periods."""

FLAP_MIN_FIRES: Final = 5
FLAP_AVG_DWELL_MINUTES: Final = 60
"""An alarm is 'flapping' when it fires at least FLAP_MIN_FIRES times yet spends under
FLAP_AVG_DWELL_MINUTES in ALARM per fire on average: noise to fix in the alarm, not a
sustained incident. Every other firing alarm is 'sustained'."""

_FIRES_SCHEMA: dict[str, Any] = {'env': pl.Utf8, 'name': pl.Utf8, 'fires': pl.Int64}
_PERIOD_TABLE_SCHEMA: dict[str, Any] = {
    'env': pl.Utf8,
    'name': pl.Utf8,
    'category': pl.Utf8,
    'severity': pl.Utf8,
    'state': pl.Utf8,
    'state_updated': pl.Datetime('us'),
    'fires': pl.Int64,
    'previous': pl.Int64,
    'delta': pl.Int64,
    'mins_in_alarm': pl.Int64,
    'kind': pl.Utf8,
}
_NOTE_SCHEMA: dict[str, Any] = {'note': pl.Utf8}


def categorize_name(
    name: str,
    *,
    categories: Mapping[str, Sequence[str]],
    severity_suffixes: Sequence[str],
) -> tuple[str, str]:
    """Resolve one alarm name to (category, severity).

    Category is the first configured category with a glob matching the name, else
    'uncategorized'. Severity is the configured suffix the name ends with (suffixes can
    be multi-token, e.g. `-low-urgency`).
    """
    category = next(
        (
            candidate
            for candidate, patterns in categories.items()
            if any(fnmatchcase(name, pattern) for pattern in patterns)
        ),
        UNCATEGORIZED,
    )
    severity = next(
        (suffix for suffix in severity_suffixes if name == suffix or name.endswith(f'-{suffix}')),
        '',
    )
    return category, severity


def with_alarm_meta(alarms: pl.DataFrame, config: AlarmsConfig) -> pl.DataFrame:
    """Add `category` and `severity` columns derived from the alarm name."""
    if alarms.is_empty():
        return alarms.with_columns(pl.lit('').alias('category'), pl.lit('').alias('severity'))
    pairs = [
        categorize_name(
            name,
            categories=config.categories,
            severity_suffixes=config.severity_suffixes,
        )
        for name in alarms['name'].to_list()
    ]
    return alarms.with_columns(
        pl.Series('category', [category for category, _ in pairs]),
        pl.Series('severity', [severity for _, severity in pairs]),
    )


def fire_counts(transitions: pl.DataFrame, *, start: datetime, end: datetime) -> pl.DataFrame:
    """Transitions into ALARM within `[start, end)`, counted per (env, alarm)."""
    if transitions.is_empty():
        return pl.DataFrame(schema=_FIRES_SCHEMA)
    in_window = transitions.filter(
        (pl.col('to_state') == ALARM_STATE) & (pl.col('occurred_at') >= start) & (pl.col('occurred_at') < end),
    )
    if in_window.is_empty():
        return pl.DataFrame(schema=_FIRES_SCHEMA)
    return (
        in_window.group_by('env', 'alarm_name')
        .len(name='fires')
        .rename({'alarm_name': 'name'})
        .cast({'fires': pl.Int64})
        .select(list(_FIRES_SCHEMA))
    )


def _dwell_seconds(
    history: list[dict[str, Any]],
    *,
    state: str,
    state_updated: datetime | None,
    start: datetime,
    end: datetime,
) -> float:
    if not history:
        if state != ALARM_STATE or state_updated is None or state_updated >= end:
            return 0.0
        return (end - max(state_updated, start)).total_seconds()
    prior = [item for item in history if item['occurred_at'] < start]
    in_alarm = bool(prior and prior[-1]['to_state'] == ALARM_STATE) or (
        state == ALARM_STATE and (state_updated is None or state_updated < start)
    )
    cursor = start
    seconds = 0.0
    for item in history:
        if not start <= item['occurred_at'] < end:
            continue
        if in_alarm:
            seconds += (item['occurred_at'] - cursor).total_seconds()
        in_alarm = item['to_state'] == ALARM_STATE
        cursor = item['occurred_at']
    if in_alarm:
        seconds += (end - cursor).total_seconds()
    return seconds


def time_in_alarm(meta: pl.DataFrame, transitions: pl.DataFrame, *, start: datetime, end: datetime) -> pl.DataFrame:
    """Minutes spent in ALARM within `[start, end)` per alarm, keyed on (env, name).

    The state at `start` is the last transition before the window when one exists, else
    the alarm's own `state`/`state_updated` (CloudWatch's truth for the current state).
    An alarm with no transition rows at all falls back to `state_updated` alone, so an
    alarm that has been in ALARM longer than history retention still reports dwell.
    Transitions whose summary parsed to no `to_state` are skipped.
    """
    schema = {'env': pl.Utf8, 'name': pl.Utf8, 'mins_in_alarm': pl.Int64}
    if meta.is_empty():
        return pl.DataFrame(schema=schema)

    by_alarm: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in transitions.iter_rows(named=True):
        if row['to_state'] is not None and row['occurred_at'] is not None:
            by_alarm.setdefault((row['env'], row['alarm_name']), []).append(row)
    for rows in by_alarm.values():
        rows.sort(key=itemgetter('occurred_at'))

    return pl.DataFrame(
        [
            {
                'env': row['env'],
                'name': row['name'],
                'mins_in_alarm': int(
                    _dwell_seconds(
                        by_alarm.get((row['env'], row['name']), []),
                        state=row['state'],
                        state_updated=row['state_updated'],
                        start=start,
                        end=end,
                    )
                    // 60,
                ),
            }
            for row in meta.iter_rows(named=True)
        ],
        schema=schema,
    )


def _kind() -> pl.Expr:
    avg_dwell_low = pl.col('mins_in_alarm') <= pl.col('fires') * FLAP_AVG_DWELL_MINUTES
    return (
        pl.when((pl.col('fires') >= FLAP_MIN_FIRES) & avg_dwell_low)
        .then(pl.lit('flapping'))
        .when((pl.col('fires') > 0) | (pl.col('state') == ALARM_STATE))
        .then(pl.lit('sustained'))
        .otherwise(pl.lit(''))
        .alias('kind')
    )


def alarm_period_table(meta: pl.DataFrame, transitions: pl.DataFrame, *, window: PeriodWindow) -> pl.DataFrame:
    """One row per alarm: state and category, fires this period and last, dwell, and the delta."""
    if meta.is_empty():
        return pl.DataFrame(schema=_PERIOD_TABLE_SCHEMA)
    current = fire_counts(transitions, start=window.start, end=window.end)
    previous = fire_counts(transitions, start=window.previous_start, end=window.previous_end).rename(
        {'fires': 'previous'},
    )
    dwell = time_in_alarm(meta, transitions, start=window.start, end=window.end)
    return (
        meta.select('env', 'name', 'category', 'severity', 'state', 'state_updated')
        .join(current, on=['env', 'name'], how='left')
        .join(previous, on=['env', 'name'], how='left')
        .join(dwell, on=['env', 'name'], how='left')
        .with_columns(
            pl.col('fires').fill_null(0),
            pl.col('previous').fill_null(0),
            pl.col('mins_in_alarm').fill_null(0),
        )
        .with_columns((pl.col('fires') - pl.col('previous')).alias('delta'))
        .with_columns(_kind())
        .select(list(_PERIOD_TABLE_SCHEMA))
    )


def env_rollup(linked: pl.DataFrame) -> pl.DataFrame:
    """Per environment: fires and the delta, what changed, and ticket coverage.

    Takes the Linear-linked period table so `fired_no_ticket` can count alarms that
    fired this period without an open Linear issue.
    """
    schema = {
        'env': pl.Utf8,
        'tracked': pl.Int64,
        'in_alarm_now': pl.Int64,
        'alarms_fired': pl.Int64,
        'new': pl.Int64,
        'quieted': pl.Int64,
        'fired_no_ticket': pl.Int64,
        'fires': pl.Int64,
        'previous': pl.Int64,
        'delta': pl.Int64,
    }
    if linked.is_empty():
        return pl.DataFrame(schema=schema)
    return (
        linked.group_by('env')
        .agg(
            pl.len().alias('tracked'),
            (pl.col('state') == ALARM_STATE).sum().alias('in_alarm_now'),
            (pl.col('fires') > 0).sum().alias('alarms_fired'),
            ((pl.col('fires') > 0) & (pl.col('previous') == 0)).sum().alias('new'),
            ((pl.col('previous') > 0) & (pl.col('fires') == 0)).sum().alias('quieted'),
            ((pl.col('fires') > 0) & pl.col('linear_open').eq('')).sum().alias('fired_no_ticket'),
            pl.col('fires').sum(),
            pl.col('previous').sum(),
            pl.col('delta').sum(),
        )
        .sort('env')
    )


def category_rollup(table: pl.DataFrame) -> pl.DataFrame:
    """Fires per (env, category) for groups that fired in either period."""
    schema = {
        'env': pl.Utf8,
        'category': pl.Utf8,
        'alarms_fired': pl.Int64,
        'fires': pl.Int64,
        'previous': pl.Int64,
        'delta': pl.Int64,
    }
    if table.is_empty():
        return pl.DataFrame(schema=schema)
    fired = table.filter((pl.col('fires') > 0) | (pl.col('previous') > 0))
    if fired.is_empty():
        return pl.DataFrame(schema=schema)
    return (
        fired.group_by('env', 'category')
        .agg(
            (pl.col('fires') > 0).sum().alias('alarms_fired'),
            pl.col('fires').sum(),
            pl.col('previous').sum(),
            pl.col('delta').sum(),
        )
        .sort('fires', 'env', 'category', descending=[True, False, False])
    )


def with_linear_matches(
    table: pl.DataFrame,
    issues: pl.DataFrame,
    *,
    now: datetime,
    closed_like_state_names: Sequence[str] = (),
) -> pl.DataFrame:
    """Add Linear match columns: `linear_open` identifiers and a `linear_closed` count.

    A match is an issue whose title contains the alarm name (the watch-bot convention is
    `<alarm-name>: <summary>`); each open identifier carries its state in parentheses so
    a reader can tell triaged work from untouched backlog. `linear_closed` counts matches
    no longer open.
    """
    if table.is_empty():
        return table.with_columns(
            pl.lit('').alias('linear_open'),
            pl.lit(0).cast(pl.Int64).alias('linear_closed'),
        )
    open_ids = (
        set(_linear_open_at(issues, now, closed_like_state_names)['id'].to_list()) if not issues.is_empty() else set()
    )
    open_labels: list[str] = []
    closed_counts: list[int] = []
    for name in table['name'].to_list():
        matched = (
            issues.filter(pl.col('title').fill_null('').str.contains(name, literal=True))
            if not issues.is_empty()
            else issues
        )
        open_rows = matched.filter(pl.col('id').is_in(open_ids)).sort('identifier')
        labels: list[str] = []
        for row in open_rows.iter_rows(named=True):
            label = f"[{row['identifier']}]({row['url']})" if row.get('url') else row['identifier']
            if row['state_name']:
                label += f" ({row['state_name']})"
            labels.append(label)
        open_labels.append(', '.join(labels))
        closed_counts.append(matched.height - open_rows.height)
    return table.with_columns(
        pl.Series('linear_open', open_labels),
        pl.Series('linear_closed', closed_counts),
    )


def _with_console_links(linked: pl.DataFrame, *, region: str) -> pl.DataFrame:
    """Wrap every `name` cell in a CloudWatch console link; `region` empty leaves names plain."""
    if not region or linked.is_empty():
        return linked
    base = f'https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}#alarmsV2:alarm/'
    return linked.with_columns(
        pl.Series('name', [f'[{name}]({base}{quote(name)})' for name in linked['name'].to_list()]),
    )


def fires_per_day(transitions: pl.DataFrame, *, window: PeriodWindow) -> pl.DataFrame:
    """ALARM transitions in the current window, bucketed per calendar day per env."""
    schema = {'day': pl.Date, 'env': pl.Utf8, 'fires': pl.Int64}
    in_window = transitions.filter(
        (pl.col('to_state') == ALARM_STATE)
        & (pl.col('occurred_at') >= window.start)
        & (pl.col('occurred_at') < window.end),
    )
    if in_window.is_empty():
        return pl.DataFrame(schema=schema)
    return (
        in_window.with_columns(pl.col('occurred_at').dt.date().alias('day'))
        .group_by('day', 'env')
        .len(name='fires')
        .cast({'fires': pl.Int64})
        .sort('day', 'env')
        .select(list(schema))
    )


def fires_chart(per_day: pl.DataFrame, *, env: str, window: PeriodWindow) -> str | None:
    """A mermaid xychart of daily fires for one env; None when the env never fired.

    One chart per env rather than one chart with two series, because xychart-beta has no
    series labels — a second unlabeled bar array would be unreadable.
    """
    rows = per_day.filter(pl.col('env') == env)
    if rows.is_empty():
        return None
    last_day = (window.end - timedelta(microseconds=1)).date()
    days: list[date] = []
    day = window.start.date()
    while day <= last_day:
        days.append(day)
        day += timedelta(days=1)
    counts = {row['day']: row['fires'] for row in rows.iter_rows(named=True)}
    series = [counts.get(day, 0) for day in days]
    labels = ', '.join(f'"{day:%m-%d}"' for day in days)
    values = ', '.join(str(value) for value in series)
    return (
        '```mermaid\n'
        'xychart-beta\n'
        f'    title "alarm fires per day — {env}"\n'
        f'    x-axis [{labels}]\n'
        f'    y-axis "fires" 0 --> {max(*series, 1)}\n'
        f'    bar [{values}]\n'
        '```'
    )


def _retention_note(window: PeriodWindow, *, fetched_at: datetime) -> pl.DataFrame | None:
    retention_start = fetched_at.timestamp() - HISTORY_RETENTION_DAYS * 86400
    if window.previous_start.timestamp() >= retention_start:
        return None
    return pl.DataFrame(
        {
            'note': [
                (
                    f'CloudWatch keeps roughly {HISTORY_RETENTION_DAYS} days of alarm history; '
                    'transitions earlier than that are missing rather than zero, so the '
                    'previous-period counts above are a floor.'
                ),
            ],
        },
        schema=_NOTE_SCHEMA,
    )


def build_alarm_sections(
    alarms: pl.DataFrame,
    transitions: pl.DataFrame,
    issues: pl.DataFrame,
    *,
    window: PeriodWindow,
    config: AlarmsConfig,
    fetched_at: datetime,
    closed_like_state_names: Sequence[str] = (),
    top_n: int = 10,
    include_detail: bool = False,
) -> list[tuple[str, pl.DataFrame | str]]:
    """Assemble the alarm sections shared by `snapshot` and `tlr alarms`."""
    meta = with_alarm_meta(alarms, config)
    table = alarm_period_table(meta, transitions, window=window)
    linked = with_linear_matches(table, issues, now=window.end, closed_like_state_names=closed_like_state_names)
    displayed = _with_console_links(linked, region=config.console_region)

    new_period = (
        displayed.filter((pl.col('fires') > 0) & (pl.col('previous') == 0))
        .sort('fires', 'name', descending=[True, False])
        .select('env', 'name', 'category', 'kind', 'fires', 'state', 'linear_open')
    )
    quieted = (
        displayed.filter((pl.col('previous') > 0) & (pl.col('fires') == 0))
        .sort('previous', 'name', descending=[True, False])
        .select('env', 'name', 'category', 'previous', 'state', 'linear_open')
    )
    leading = (
        displayed.filter(pl.col('fires') > 0)
        .sort('fires', 'name', descending=[True, False])
        .head(top_n)
        .select(
            'env', 'name', 'category', 'kind', 'fires', 'previous', 'delta', 'mins_in_alarm', 'state', 'linear_open'
        )
    )
    flapping = (
        displayed.filter(pl.col('kind') == 'flapping')
        .sort('fires', 'name', descending=[True, False])
        .select('env', 'name', 'category', 'fires', 'mins_in_alarm', 'state', 'linear_open')
    )
    in_alarm = (
        displayed.filter(pl.col('state') == ALARM_STATE)
        .sort('env', 'name')
        .select('env', 'name', pl.col('state_updated').alias('since'), 'fires', 'mins_in_alarm', 'linear_open')
    )
    unmapped = (
        displayed.filter((pl.col('fires') > 0) & pl.col('linear_open').eq(''))
        .sort('fires', 'name', descending=[True, False])
        .select('env', 'name', 'category', 'kind', 'fires', 'state', 'linear_closed')
    )

    sections: list[tuple[str, pl.DataFrame | str]] = [
        ('Alarms: fires by environment', env_rollup(linked)),
        ('Alarms: fires by category', category_rollup(table)),
    ]
    if not meta.is_empty():
        per_day = fires_per_day(transitions, window=window)
        sections.extend(
            (f'Alarms: fires per day — {env}', chart)
            for env in sorted(meta['env'].unique().to_list())
            if (chart := fires_chart(per_day, env=env, window=window)) is not None
        )
    sections.extend(
        [
            ('Alarms: new this period', new_period),
            ('Alarms: quieted since last period', quieted),
            ('Alarms: leading this period', leading),
            ('Alarms: flapping', flapping),
            ('Alarms: in ALARM now', in_alarm),
            ('Alarms: fired with no open Linear ticket', unmapped),
        ],
    )
    if include_detail and not displayed.is_empty():
        detail = displayed.sort('env', 'fires', 'name', descending=[False, True, False]).select(
            'env',
            'name',
            'category',
            'severity',
            'kind',
            'state',
            'fires',
            'previous',
            'delta',
            'mins_in_alarm',
            'linear_open',
            'linear_closed',
        )
        sections.append(('Alarms: all tracked', detail))
    note = _retention_note(window, fetched_at=fetched_at)
    if note is not None:
        sections.append(('Alarms: history note', note))
    return sections
