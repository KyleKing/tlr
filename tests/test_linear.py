"""Tests for tlr.sources.linear."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from tlr import store
from tlr.sources import linear

_API_KEY = 'lin_api_test_key'


def _issue_node(*, identifier: str = 'DEV-1', labels: list[str] | None = None) -> dict[str, Any]:
    return {
        'id': f'uuid-{identifier}',
        'identifier': identifier,
        'archivedAt': None,
        'createdAt': '2026-01-01T00:00:00.000Z',
        'title': 'Fix the widget',
        'url': f'https://example.test/{identifier}',
        'description': 'It is broken',
        'estimate': 3,
        'priority': 2,
        'state': {'name': 'In Progress', 'type': 'started'},
        'team': {'key': 'DEV'},
        'assignee': {'name': 'Ada Example'},
        'cycle': {'number': 5},
        'labels': {'nodes': [{'name': name} for name in (labels or [])]},
        'parent': None,
        'project': {'name': 'Rebuild'},
        'projectMilestone': {'id': 'milestone-1'},
        'relations': {'nodes': [{'type': 'blocks', 'relatedIssue': {'identifier': 'DEV-2'}}]},
        'history': {'nodes': []},
    }


def _issues_page(nodes: list[dict[str, Any]], *, has_next: bool = False, end_cursor: str = '') -> dict[str, Any]:
    return {'issues': {'pageInfo': {'hasNextPage': has_next, 'endCursor': end_cursor}, 'nodes': nodes}}


def _transport(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> linear.LinearClient:
    return linear.LinearClient(http=_transport(handler), api_key=_API_KEY)


def _graphql_response(data: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json={'data': data})


def _no_sleep(_seconds: float) -> None:
    return None


def test_make_linear_client_uses_injected_key_and_http() -> None:
    http = httpx.Client()
    client = linear.make_linear_client(http=http, api_key=_API_KEY)
    assert client.http is http
    assert client.api_key == _API_KEY


def test_fetch_issues_sends_raw_authorization_header() -> None:
    seen_headers: list[httpx.Headers] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        seen_headers.append(request.headers)
        return _graphql_response(_issues_page([_issue_node()]))

    result = linear.fetch_issues(_client(_handle), issue_filter=linear.team_issue_filter('DEV'), sleep=_no_sleep)
    assert result.issues.height == 1
    assert seen_headers[0]['authorization'] == _API_KEY


def test_fetch_issues_paginates_across_two_pages() -> None:
    pages = [
        _issues_page([_issue_node(identifier='DEV-1')], has_next=True, end_cursor='cursor-1'),
        _issues_page([_issue_node(identifier='DEV-2')], has_next=False),
    ]
    calls = iter(pages)

    def _handle(_request: httpx.Request) -> httpx.Response:
        return _graphql_response(next(calls))

    result = linear.fetch_issues(_client(_handle), issue_filter=linear.team_issue_filter('DEV'), sleep=_no_sleep)
    assert result.issues['identifier'].to_list() == ['DEV-1', 'DEV-2']
    assert result.labels.is_empty()
    assert result.relations.height == 2  # noqa: PLR2004


def test_fetch_issues_raises_when_next_page_has_empty_cursor() -> None:
    def _handle(_request: httpx.Request) -> httpx.Response:
        return _graphql_response(_issues_page([_issue_node()], has_next=True, end_cursor=''))

    with pytest.raises(linear.GraphQLError, match='endCursor'):
        linear.fetch_issues(_client(_handle), issue_filter=linear.team_issue_filter('DEV'), sleep=_no_sleep)


def test_fetch_issues_raises_on_graphql_errors_body() -> None:
    def _handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={'errors': [{'message': 'Query too complex'}]})

    with pytest.raises(linear.GraphQLError, match='too complex'):
        linear.fetch_issues(_client(_handle), issue_filter=linear.team_issue_filter('DEV'), sleep=_no_sleep)


def test_parse_issues_produces_store_shaped_columns() -> None:
    df = linear.parse_issues(_issues_page([_issue_node()]))
    assert df.columns == list(linear._ISSUE_SCHEMA.keys())  # noqa: SLF001
    row = df.row(0, named=True)
    assert row['identifier'] == 'DEV-1'
    assert row['state_name'] == 'In Progress'
    assert row['team_key'] == 'DEV'
    assert row['assignee_name'] == 'Ada Example'
    assert row['created_at'] == datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)


def test_parse_issues_normalizes_null_assignee_to_unassigned() -> None:
    node = _issue_node()
    node['assignee'] = None
    df = linear.parse_issues(_issues_page([node]))
    assert df.row(0, named=True)['assignee_name'] == linear.UNASSIGNED


def test_parse_issue_labels_produces_store_shaped_columns() -> None:
    df = linear.parse_issue_labels(_issues_page([_issue_node(labels=['bug', 'p1'])]))
    assert df.columns == ['issue_id', 'label']
    assert df['label'].to_list() == ['bug', 'p1']


def test_parse_issue_relations_produces_store_shaped_columns() -> None:
    df = linear.parse_issue_relations(_issues_page([_issue_node()]))
    assert df.columns == ['issue_id', 'relation_type', 'related_identifier']
    row = df.row(0, named=True)
    assert row['relation_type'] == 'blocks'
    assert row['related_identifier'] == 'DEV-2'


def test_fetch_team_cycles_orders_oldest_first() -> None:
    def _handle(_request: httpx.Request) -> httpx.Response:
        return _graphql_response(
            {
                'teams': {
                    'nodes': [
                        {
                            'key': 'DEV',
                            'cycles': {
                                'nodes': [
                                    {
                                        'number': 11,
                                        'startsAt': '2025-11-01T00:00:00.000Z',
                                        'endsAt': '2025-11-14T00:00:00.000Z',
                                    },
                                    {
                                        'number': 12,
                                        'startsAt': '2025-11-15T00:00:00.000Z',
                                        'endsAt': '2025-11-28T00:00:00.000Z',
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
        )

    df = linear.fetch_team_cycles(_client(_handle), 'DEV', sleep=_no_sleep)
    assert df.columns == ['team_key', 'number', 'starts_at', 'ends_at']
    assert df['number'].to_list() == [11, 12]
    assert df['starts_at'].to_list()[0] == datetime(2025, 11, 1, tzinfo=UTC).replace(tzinfo=None)


def test_parse_cycles_returns_empty_frame_for_unknown_team() -> None:
    df = linear.parse_cycles({'teams': {'nodes': []}})
    assert df.is_empty()
    assert df.columns == ['team_key', 'number', 'starts_at', 'ends_at']


def test_fetch_projects_flattens_project_milestones_and_team_keys() -> None:
    def _handle(_request: httpx.Request) -> httpx.Response:
        return _graphql_response(
            {
                'projects': {
                    'nodes': [
                        {
                            'id': 'project-1',
                            'name': 'Rebuild',
                            'url': 'https://example.test/project-1',
                            'slugId': 'rebuild-abc',
                            'startDate': '2026-01-01',
                            'targetDate': '2026-03-01',
                            'projectMilestones': {
                                'nodes': [
                                    {
                                        'id': 'milestone-1',
                                        'name': 'Phase 1',
                                        'targetDate': '2026-02-01',
                                        'progress': 0.5,
                                    },
                                ],
                            },
                            'teams': {'nodes': [{'key': 'DEV'}, {'key': 'DES'}]},
                        },
                    ],
                },
            },
        )

    df = linear.fetch_projects(_client(_handle), project_filter=linear.project_name_filter('Rebuild'), sleep=_no_sleep)
    assert df.height == 1
    row = df.row(0, named=True)
    assert row['project_name'] == 'Rebuild'
    assert row['team_keys'] == ['DEV', 'DES']
    assert row['milestone_name'] == 'Phase 1'
    assert row['start_date'] == datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)


def test_parse_projects_keeps_project_with_no_milestones() -> None:
    data: dict[str, Any] = {
        'projects': {
            'nodes': [
                {
                    'id': 'project-2',
                    'name': 'No Milestones',
                    'url': None,
                    'slugId': 'no-milestones',
                    'startDate': None,
                    'targetDate': None,
                    'projectMilestones': {'nodes': []},
                    'teams': {'nodes': []},
                },
            ],
        },
    }
    df = linear.parse_projects(data)
    assert df.height == 1
    assert df.row(0, named=True)['milestone_id'] is None


@pytest.mark.parametrize(
    ('build_filter', 'arg', 'expected'),
    [
        (linear.team_issue_filter, 'DEV', {'team': {'key': {'eq': 'DEV'}}}),
        (linear.project_issue_filter, 'project-1', {'project': {'id': {'eq': 'project-1'}}}),
        (linear.project_name_filter, 'Rebuild', {'name': {'containsIgnoreCase': 'Rebuild'}}),
        (linear.project_slug_filter, 'rebuild-abc', {'slugId': {'eq': 'rebuild-abc'}}),
    ],
)
def test_filter_builders(build_filter: Callable[[str], dict[str, Any]], arg: str, expected: dict[str, Any]) -> None:
    assert build_filter(arg) == expected


def test_graphql_error_body_message_is_not_swallowed() -> None:
    def _handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={'errors': [{'message': 'boom'}], 'data': None})

    with pytest.raises(linear.GraphQLError):
        linear.fetch_team_cycles(_client(_handle), 'DEV', sleep=_no_sleep)


def test_parsed_frames_upsert_into_the_store_unreshaped(tmp_path: Path) -> None:
    data = _issues_page([_issue_node(labels=['bug'])])
    con = store.connect(tmp_path / 'tlr.duckdb')

    store.upsert_issues(con, linear.parse_issues(data), source='linear')
    store.upsert_issue_labels(con, linear.parse_issue_labels(data), source='linear')
    store.upsert_issue_relations(con, linear.parse_issue_relations(data), source='linear')

    assert store.get_issues(con)['identifier'].to_list() == ['DEV-1']
    assert store.get_issue_labels(con)['label'].to_list() == ['bug']
    assert store.get_issue_relations(con)['related_identifier'].to_list() == ['DEV-2']
    con.close()
