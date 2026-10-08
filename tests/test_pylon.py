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
from tlr.config import PylonConfig, TiersConfig
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
        'updated_at': '2026-01-02T12:00:00Z',
        'link': 'https://app.usepylon.com/issues?issueNumber=100',
        'requester': {'id': _CONTACT_UUID, 'email': 'requester@example.test'},
        'custom_fields': {'linear_ticket': {'value': 'DEV-1234'}},
        'state': 'waiting_on_customer',
        'account': {'id': 'account-1'},
        'assignee': {'id': 'agent-1'},
        'type': 'question',
        'is_issue_group': False,
        'resolution_time': None,
        'first_response_time': None,
        'latest_message_time': None,
        'tags': [],
    }
    record.update(overrides)
    return record


def _page(records: list[dict[str, Any]], *, cursor: str | None = None, has_next_page: bool = False) -> dict[str, Any]:
    return {
        'data': records,
        'pagination': {'cursor': cursor, 'has_next_page': has_next_page},
        'request_id': 'req-1',
    }


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


def test_fetch_issue_by_linear_ticket_paginates_with_cursor_in_body() -> None:
    config = PylonConfig()
    pages = [
        _page([_issue_record(id='issue-1')], cursor='page-2', has_next_page=True),
        _page([_issue_record(id='issue-2')], cursor=None, has_next_page=False),
    ]
    requests: list[httpx.Request] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=pages[len(requests) - 1])

    client = _client(_handle)
    result = pylon.fetch_issue_by_linear_ticket(client, config, 'DEV-1234')

    assert result.issues['id'].to_list() == ['issue-1', 'issue-2']
    assert len(requests) == _EXPECTED_PAGE_COUNT
    assert 'cursor' not in requests[0].url.params
    assert 'cursor' not in json.loads(requests[0].content)
    assert 'cursor' not in requests[1].url.params
    assert json.loads(requests[1].content)['cursor'] == 'page-2'


def test_paginate_fails_loud_when_has_next_page_but_no_cursor() -> None:
    pages = [_page([_issue_record(id='issue-1')], cursor=None, has_next_page=True)]

    def _handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=pages[0])

    client = _client(_handle)
    with pytest.raises(ValueError, match='has_next_page but returned no cursor'):
        pylon.fetch_issue_by_linear_ticket(client, PylonConfig(), 'DEV-1234')


def test_fetch_issues_paginates_get_issues_with_time_range_params() -> None:
    config = PylonConfig()
    pages = [
        _page([_issue_record(id='issue-1')], cursor='page-2', has_next_page=True),
        _page([_issue_record(id='issue-2')], cursor=None, has_next_page=False),
    ]
    requests: list[httpx.Request] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=pages[len(requests) - 1])

    client = _client(_handle)
    result = pylon.fetch_issues(
        client,
        config,
        start=datetime(2026, 1, 1, tzinfo=UTC),
        end=datetime(2026, 12, 31, tzinfo=UTC),
    )

    assert result.issues['id'].to_list() == ['issue-1', 'issue-2']
    assert len(requests) == _EXPECTED_PAGE_COUNT
    assert requests[0].url.params['start_time'] == '2026-01-01T00:00:00Z'
    assert requests[0].url.params['end_time'] == '2026-12-31T00:00:00Z'
    assert requests[1].url.params['cursor'] == 'page-2'
    assert not requests[0].content


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
    ('overrides', 'expected_status', 'expected_identifier'),
    [
        ({'custom_fields': {'linear_ticket': {'value': 'DEV-42'}}}, LINK_STATUS_LINKED, 'DEV-42'),
        (
            {'custom_fields': {'linear_ticket': {'value': 'https://linear.app/ws/issue/DEV-55/slug'}}},
            LINK_STATUS_LINKED,
            'DEV-55',
        ),
        ({'custom_fields': {'linear_ticket': {'value': ''}}}, LINK_STATUS_NO_LINK, None),
        ({'custom_fields': {}}, LINK_STATUS_UNKNOWN, None),
        (
            {'external_issues': [{'source': 'linear', 'link': 'https://linear.app/ws/issue/DEV-77/slug'}]},
            LINK_STATUS_LINKED,
            'DEV-77',
        ),
    ],
)
def test_link_status_resolution(
    overrides: dict[str, Any],
    expected_status: str,
    expected_identifier: str | None,
) -> None:
    config = PylonConfig()
    body = _page([_issue_record(**overrides)])

    result = pylon.parse_issues(body, config)

    assert result['link_status'].to_list() == [expected_status]
    assert result['linear_identifier'].to_list() == [expected_identifier]


@pytest.mark.parametrize(
    ('status_categories', 'expected_category'),
    [
        ({'nar': 'closed'}, 'closed'),
        ({}, None),
    ],
)
def test_parse_issues_resolves_state_category_from_slug_mapping(
    status_categories: dict[str, str],
    expected_category: str | None,
) -> None:
    config = PylonConfig()
    body = _page([_issue_record(state='nar')])

    result = pylon.parse_issues(body, config, status_categories)

    assert result['state_category'].to_list() == [expected_category]


def test_parse_issues_and_labels_treat_request_id_only_body_as_empty() -> None:
    config = PylonConfig()
    body = {'request_id': 'req-1'}

    assert pylon.parse_issues(body, config).is_empty()
    assert pylon.parse_issue_labels(body, config).is_empty()


def test_parse_issue_statuses_maps_slug_to_category() -> None:
    body = {
        'data': [
            {'slug': 'waiting_on_customer', 'label': 'Waiting on Customer', 'category': 'waiting_on_customer'},
            {'slug': 'nar', 'label': 'NAR', 'category': 'closed'},
        ],
    }

    result = pylon.parse_issue_statuses(body)

    assert result == {'waiting_on_customer': 'waiting_on_customer', 'nar': 'closed'}


def test_parse_issue_labels_produces_tags_and_question_types() -> None:
    config = PylonConfig()
    body = _page(
        [
            _issue_record(
                tags=['billing', 'urgent'],
                custom_fields={
                    'question_type': {
                        'value': '',
                        'values': ['no_action_required', 'bug'],
                        'interpreted_values': ['No Action Required', 'Bug'],
                    },
                },
            ),
        ],
    )

    result = pylon.parse_issue_labels(body, config)

    assert set(result.columns) == {'issue_id', 'kind', 'label'}
    rows = {(row['kind'], row['label']) for row in result.to_dicts()}
    assert rows == {
        (store.PYLON_LABEL_KIND_TAG, 'billing'),
        (store.PYLON_LABEL_KIND_TAG, 'urgent'),
        (store.PYLON_LABEL_KIND_QUESTION_TYPE, 'no_action_required'),
        (store.PYLON_LABEL_KIND_QUESTION_TYPE, 'bug'),
    }


@pytest.mark.parametrize(
    ('account_tier_field', 'custom_fields', 'expected_tier'),
    [
        ('lifecycle', {'lifecycle': {'value': 'enterprise'}}, 'enterprise'),
        ('', {'lifecycle': {'value': 'enterprise'}}, None),
        ('lifecycle', {}, None),
    ],
)
def test_parse_accounts_reads_tier_from_configured_field(
    account_tier_field: str,
    custom_fields: dict[str, Any],
    expected_tier: str | None,
) -> None:
    tiers = TiersConfig(account_tier_field=account_tier_field)
    body = _page([{'id': 'account-1', 'name': 'Acme', 'custom_fields': custom_fields}])

    result = pylon.parse_accounts(body, tiers)

    assert result['tier'].to_list() == [expected_tier]
    assert result['id'].to_list() == ['account-1']
    assert result['name'].to_list() == ['Acme']


def test_fetch_accounts_paginates_with_cursor_as_query_param() -> None:
    tiers = TiersConfig(account_tier_field='lifecycle')
    pages = [
        _page([{'id': 'account-1', 'name': 'Acme', 'custom_fields': {}}], cursor='page-2', has_next_page=True),
        _page([{'id': 'account-2', 'name': 'Widgets', 'custom_fields': {}}], cursor=None, has_next_page=False),
    ]
    requests: list[httpx.Request] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=pages[len(requests) - 1])

    client = _client(_handle)
    result = pylon.fetch_accounts(client, tiers)

    assert result['id'].to_list() == ['account-1', 'account-2']
    assert len(requests) == _EXPECTED_PAGE_COUNT
    assert 'cursor' not in requests[0].url.params
    assert requests[1].url.params['cursor'] == 'page-2'


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


def test_parse_issues_produces_store_shaped_columns() -> None:
    config = PylonConfig()
    body = _page([_issue_record()])

    result = pylon.parse_issues(body, config)

    assert set(result.columns) == {'id', *store._PYLON_DOMAIN_COLS}  # noqa: SLF001
    assert result['body'].to_list() == ['First line\nSecond line']
    assert result['created_at'].to_list() == [datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC).replace(tzinfo=None)]
    assert result['source_updated_at'].to_list() == [datetime(2026, 1, 2, 12, 0, 0, tzinfo=UTC).replace(tzinfo=None)]
    assert result['requester_email'].to_list() == ['requester@example.test']
    assert result['account_id'].to_list() == ['account-1']
    assert result['assignee_id'].to_list() == ['agent-1']
    assert result['issue_type'].to_list() == ['question']
    assert result['is_issue_group'].to_list() == [False]


def test_upsert_pylon_issues_accepts_fetch_output_unchanged(tmp_path: Path) -> None:
    config = PylonConfig()
    body = _page([_issue_record()])
    df = pylon.parse_issues(body, config)

    con = store.connect(tmp_path / 'tlr.duckdb')
    store.upsert_pylon_issues(con, df)
    result = store.get_pylon_issues(con)

    assert result['id'].to_list() == ['issue-1']
    con.close()


def test_a_custom_field_shape_change_reads_as_unknown_not_as_no_link() -> None:
    config = PylonConfig()
    body = _page([_issue_record(custom_fields={'linear_ticket': 'DEV-42'})])

    result = pylon.parse_issues(body, config)

    assert result['link_status'].to_list() == [LINK_STATUS_UNKNOWN]
    assert result['linear_identifier'].to_list() == [None]


def test_a_search_returns_tag_rows_from_the_same_pages() -> None:
    config = PylonConfig()

    record = _issue_record(
        tags=['billing'],
        custom_fields={'question_type': {'values': ['feature_request']}},
    )

    def _handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_page([record]))

    result = pylon.fetch_issue_by_linear_ticket(_client(_handle), config, 'DEV-1234')

    assert result.issues['id'].to_list() == ['issue-1']
    assert result.labels['label'].to_list() == ['billing', 'feature_request']
    assert result.labels['kind'].to_list() == ['tag', 'question_type']
