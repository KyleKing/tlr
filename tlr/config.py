"""Configuration loading and defaults for tlr.

Every workspace-specific value lives in a config file outside the repo, sampled at
`config.sample.toml`. Each dataclass here maps onto one TOML table.
"""

from __future__ import annotations

import os
import tomllib
import types
from dataclasses import dataclass, field, fields, replace
from pathlib import Path
from typing import Any, Final, get_args, get_origin, get_type_hints

from platformdirs import user_config_dir, user_data_dir

DEFAULT_CONFIG_FILENAME: Final = 'config.toml'
DEFAULT_DB_FILENAME: Final = 'tlr.duckdb'


@dataclass(slots=True)
class LinearConfig:
    """Which Linear workspace, teams, and accounts tlr reads."""

    team_keys: list[str] = field(default_factory=list)
    project_names: list[str] = field(default_factory=list)
    workspace_url_key: str = ''
    agent_accounts: list[str] = field(default_factory=list)
    estimate_scale: list[float] = field(default_factory=lambda: [0, 1, 2, 3, 5, 8, 13])


@dataclass(slots=True)
class PylonConfig:
    """Which Pylon custom fields carry triage-relevant state, and how their values rank."""

    linear_ticket_field: str = 'linear_ticket'
    priority_field: str = 'priority'
    priority_values: list[str] = field(default_factory=lambda: ['urgent', 'high', 'medium', 'low'])
    """Most to least urgent. Pylon's own `priority` select ships these four options."""
    question_type_field: str = 'question_type'


@dataclass(slots=True)
class SentryConfig:
    """Which Sentry organization and projects tlr reads. The auth token comes from the secret store."""

    org_slug: str = ''
    project_slugs: list[str] = field(default_factory=list)


@dataclass(slots=True)
class TiersConfig:
    """Customer tier names, best first, and which Pylon account field carries one.

    No Pylon workspace is required to have a tier field. An empty `account_tier_field`
    leaves every account on `default_tier`, which makes the tier ordering step a no-op.
    """

    names: list[str] = field(default_factory=list)
    account_tier_field: str = ''
    default_tier: str = ''


@dataclass(slots=True)
class SlaConfig:
    """Target close time per priority, and optionally per tier."""

    target_days_by_priority: dict[str, int] = field(default_factory=dict)
    target_days_by_tier: dict[str, int] = field(default_factory=dict)


@dataclass(slots=True)
class TriageConfig:
    """Ordering rules applied in sequence, and the heading each held-out row is listed under."""

    ordering: list[str] = field(default_factory=lambda: ['priority', 'tier', 'age', 'sla_distance'])
    exclusions: dict[str, list[str]] = field(default_factory=dict)
    """Heading to the Pylon tags and question types that move a row under it."""
    agent_assignee_ids: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ThresholdsConfig:
    """Backlog age buckets and the commitment accuracy band."""

    backlog_age_days: list[int] = field(default_factory=lambda: [30, 60, 90])
    in_progress_days: int = 14
    commitment_accuracy_low: float = 0.8
    commitment_accuracy_high: float = 0.9


@dataclass(slots=True)
class Person:
    """One roster entry: a name, an email, and points per cycle."""

    name: str
    email: str
    points_per_cycle: float


@dataclass(slots=True)
class CapacityConfig:
    """The roster, on-call and calendar ids, and the meeting-hours rule."""

    roster: list[Person] = field(default_factory=list)
    on_call_schedule_ids: list[str] = field(default_factory=list)
    calendar_ids: list[str] = field(default_factory=list)
    meeting_hours_rule: str = 'accepted_from_others'
    working_days_per_cycle: float = 10.0
    working_hours_per_day: float = 8.0


@dataclass(slots=True)
class StoreConfig:
    """Where the DuckDB file lives. `None` resolves under `get_data_dir` at load time."""

    database_path: Path | None = None


@dataclass(slots=True)
class TlrConfig:
    """Container for every configuration section, one per TOML table."""

    linear: LinearConfig = field(default_factory=LinearConfig)
    pylon: PylonConfig = field(default_factory=PylonConfig)
    sentry: SentryConfig = field(default_factory=SentryConfig)
    tiers: TiersConfig = field(default_factory=TiersConfig)
    sla: SlaConfig = field(default_factory=SlaConfig)
    triage: TriageConfig = field(default_factory=TriageConfig)
    thresholds: ThresholdsConfig = field(default_factory=ThresholdsConfig)
    capacity: CapacityConfig = field(default_factory=CapacityConfig)
    store: StoreConfig = field(default_factory=StoreConfig)


_SECTIONS: Final[dict[str, type[Any]]] = {
    'linear': LinearConfig,
    'pylon': PylonConfig,
    'sentry': SentryConfig,
    'tiers': TiersConfig,
    'sla': SlaConfig,
    'triage': TriageConfig,
    'thresholds': ThresholdsConfig,
}
"""TOML section name to its dataclass, for every section that needs no bespoke parsing."""


def get_default_config_path() -> Path:
    """Return `$TLR_CONFIG`, else `config.toml` under the XDG config directory."""
    if env_path := os.environ.get('TLR_CONFIG'):
        return Path(env_path).expanduser()
    return Path(user_config_dir('tlr')) / DEFAULT_CONFIG_FILENAME


def get_data_dir() -> Path:
    """Return `$TLR_DATA_DIR`, else the XDG data directory."""
    if env_path := os.environ.get('TLR_DATA_DIR'):
        return Path(env_path).expanduser()
    return Path(user_data_dir('tlr'))


def _check_scalar(value: Any, expected: Any) -> bool:
    if expected is float:
        return isinstance(value, int | float) and not isinstance(value, bool)
    if expected is int:
        return isinstance(value, int) and not isinstance(value, bool)
    if expected is Path:
        return isinstance(value, str | Path)
    return isinstance(value, expected)


def _check_type(value: Any, expected: Any) -> bool:
    origin = get_origin(expected)
    if origin is None:
        return _check_scalar(value, expected)
    if origin is list:
        (item_type,) = get_args(expected)
        return isinstance(value, list) and all(_check_type(item, item_type) for item in value)
    if origin is dict:
        key_type, value_type = get_args(expected)
        return isinstance(value, dict) and all(
            _check_type(k, key_type) and _check_type(v, value_type) for k, v in value.items()
        )
    if origin is types.UnionType:
        return any(_check_type(value, arg) for arg in get_args(expected))
    return True


def _coerce_scalar(value: Any, expected: Any) -> Any:
    if expected is float and isinstance(value, int):
        return float(value)
    if expected is Path and isinstance(value, str):
        return Path(value)
    return value


def _coerce_type(value: Any, expected: Any) -> Any:
    """Cast a TOML-native value (e.g. an int) into the type its field declares (e.g. float)."""
    origin = get_origin(expected)
    if origin is None:
        return _coerce_scalar(value, expected)
    if origin is list:
        (item_type,) = get_args(expected)
        return [_coerce_type(item, item_type) for item in value]
    if origin is dict:
        key_type, value_type = get_args(expected)
        return {_coerce_type(k, key_type): _coerce_type(v, value_type) for k, v in value.items()}
    if origin is types.UnionType:
        matching = next(arg for arg in get_args(expected) if _check_type(value, arg))
        return _coerce_type(value, matching)
    return value


def _validated_section(table_name: str, raw: Any, factory: type[Any]) -> Any:
    if raw is None:
        return factory()
    if not isinstance(raw, dict):
        msg = f'[{table_name}] must be a table'
        raise ValueError(msg)  # noqa: TRY004
    hints = get_type_hints(factory)
    allowed = {f.name for f in fields(factory)}
    kwargs: dict[str, Any] = {}
    for key, value in raw.items():
        if key not in allowed:
            msg = f'[{table_name}].{key} is not a recognized key; expected one of {sorted(allowed)}'
            raise ValueError(msg)
        expected = hints[key]
        if not _check_type(value, expected):
            msg = f'[{table_name}].{key} must be {expected}, got {value!r}'
            raise ValueError(msg)
        kwargs[key] = _coerce_type(value, expected)
    return factory(**kwargs)


def _load_roster(raw: Any) -> list[Person]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        msg = '[capacity].roster must be a list of tables'
        raise ValueError(msg)  # noqa: TRY004
    roster: list[Person] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            msg = f'[capacity].roster[{index}] must be a table'
            raise ValueError(msg)  # noqa: TRY004
        try:
            name, email, points_per_cycle = entry['name'], entry['email'], entry['points_per_cycle']
        except KeyError as exc:
            msg = f'[capacity].roster[{index}] is missing key {exc}'
            raise ValueError(msg) from exc
        valid_points = isinstance(points_per_cycle, int | float) and not isinstance(points_per_cycle, bool)
        if not isinstance(name, str) or not isinstance(email, str) or not valid_points:
            msg = f'[capacity].roster[{index}] has an invalid field type'
            raise ValueError(msg)
        roster.append(Person(name=name, email=email, points_per_cycle=float(points_per_cycle)))
    return roster


def _load_capacity(raw: Any) -> CapacityConfig:
    if raw is not None and not isinstance(raw, dict):
        msg = '[capacity] must be a table'
        raise ValueError(msg)
    roster = _load_roster(raw.get('roster') if raw else None)
    rest = {key: value for key, value in raw.items() if key != 'roster'} if raw else {}
    return replace(_validated_section('capacity', rest, CapacityConfig), roster=roster)


def load_config(path: Path | None = None) -> TlrConfig:
    """Load configuration from `path`, defaulting to `get_default_config_path`.

    An absent file yields the dataclass defaults. Malformed TOML, an unknown key, or a
    key whose value has the wrong shape raises `ValueError` naming the table and key.
    """
    config_path = path or get_default_config_path()
    if not config_path.exists():
        config = TlrConfig()
    else:
        try:
            with config_path.open('rb') as handle:
                data = tomllib.load(handle)
        except tomllib.TOMLDecodeError as exc:
            msg = f'Invalid TOML in {config_path}: {exc}'
            raise ValueError(msg) from exc

        config = TlrConfig(
            **{name: _validated_section(name, data.get(name), factory) for name, factory in _SECTIONS.items()},
            capacity=_load_capacity(data.get('capacity')),
            store=_validated_section('store', data.get('store'), StoreConfig),
        )

    stored = config.store.database_path
    resolved = get_data_dir() / DEFAULT_DB_FILENAME if stored is None else stored.expanduser()
    return replace(config, store=replace(config.store, database_path=resolved))
