"""Tests for tlr.config."""

from pathlib import Path

import pytest

from tlr.config import (
    Person,
    get_data_dir,
    get_default_config_path,
    load_config,
)

SAMPLE_PATH = Path(__file__).resolve().parent.parent / 'config.sample.toml'


def test_load_config_absent_file_returns_defaults(tmp_path: Path) -> None:
    """A missing config file yields dataclass defaults, not an error."""
    config = load_config(tmp_path / 'does-not-exist.toml')

    assert config.linear.team_keys == []
    assert config.pylon.linear_ticket_field == 'linear_ticket'
    assert config.tiers.names == ['enterprise', 'standard', 'free']
    assert config.sla.target_days_by_priority == {'urgent': 1, 'high': 3, 'normal': 5, 'low': 10}
    assert config.triage.ordering == ['priority', 'tier', 'age', 'sla_distance']
    assert config.thresholds.backlog_age_days == [30, 60, 90]
    assert config.capacity.roster == []
    assert config.store.database_path == get_data_dir() / 'tlr.duckdb'


def test_load_config_sample_round_trips() -> None:
    """config.sample.toml parses and matches what its comments describe."""
    config = load_config(SAMPLE_PATH)

    assert config.linear.team_keys == ['ENG']
    assert config.linear.agent_accounts == ['watch-doggo@example.com']
    assert config.pylon.priority_values == ['urgent', 'high', 'normal', 'low']
    assert config.tiers.default_tier == 'free'
    assert config.sla.target_days_by_tier == {}
    assert config.triage.exclusions['feature_request'] == ['feature-request']
    assert config.thresholds.commitment_accuracy_low == pytest.approx(0.8)
    assert config.capacity.roster == [
        Person(name='Alex Doe', email='alex@example.com', points_per_cycle=10.0),
        Person(name='Sam Roe', email='sam@example.com', points_per_cycle=8.0),
    ]
    assert config.capacity.on_call_schedule_ids == ['schedule-primary']
    assert config.store.database_path == get_data_dir() / 'tlr.duckdb'


def test_load_config_malformed_toml_raises(tmp_path: Path) -> None:
    """Invalid TOML raises ValueError naming the file."""
    bad = tmp_path / 'config.toml'
    bad.write_text('not valid toml [[[')

    with pytest.raises(ValueError, match='Invalid TOML'):
        load_config(bad)


@pytest.mark.parametrize(
    ('toml_body', 'match'),
    [
        ('[linear]\nteam_keys = "ENG"\n', r'\[linear\].team_keys'),
        ('[thresholds]\nin_progress_days = "soon"\n', r'\[thresholds\].in_progress_days'),
        ('[sla]\n[sla.target_days_by_priority]\nurgent = "one"\n', r'\[sla\].target_days_by_priority'),
        ('[capacity]\n[[capacity.roster]]\nname = "Alex"\n', r'roster\[0\]'),
        (
            '[capacity]\n[[capacity.roster]]\nname = "Alex"\nemail = "a@x.com"\npoints_per_cycle = "ten"\n',
            r'roster\[0\]',
        ),
        ('linear = 5\n', r'\[linear\]'),
        ('[linear]\nteam_key = ["ENG"]\n', r'\[linear\].team_key is not a recognized key'),
    ],
)
def test_load_config_malformed_section_raises(tmp_path: Path, toml_body: str, match: str) -> None:
    """A table or key with the wrong shape, or an unrecognized key, raises ValueError naming it."""
    bad = tmp_path / 'config.toml'
    bad.write_text(toml_body)

    with pytest.raises(ValueError, match=match):
        load_config(bad)


def test_get_default_config_path_honors_env_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """TLR_CONFIG overrides the platform default config path."""
    override = tmp_path / 'custom-config.toml'
    monkeypatch.setenv('TLR_CONFIG', str(override))

    assert get_default_config_path() == override


def test_get_data_dir_honors_env_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """TLR_DATA_DIR overrides the platform default data directory."""
    monkeypatch.setenv('TLR_DATA_DIR', str(tmp_path))

    assert get_data_dir() == tmp_path
