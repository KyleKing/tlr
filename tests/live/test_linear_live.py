"""Linear adapter tests replaying recorded responses (see docs/cassettes.md)."""

from __future__ import annotations

import httpx
import pytest

from tlr.sources import linear

from .conftest import secret_or_placeholder

TEAM_KEY = 'DEV'


def _client() -> linear.LinearClient:
    return linear.LinearClient(http=httpx.Client(), api_key=secret_or_placeholder('linear'))


def _no_sleep(_seconds: float) -> None:
    return None


@pytest.mark.vcr
def test_fetch_team_cycles() -> None:
    frame = linear.fetch_team_cycles(_client(), TEAM_KEY, sleep=_no_sleep)

    assert frame.height > 0
    assert frame.columns == ['team_key', 'number', 'starts_at', 'ends_at']


@pytest.mark.vcr
def test_fetch_projects() -> None:
    frame = linear.fetch_projects(_client(), project_filter={}, sleep=_no_sleep)

    assert frame.height > 0
    assert frame.columns == [
        'project_id',
        'project_name',
        'project_url',
        'slug_id',
        'start_date',
        'target_date',
        'team_keys',
        'milestone_id',
        'milestone_name',
        'milestone_target_date',
        'milestone_progress',
    ]
