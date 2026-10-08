"""Wire parsed arguments to config, the store, the domain, and a renderer."""

from __future__ import annotations

import argparse
import json
import subprocess  # noqa: S404 the argv comes from config, never a shell string
import sys
import tomllib
from collections.abc import Sequence
from dataclasses import fields, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb
import polars as pl
import tomlkit
import tomlkit.items

from tlr import store
from tlr.config import TlrConfig, _config_from_data, flatten_config, get_default_config_path, load_config
from tlr.domain import capacity as capacity_domain
from tlr.domain.snapshot import PeriodWindow
from tlr.render.json import frame_to_json, sections_to_json
from tlr.render.markdown import frame_to_markdown, sections_to_markdown

SOURCES = ('linear', 'pylon', 'sentry')

_SAMPLE_CONFIG = Path(__file__).resolve().parent.parent / 'config.sample.toml'


def _emit(text: str) -> None:
    print(text)  # noqa: T201


def _emit_error(text: str) -> None:
    print(text, file=sys.stderr)  # noqa: T201


def _render(frame: pl.DataFrame, output_format: str) -> str:
    return frame_to_markdown(frame) if output_format == 'md' else frame_to_json(frame)


def _render_sections(sections: Sequence[tuple[str, pl.DataFrame | str]], output_format: str) -> str:
    return sections_to_markdown(list(sections)) if output_format == 'md' else sections_to_json(list(sections))


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _open_store(args: argparse.Namespace, config: TlrConfig) -> duckdb.DuckDBPyConnection:
    db_path = Path(args.db).expanduser() if args.db else config.store.database_path
    if db_path is None:
        msg = 'no database path: set [store].database_path or pass --db'
        raise ValueError(msg)
    return store.connect(db_path)


_CONFIG_SECTIONS = frozenset(field.name for field in fields(TlrConfig))


def _config_path(config_path: Path) -> int:
    _emit(str(config_path))
    return 0


def _config_init(config_path: Path) -> int:
    if config_path.exists():
        _emit_error(f'{config_path} already exists; edit it in place')
        return 1
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(_SAMPLE_CONFIG.read_text(encoding='utf-8'), encoding='utf-8')
    _emit(f'wrote {config_path}')
    return 0


def _config_show(config_path: Path) -> int:
    load_config(config_path)
    _emit(config_path.read_text(encoding='utf-8') if config_path.exists() else '# no config file; using defaults')
    return 0


def _format_value(value: Any) -> str:
    return json.dumps(value) if isinstance(value, dict | list | type(None)) else str(value)


def _config_list(config_path: Path) -> int:
    flat = flatten_config(load_config(config_path))
    source = str(config_path) if config_path.exists() else 'no config file; using defaults'
    _emit(f'# {source}')
    for key, value in flat.items():
        _emit(f'{key} = {json.dumps(value)}')
    return 0


def _config_get(config_path: Path, key: str | None) -> int:
    if not key:
        _emit_error('usage: tlr config get <section.field>')
        return 1
    flat = flatten_config(load_config(config_path))
    if key in flat:
        _emit(_format_value(flat[key]))
        return 0
    subtree = {sub[len(key) + 1 :]: value for sub, value in flat.items() if sub.startswith(f'{key}.')}
    if subtree:
        _emit(json.dumps(subtree))
        return 0
    _emit_error(f'unknown key {key!r}; `tlr config list` shows every key')
    return 1


def _parse_config_value(raw: str) -> Any:
    try:
        return tomllib.loads(f'x = {raw}')['x']
    except tomllib.TOMLDecodeError:
        return raw


def _config_set(config_path: Path, key: str | None, raw_value: str | None) -> int:
    if not key or raw_value is None or '.' not in key:
        _emit_error('usage: tlr config set <section.field> <value>, e.g. tlr config set sentry.org_slug my-org')
        return 1
    segments = key.split('.')
    if segments[0] not in _CONFIG_SECTIONS:
        _emit_error(f'unknown section [{segments[0]}]; expected one of {sorted(_CONFIG_SECTIONS)}')
        return 1
    doc = tomlkit.parse(config_path.read_text(encoding='utf-8') if config_path.exists() else '')
    target: Any = doc
    for segment in segments[:-1]:
        node = target.get(segment)
        if node is None:
            node = tomlkit.table()
            target[segment] = node
        elif not isinstance(node, tomlkit.items.AbstractTable):
            _emit_error(f'cannot set {key}: {segment} in {config_path} holds a value, not a table')
            return 1
        target = node
    target[segments[-1]] = _parse_config_value(raw_value)
    new_text = tomlkit.dumps(doc)
    try:
        _config_from_data(tomllib.loads(new_text))
    except ValueError as exc:
        _emit_error(str(exc))
        return 1
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(new_text, encoding='utf-8')
    _emit(f'set {key} in {config_path}')
    return 0


def _config_command(args: argparse.Namespace) -> int:
    config_path = Path(args.config).expanduser() if args.config else get_default_config_path()
    actions = {
        'path': lambda: _config_path(config_path),
        'init': lambda: _config_init(config_path),
        'show': lambda: _config_show(config_path),
        'list': lambda: _config_list(config_path),
        'get': lambda: _config_get(config_path, args.key),
        'set': lambda: _config_set(config_path, args.key, args.value),
    }
    return actions[args.action]()


def _requested_sources(args: argparse.Namespace) -> list[str]:
    if not args.source:
        return list(SOURCES)
    unknown = sorted(set(args.source) - set(SOURCES))
    if unknown:
        msg = f'unknown source(s) {unknown}; known sources are {list(SOURCES)}'
        raise ValueError(msg)
    return [name for name in SOURCES if name in set(args.source)]


def _refresh_linear(con: duckdb.DuckDBPyConnection, config: TlrConfig) -> int:
    from tlr.sources import linear  # noqa: PLC0415

    if not config.linear.team_keys:
        msg = 'no [linear].team_keys configured; nothing to refresh'
        raise ValueError(msg)
    client = linear.make_linear_client()
    rows = 0
    for team_key in config.linear.team_keys:
        result = linear.fetch_issues(client, issue_filter=linear.team_issue_filter(team_key))
        store.upsert_issues(con, result.issues, source='linear')
        store.upsert_issue_labels(con, result.labels, source='linear')
        store.upsert_issue_relations(con, result.relations, source='linear')
        store.upsert_cycles(con, linear.fetch_team_cycles(client, team_key))
        rows += result.issues.height
    return rows


def _refresh_pylon(con: duckdb.DuckDBPyConnection, config: TlrConfig) -> int:
    from tlr.sources import pylon  # noqa: PLC0415

    client = pylon.build_client()
    status_categories = pylon.parse_issue_statuses(pylon.fetch_issue_statuses(client))
    store.upsert_pylon_accounts(con, pylon.fetch_accounts(client, config.tiers), source='pylon')
    rows = 0
    end = datetime.now(UTC).replace(tzinfo=None)
    while True:
        start = end - timedelta(days=365)
        result = pylon.fetch_issues(
            client, config.pylon, start=start, end=end, status_categories=status_categories
        )
        store.upsert_pylon_issues(con, result.issues, source='pylon')
        store.upsert_pylon_issue_labels(con, result.labels, source='pylon')
        rows += result.issues.height
        if result.issues.is_empty():
            return rows
        end = start


def _refresh_sentry(con: duckdb.DuckDBPyConnection, config: TlrConfig) -> int:
    from tlr.sources import sentry  # noqa: PLC0415

    if not config.sentry.org_slug:
        msg = 'no [sentry].org_slug configured; nothing to refresh'
        raise ValueError(msg)
    client = sentry.build_client()
    issues = sentry.fetch_issues(client, config.sentry)
    store.upsert_sentry_issues(con, issues)
    return issues.height


def _refresh_command(args: argparse.Namespace, config: TlrConfig) -> int:
    sources = _requested_sources(args)
    if args.dry_run:
        _emit(_render(pl.DataFrame({'source': sources, 'action': ['would fetch'] * len(sources)}), 'md'))
        return 0
    con = _open_store(args, config)
    refreshers = {'linear': _refresh_linear, 'pylon': _refresh_pylon, 'sentry': _refresh_sentry}
    failures: list[str] = []
    try:
        for name in sources:
            try:
                row_count = refreshers[name](con, config)
            except KeyError as exc:
                _emit_error(f'{name}: failed (response missing key {exc})')
                failures.append(name)
                continue
            except (LookupError, ValueError) as exc:
                _emit_error(f'{name}: skipped ({exc})')
                failures.append(name)
                continue
            except Exception as exc:
                _emit_error(f'{name}: failed ({exc})')
                failures.append(name)
                continue
            now = datetime.now(UTC).replace(tzinfo=None)
            store.record_refresh(con, source=name, last_run_at=now, row_count=row_count)
            _emit(f'{name}: {row_count} row(s)')
    finally:
        con.close()
    return 1 if failures else 0


def _resolve_cycle(cycles: pl.DataFrame, requested: int | None) -> int | None:
    if requested is not None:
        return requested
    current = capacity_domain.current_cycle(cycles, datetime.now(UTC).replace(tzinfo=None))
    return current['number'].to_list()[0] if not current.is_empty() else None


def _capacity_command(args: argparse.Namespace, config: TlrConfig) -> int:
    con = _open_store(args, config)
    try:
        issues = store.get_issues(con)
        cycles = store.get_cycles(con)
    finally:
        con.close()

    cycle_number = _resolve_cycle(cycles, args.cycle)
    if cycle_number is not None:
        issues = issues.filter(pl.col('cycle_number') == cycle_number)

    roster = config.capacity.roster
    if args.person:
        wanted = set(args.person)
        roster = [person for person in roster if person.name in wanted]
    if not roster:
        _emit_error('no roster: add [[capacity.roster]] entries to your config file')
        return 1

    frame = capacity_domain.standup_capacity(
        issues,
        roster,
        pl.DataFrame(),
        working_days_per_cycle=config.capacity.working_days_per_cycle,
        working_hours_per_day=config.capacity.working_hours_per_day,
    )
    _emit(_render(frame, args.format))
    return 0


_TRIAGE_DISPLAY_NAMES = {
    'pylon_number': 'Pylon',
    'title': 'Title',
    'age_days': 'Age (days)',
    'priority': 'Priority',
    'tier': 'Tier',
    'linear_identifier': 'Linear',
    'linear_state': 'Linear state',
    'sla_days_remaining': 'SLA left (days)',
    'link': 'URL',
}


def _triage_command(args: argparse.Namespace, config: TlrConfig) -> int:
    from tlr.domain import triage as triage_domain  # noqa: PLC0415

    con = _open_store(args, config)
    try:
        result = triage_domain.build_triage_queue(
            store.get_pylon_issues(con),
            store.get_issues(con),
            store.get_pylon_issue_labels(con),
            store.get_pylon_accounts(con),
            now=_now(),
            triage=config.triage,
            tiers=config.tiers,
            sla=config.sla,
            pylon=config.pylon,
            linear=config.linear,
        )
    finally:
        con.close()

    def _display(frame: pl.DataFrame) -> pl.DataFrame:
        shown = frame.head(args.limit)
        if args.format == 'md':
            shown = shown.with_columns(
                pl.when(pl.col('link').is_not_null())
                .then(pl.format('[{}]({})', pl.col('pylon_number'), pl.col('link')))
                .otherwise(pl.col('pylon_number').cast(pl.Utf8))
                .alias('pylon_number'),
            ).drop('link')
        return shown.rename({k: v for k, v in _TRIAGE_DISPLAY_NAMES.items() if k in shown.columns})

    sections = [('Triage queue', _display(result.queue))]
    if args.include_excluded:
        sections.extend((heading, _display(frame)) for heading, frame in result.sections)
    _emit(_render_sections(sections, args.format))
    return 0


def _backlog_command(args: argparse.Namespace, config: TlrConfig) -> int:
    from tlr.domain import backlog as backlog_domain  # noqa: PLC0415

    con = _open_store(args, config)
    try:
        pylon_issues = store.get_pylon_issues(con)
    finally:
        con.close()

    sections = backlog_domain.backlog_health_sections(
        pylon_issues,
        config.thresholds,
        config.sla,
        config.triage.agent_assignee_ids,
        now=_now(),
    )
    _emit(_render_sections(sections, args.format))
    return 0


def _sentry_configured() -> bool:
    from tlr.secrets import read_secret  # noqa: PLC0415

    try:
        read_secret('sentry')
    except LookupError:
        return False
    return True


def _alarms_configured(config: TlrConfig) -> bool:
    return bool(config.alarms.command and config.alarms.profiles)


def _alarm_note(text: str) -> list[tuple[str, pl.DataFrame | str]]:
    return [('Alarms', pl.DataFrame({'note': [text]}))]


def _alarm_sections(
    config: TlrConfig,
    window: PeriodWindow,
    issues: pl.DataFrame,
    *,
    fetched_at: datetime,
    top_n: int,
    include_detail: bool,
) -> list[tuple[str, pl.DataFrame | str]]:
    from tlr.domain import alarms as alarms_domain  # noqa: PLC0415
    from tlr.sources import alarms as alarms_source  # noqa: PLC0415

    if not _alarms_configured(config):
        return _alarm_note('Alarms: not configured')
    try:
        fetched = alarms_source.fetch_alarms(config.alarms, start=window.previous_start, end=window.end)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or '').strip().splitlines()
        return _alarm_note(f'Alarms: fetch failed ({detail[-1] if detail else exc})')
    except (OSError, subprocess.SubprocessError) as exc:
        return _alarm_note(f'Alarms: fetch failed ({exc})')
    return alarms_domain.build_alarm_sections(
        fetched.alarms,
        fetched.transitions,
        issues,
        window=window,
        config=config.alarms,
        fetched_at=fetched_at,
        closed_like_state_names=config.linear.closed_like_state_names,
        top_n=top_n,
        include_detail=include_detail,
    )


def _alarms_command(args: argparse.Namespace, config: TlrConfig) -> int:
    from tlr.domain import snapshot as snapshot_domain  # noqa: PLC0415

    if not _alarms_configured(config):
        _emit_error('no [alarms].command and [alarms].profiles configured; nothing to fetch')
        return 1
    if args.env:
        unknown = sorted(set(args.env) - set(config.alarms.profiles))
        if unknown:
            _emit_error(f'unknown env(s) {unknown}; configured environments are {sorted(config.alarms.profiles)}')
            return 1
        config = replace(
            config,
            alarms=replace(
                config.alarms,
                profiles={key: value for key, value in config.alarms.profiles.items() if key in args.env},
            ),
        )

    now = _now()
    window = snapshot_domain.PeriodWindow(
        start=now - timedelta(days=args.days),
        end=now,
        previous_start=now - timedelta(days=2 * args.days),
        previous_end=now - timedelta(days=args.days),
    )

    con = _open_store(args, config)
    try:
        issues = store.get_issues(con)
        refreshes = store.get_refresh_status(con)
    finally:
        con.close()

    sections = [
        (
            'Data freshness',
            pl.DataFrame({'note': [snapshot_domain.freshness_line(refreshes, sources=('linear',), now=now)]}),
        ),
        *_alarm_sections(
            config,
            window,
            issues,
            fetched_at=now,
            top_n=args.top,
            include_detail=True,
        ),
    ]
    _emit(_render_sections(sections, args.format))
    return 0


def _snapshot_command(args: argparse.Namespace, config: TlrConfig) -> int:
    from tlr.domain import snapshot as snapshot_domain  # noqa: PLC0415

    as_of = datetime.fromisoformat(args.as_of) if args.as_of else _now()
    window = snapshot_domain.period_window(args.period, as_of)

    con = _open_store(args, config)
    try:
        issues = store.get_issues(con)
        issue_labels = store.get_issue_labels(con)
        pylon_issues = store.get_pylon_issues(con)
        pylon_issue_labels = store.get_pylon_issue_labels(con)
        sentry_issues = store.get_sentry_issues(con)
        refreshes = store.get_refresh_status(con)
    finally:
        con.close()

    sections: list[tuple[str, pl.DataFrame | str]] = snapshot_domain.build_snapshot_sections(
        issues,
        issue_labels,
        pylon_issues,
        pylon_issue_labels,
        sentry_issues,
        window=window,
        pylon_priority_values=config.pylon.priority_values,
        sla=config.sla,
        sentry_configured=_sentry_configured(),
        period=args.period,
        closed_like_state_names=config.linear.closed_like_state_names,
        bot_label=config.linear.bot_label,
        refreshes=refreshes,
        tracked_sources=SOURCES,
        now=_now(),
    )
    alarm_sections = _alarm_sections(
        config,
        window,
        issues,
        fetched_at=_now(),
        top_n=10,
        include_detail=False,
    )
    insert_at = next(
        (idx for idx, (title, _frame) in enumerate(sections) if title.startswith('Notable:')),
        len(sections),
    )
    sections[insert_at:insert_at] = alarm_sections
    _emit(_render_sections(sections, args.format))
    return 0


def _import_snapshots_command(args: argparse.Namespace, config: TlrConfig) -> int:
    from tlr.imports import snapshots  # noqa: PLC0415

    sqlite_path = Path(args.sqlite_path).expanduser()
    if args.dry_run:
        summary = snapshots.import_snapshots(sqlite_path, lambda _frame: None)
        _emit(
            f'would import {summary.rows_written} row(s) from {summary.snapshots_read} snapshot(s); '
            f'{summary.rows_dropped_no_milestone} issue(s) carry no milestone',
        )
        return 0

    con = _open_store(args, config)
    try:
        if not store.get_milestone_scope(con).is_empty():
            _emit_error('milestone_scope already holds rows; this import runs once against an empty table')
            return 1
        summary = snapshots.import_snapshots(sqlite_path, lambda frame: store.capture_milestone_scope(con, frame))
        store.record_refresh(
            con,
            source='deno-snapshots',
            last_run_at=_now(),
            row_count=summary.rows_written,
            note=f'{summary.snapshots_read} snapshot(s)',
        )
    finally:
        con.close()
    _emit(f'imported {summary.rows_written} row(s) from {summary.snapshots_read} snapshot(s)')
    return 0


_COMMANDS = {
    'alarms': _alarms_command,
    'backlog': _backlog_command,
    'capacity': _capacity_command,
    'import-snapshots': _import_snapshots_command,
    'refresh': _refresh_command,
    'snapshot': _snapshot_command,
    'triage': _triage_command,
}


def run(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    """Dispatch one parsed command, returning the process exit status."""
    if args.command == 'config':
        return _config_command(args)
    handler = _COMMANDS.get(args.command)
    if handler is None:
        parser.print_help()
        return 2
    return handler(args, load_config(Path(args.config).expanduser() if args.config else None))
