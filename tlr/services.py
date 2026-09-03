"""Wire parsed arguments to config, the store, the domain, and a renderer."""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

import duckdb
import polars as pl

from tlr import store
from tlr.config import TlrConfig, get_default_config_path, load_config
from tlr.domain import capacity as capacity_domain
from tlr.render.json import frame_to_json
from tlr.render.markdown import frame_to_markdown

SOURCES = ('linear', 'pylon')

_SAMPLE_CONFIG = Path(__file__).resolve().parent.parent / 'config.sample.toml'


def _emit(text: str) -> None:
    print(text)  # noqa: T201


def _emit_error(text: str) -> None:
    print(text, file=sys.stderr)  # noqa: T201


def _render(frame: pl.DataFrame, output_format: str) -> str:
    return frame_to_markdown(frame) if output_format == 'md' else frame_to_json(frame)


def _open_store(args: argparse.Namespace, config: TlrConfig) -> duckdb.DuckDBPyConnection:
    db_path = Path(args.db).expanduser() if args.db else config.store.database_path
    if db_path is None:
        msg = 'no database path: set [store].database_path or pass --db'
        raise ValueError(msg)
    return store.connect(db_path)


def _config_command(args: argparse.Namespace) -> int:
    config_path = Path(args.config).expanduser() if args.config else get_default_config_path()
    if args.action == 'path':
        _emit(str(config_path))
        return 0
    if args.action == 'init':
        if config_path.exists():
            _emit_error(f'{config_path} already exists; edit it in place')
            return 1
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(_SAMPLE_CONFIG.read_text(encoding='utf-8'), encoding='utf-8')
        _emit(f'wrote {config_path}')
        return 0
    load_config(config_path)
    _emit(config_path.read_text(encoding='utf-8') if config_path.exists() else '# no config file; using defaults')
    return 0


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

    issues = store.get_issues(con)
    if issues.is_empty():
        msg = 'refresh linear before pylon: the Pylon lookup keys on Linear issue identifiers'
        raise ValueError(msg)
    client = pylon.build_client()
    rows = 0
    for identifier in issues['identifier'].to_list():
        frame = pylon.fetch_issue_by_linear_ticket(client, config.pylon, identifier)
        store.upsert_pylon_issues(con, frame, source='pylon')
        rows += frame.height
    return rows


def _refresh_command(args: argparse.Namespace, config: TlrConfig) -> int:
    sources = _requested_sources(args)
    if args.dry_run:
        _emit(_render(pl.DataFrame({'source': sources, 'action': ['would fetch'] * len(sources)}), 'md'))
        return 0
    con = _open_store(args, config)
    refreshers = {'linear': _refresh_linear, 'pylon': _refresh_pylon}
    try:
        for name in sources:
            row_count = refreshers[name](con, config)
            now = datetime.now(UTC).replace(tzinfo=None)
            store.record_refresh(con, source=name, last_run_at=now, row_count=row_count)
            _emit(f'{name}: {row_count} row(s)')
    finally:
        con.close()
    return 0


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


_UNBUILT = {
    'triage': 'phase 2 builds the triage queue',
    'backlog': 'phase 2 builds the backlog health metrics',
    'import-snapshots': 'phase 2 builds the one-time Deno snapshot import',
}


def run(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    """Dispatch one parsed command, returning the process exit status."""
    if args.command == 'config':
        return _config_command(args)
    if reason := _UNBUILT.get(args.command):
        parser.exit(status=2, message=f'{args.command}: not built yet ({reason})\n')

    config = load_config(Path(args.config).expanduser() if args.config else None)
    if args.command == 'refresh':
        return _refresh_command(args, config)
    return _capacity_command(args, config)
