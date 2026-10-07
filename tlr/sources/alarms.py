"""CloudWatch alarms read through an external NDJSON exporter.

tlr does not speak to AWS itself: `[alarms].command` names the argv prefix of an
exporter such as tail-cw's `export alarms --history`, and this module appends
`--profile`, `--history`, `--start`, and `--end` and parses one JSON object per alarm
from stdout. Parsing is split from the subprocess so tests exercise it without a
child process or an AWS account.
"""

from __future__ import annotations

import json
import re
import subprocess  # noqa: S404 the argv comes from config, never a shell string
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import polars as pl

from tlr.config import AlarmsConfig
from tlr.sources.sentry import _parse_datetime

FETCH_TIMEOUT_SECONDS = 300

ALARMS_SCHEMA: dict[str, Any] = {
    'env': pl.Utf8,
    'name': pl.Utf8,
    'state': pl.Utf8,
    'state_updated': pl.Datetime('us'),
    'namespace': pl.Utf8,
    'metric_name': pl.Utf8,
}

TRANSITIONS_SCHEMA: dict[str, Any] = {
    'env': pl.Utf8,
    'alarm_name': pl.Utf8,
    'occurred_at': pl.Datetime('us'),
    'from_state': pl.Utf8,
    'to_state': pl.Utf8,
}

_TRANSITION_RE = re.compile(r'from (\w+) to (\w+)')


@dataclass(frozen=True)
class AlarmFetch:
    """One exporter run's output: the alarm list plus every state transition in the window."""

    alarms: pl.DataFrame
    transitions: pl.DataFrame


def export_argv(command: Sequence[str], *, profile: str, start: datetime, end: datetime | None = None) -> list[str]:
    """Assemble the exporter invocation: `command`, then the profile and history window."""
    argv = [str(Path(part).expanduser()) for part in command]
    argv += ['--profile', profile, '--history', '--start', start.isoformat()]
    if end is not None:
        argv += ['--end', end.isoformat()]
    return argv


def _run_export(argv: Sequence[str]) -> str:
    completed = subprocess.run(  # noqa: S603 argv is a list, no shell
        list(argv),
        capture_output=True,
        text=True,
        timeout=FETCH_TIMEOUT_SECONDS,
        check=True,
    )
    return completed.stdout


def parse_export(text: str, *, env: str) -> AlarmFetch:
    """Parse exporter NDJSON: one alarm per line, transitions nested under `history`."""
    alarm_rows: list[dict[str, Any]] = []
    transition_rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        name = record['name']
        alarm_rows.append(
            {
                'env': env,
                'name': name,
                'state': record.get('state'),
                'state_updated': _parse_datetime(record.get('state_updated')),
                'namespace': record.get('namespace'),
                'metric_name': record.get('metric_name'),
            },
        )
        for item in record.get('history') or []:
            match = _TRANSITION_RE.search(item.get('summary', ''))
            transition_rows.append(
                {
                    'env': env,
                    'alarm_name': name,
                    'occurred_at': _parse_datetime(item.get('moment')),
                    'from_state': match.group(1) if match else None,
                    'to_state': match.group(2) if match else None,
                },
            )
    return AlarmFetch(
        alarms=pl.DataFrame(alarm_rows, schema=ALARMS_SCHEMA) if alarm_rows else pl.DataFrame(schema=ALARMS_SCHEMA),
        transitions=(
            pl.DataFrame(transition_rows, schema=TRANSITIONS_SCHEMA)
            if transition_rows
            else pl.DataFrame(schema=TRANSITIONS_SCHEMA)
        ),
    )


def fetch_alarms(
    config: AlarmsConfig,
    *,
    start: datetime,
    end: datetime | None = None,
    runner: Any = _run_export,
) -> AlarmFetch:
    """Run the exporter once per configured profile and concatenate the env-tagged results."""
    alarms_frames: list[pl.DataFrame] = []
    transition_frames: list[pl.DataFrame] = []
    for env, profile in config.profiles.items():
        stdout = runner(export_argv(config.command, profile=profile, start=start, end=end))
        parsed = parse_export(stdout, env=env)
        alarms_frames.append(parsed.alarms)
        transition_frames.append(parsed.transitions)
    return AlarmFetch(
        alarms=pl.concat(alarms_frames) if alarms_frames else pl.DataFrame(schema=ALARMS_SCHEMA),
        transitions=pl.concat(transition_frames) if transition_frames else pl.DataFrame(schema=TRANSITIONS_SCHEMA),
    )
