"""Tests for tlr.sources.sentry."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

import httpx
import pytest

from tlr.config import SentryConfig
from tlr.sources import sentry


def _issue_record(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        'id': '1',
        'title': 'NPE in handler',
        'culprit': 'handler.process',
        'level': 'error',
        'status': 'unresolved',
        'count': '42',
        'firstSeen': '2026-01-01T00:00:00Z',
        'lastSeen': '2026-01-02T00:00:00Z',
        'permalink': 'https://sentry.test/issues/1',
        'project': {'id': '10', 'slug': 'backend'},
    }
    record.update(overrides)
    return record


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> sentry.SentryClient:
    http_client = httpx.Client(transport=httpx.MockTransport(handler), base_url=sentry.BASE_URL)
    return sentry.SentryClient(http_client=http_client, token='test-token')  # noqa: S106


def test_build_client_uses_injected_dependencies_without_reading_a_secret() -> None:
    http_client = httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(200, json=[])))

    client = sentry.build_client(http_client=http_client, token='injected')  # noqa: S106

    assert client.http_client is http_client
    assert client.token == 'injected'  # ruff:ignore[hardcoded-password-string]


def test_parse_issues_produces_store_shaped_columns() -> None:
    df = sentry.parse_issues([_issue_record()])

    row = df.row(0, named=True)
    assert row['id'] == '1'
    assert row['project_slug'] == 'backend'
    assert row['times_seen'] == 42  # noqa: PLR2004
    assert row['first_seen'] == datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)


def test_parse_issues_on_an_empty_page_returns_an_empty_frame() -> None:
    assert sentry.parse_issues([]).is_empty()


def test_fetch_issues_sends_bearer_token_and_configured_query() -> None:
    seen: list[httpx.Request] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[_issue_record()])

    config = SentryConfig(org_slug='acme', project_slugs=['backend'])
    result = sentry.fetch_issues(_client(_handle), config)

    assert result.height == 1
    assert seen[0].headers['authorization'] == 'Bearer test-token'
    assert seen[0].url.params['query'] == sentry.DEFAULT_QUERY
    assert seen[0].url.params.get_list('project') == ['backend']


def test_fetch_issues_follows_link_header_pagination() -> None:
    pages = [
        httpx.Response(
            200,
            json=[_issue_record(id='1')],
            headers={'link': f'<{sentry.BASE_URL}/next-page>; rel="next"; results="true"; cursor="0:100:0"'},
        ),
        httpx.Response(200, json=[_issue_record(id='2')]),
    ]
    calls = iter(pages)

    def _handle(_request: httpx.Request) -> httpx.Response:
        return next(calls)

    config = SentryConfig(org_slug='acme')
    result = sentry.fetch_issues(_client(_handle), config)

    assert result['id'].to_list() == ['1', '2']


def test_fetch_issues_raises_on_error_response() -> None:
    config = SentryConfig(org_slug='acme')

    def _handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={'detail': 'invalid token'})

    with pytest.raises(httpx.HTTPStatusError):
        sentry.fetch_issues(_client(_handle), config)
