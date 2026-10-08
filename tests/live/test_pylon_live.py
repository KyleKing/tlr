"""Pylon adapter tests replaying recorded responses (see docs/cassettes.md)."""

from __future__ import annotations

import httpx
import pytest

from tlr.config import PylonConfig, TiersConfig
from tlr.http import SlidingWindowLimiter
from tlr.sources import pylon

from .conftest import secret_or_placeholder

_KNOWN_CATEGORIES = {'new', 'waiting_on_you', 'waiting_on_customer', 'on_hold', 'closed'}


def _client() -> pylon.PylonClient:
    return pylon.PylonClient(
        http_client=httpx.Client(base_url=pylon.BASE_URL),
        token=secret_or_placeholder('pylon'),
        limiter=SlidingWindowLimiter(max_calls=pylon.SEARCH_RATE_LIMIT_PER_MINUTE),
    )


@pytest.mark.vcr
def test_fetch_issue_statuses() -> None:
    categories = pylon.parse_issue_statuses(pylon.fetch_issue_statuses(_client()))

    assert categories
    assert set(categories.values()) <= _KNOWN_CATEGORIES


@pytest.mark.vcr
def test_fetch_accounts() -> None:
    frame = pylon.fetch_accounts(_client(), TiersConfig())

    assert frame.height > 0
    assert frame.columns == ['id', 'name', 'tier']


@pytest.mark.vcr
def test_fetch_issues_in_window_paginates() -> None:
    result = pylon.fetch_issues_in_window(
        _client(),
        PylonConfig(),
        start='2026-09-01T00:00:00Z',
        end='2026-09-15T00:00:00Z',
    )

    assert result.issues.height > pylon.PAGE_LIMIT
