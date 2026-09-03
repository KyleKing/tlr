"""Tests for tlr.sources.pylon."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from tlr import store
from tlr.config import PylonConfig
from tlr.http import SlidingWindowLimiter
from tlr.sources import pylon
from tlr.store import LINK_STATUS_LINKED, LINK_STATUS_NO_LINK, LINK_STATUS_UNKNOWN

_CONTACT_UUID = '11111111-2222-3333-4444-555555555555'
_EXPECTED_PAGE_COUNT = 2
_SEARCHES_OVER_THE_LIMIT = 21


def _issue_record(**overrides: Any) -> dict[str, Any]:
    record = {
        'id': 'issue-1',
        'number': 100,
        'title': 'Widget stopped working',
        'body_html': '<p>First line</p><p>Second line</p>',
        'created_at': '2026-01-01T12:00:00Z',
        'link': 'https://app.usepylon.com/issues/issue-1',
        'requester': {'id': _CONTACT_UUID, 'email': 'requester@example.test'},
        'custom_fields': {'linear_ticket': 'DEV-1234'},
    }
    record.update(overrides)
    return record


def _page(records: list[dict[str, Any]], *, cursor: str | None = None) -> dict[str, Any]:
    return {'data': records, 'pagination': {'cursor': cursor}, 'request_id': 'req-1'}


def test_build_client_uses_injected_dependencies_without_reading_a_secret() -> None:
    http_client = httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(200, json={})))
    limiter = SlidingWindowLimiter(max_calls=1, clock=lambda: 0.0, sleep=lambda _s: None)

    client = pylon.build_client(http_client=http_client, token='injected', limiter=limiter)  # noqa: S106

    assert client.http_client is http_client
    assert client.limiter is limiter
    assert client.token == 'injected'  # ruff:ignore[hardcoded-password-string]


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> pylon.PylonClient:
    now = [0.0]
    http_client = httpx.Client(transport=httpx.MockTransport(handler), base_url=pylon.BASE_URL)
    limiter = SlidingWindowLimiter(
        max_calls=20, clock=lambda: now[0], sleep=lambda seconds: now.__setitem__(0, now[0] + seconds)
    )
    return pylon.PylonClient(http_client=http_client, token='test-token', limiter=limiter)  # noqa: S106


def test_fetch_issue_by_linear_ticket_paginates() -> None:
    config = PylonConfig()
    pages = [
        _page([_issue_record(id='issue-1')], cursor='page-2'),
        _page([_issue_record(id='issue-2')], cursor=None),
    ]
    calls: list[dict[str, Any]] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        return httpx.Response(200, json=pages[len(calls) - 1])

    client = _client(_handle)
    result = pylon.fetch_issue_by_linear_ticket(client, config, 'DEV-1234')

    assert result['id'].to_list() == ['issue-1', 'issue-2']
    assert len(calls) == _EXPECTED_PAGE_COUNT
    assert 'cursor' not in calls[0]
    assert calls[1]['cursor'] == 'page-2'


def test_error_response_raises() -> None:
    config = PylonConfig()

    def _handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={'error': 'bad filter'})

    client = _client(_handle)
    with pytest.raises(httpx.HTTPStatusError):
        pylon.fetch_issue_by_linear_ticket(client, config, 'DEV-1234')


def test_rate_limiter_throttles_the_21st_search_in_a_window() -> None:
    config = PylonConfig()
    call_count = 0

    def _handle(_request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json=_page([]))

    now = [0.0]
    sleeps: list[float] = []

    def _sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    limiter = SlidingWindowLimiter(max_calls=20, clock=lambda: now[0], sleep=_sleep)
    http_client = httpx.Client(transport=httpx.MockTransport(_handle), base_url=pylon.BASE_URL)
    client = pylon.PylonClient(http_client=http_client, token='test-token', limiter=limiter)  # noqa: S106

    for _ in range(_SEARCHES_OVER_THE_LIMIT):
        pylon.fetch_issue_by_linear_ticket(client, config, 'DEV-1234')

    assert call_count == _SEARCHES_OVER_THE_LIMIT
    assert sleeps == [60.0]


@pytest.mark.parametrize(
    ('custom_fields', 'expected_status', 'expected_identifier'),
    [
        ({'linear_ticket': 'DEV-42'}, LINK_STATUS_LINKED, 'DEV-42'),
        ({'linear_ticket': None}, LINK_STATUS_NO_LINK, None),
        ({'linear_ticket': ''}, LINK_STATUS_NO_LINK, None),
        ({}, LINK_STATUS_UNKNOWN, None),
    ],
)
def test_link_status_resolution(
    custom_fields: dict[str, Any],
    expected_status: str,
    expected_identifier: str | None,
) -> None:
    config = PylonConfig()
    body = _page([_issue_record(custom_fields=custom_fields)])

    result = pylon.parse_issues(body, config)

    assert result['link_status'].to_list() == [expected_status]
    assert result['linear_identifier'].to_list() == [expected_identifier]


def test_parse_issues_produces_store_shaped_columns() -> None:
    config = PylonConfig()
    body = _page([_issue_record()])

    result = pylon.parse_issues(body, config)

    assert set(result.columns) == {'id', *store._PYLON_DOMAIN_COLS}  # noqa: SLF001
    assert result['body'].to_list() == ['First line\nSecond line']
    assert result['created_at'].to_list() == [datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC).replace(tzinfo=None)]
    assert result['requester_email'].to_list() == ['requester@example.test']


def test_build_linear_ticket_filter_uses_configured_field_name() -> None:
    config = PylonConfig(linear_ticket_field='tracker_ref')

    result = pylon.build_linear_ticket_filter(config, 'DEV-9')

    assert result == {'field': 'tracker_ref', 'operator': 'equals', 'value': 'DEV-9'}


def test_fetch_issues_in_window_carries_search_text() -> None:
    config = PylonConfig()
    captured: dict[str, Any] = {}

    def _handle(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json=_page([]))

    client = _client(_handle)
    pylon.fetch_issues_in_window(client, config, start='2026-01-01', end='2026-02-01', search_text='billing')

    assert captured['search_text'] == 'billing'
    assert captured['filter']['field'] == 'created_at'


def test_upsert_pylon_issues_accepts_fetch_output_unchanged(tmp_path: Path) -> None:
    config = PylonConfig()
    body = _page([_issue_record()])
    df = pylon.parse_issues(body, config)

    con = store.connect(tmp_path / 'tlr.duckdb')
    store.upsert_pylon_issues(con, df)
    result = store.get_pylon_issues(con)

    assert result['id'].to_list() == ['issue-1']
    con.close()
