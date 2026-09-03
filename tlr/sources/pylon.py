"""Pylon REST adapter over `POST /issues/search`, `GET /issues`, `GET /issue-statuses`, and `GET /accounts`."""

from __future__ import annotations

import html
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import polars as pl

from tlr.config import PylonConfig, TiersConfig
from tlr.http import SlidingWindowLimiter, request_with_retry
from tlr.secrets import read_secret
from tlr.store import (
    _PYLON_ACCOUNT_SCHEMA,
    _PYLON_DOMAIN_COLS,
    _PYLON_LABEL_SCHEMA,
    _PYLON_SCHEMA,
    LINK_STATUS_LINKED,
    LINK_STATUS_NO_LINK,
    LINK_STATUS_UNKNOWN,
    PYLON_LABEL_KIND_QUESTION_TYPE,
    PYLON_LABEL_KIND_TAG,
)

BASE_URL = 'https://api.usepylon.com'
ISSUES_SEARCH_ENDPOINT = '/issues/search'
ISSUE_STATUSES_ENDPOINT = '/issue-statuses'
ACCOUNTS_ENDPOINT = '/accounts'
SEARCH_RATE_LIMIT_PER_MINUTE = 20
PAGE_LIMIT = 100

_CONTACT_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
_NEWLINE_TAG_RE = re.compile(r'<(?:br\s*/?|/p|/div|/li)>', re.IGNORECASE)
_TAG_RE = re.compile(r'<[^>]+>')

_ISSUE_FRAME_SCHEMA: dict[str, Any] = {
    'id': _PYLON_SCHEMA['id'],
    **{col: _PYLON_SCHEMA[col] for col in _PYLON_DOMAIN_COLS},
}
_LABEL_FRAME_SCHEMA: dict[str, Any] = {col: _PYLON_LABEL_SCHEMA[col] for col in ('issue_id', 'kind', 'label')}
_ACCOUNT_FRAME_SCHEMA: dict[str, Any] = {
    col: _PYLON_ACCOUNT_SCHEMA[col] for col in ('id', 'name', 'tier')
}


@dataclass
class PylonClient:
    """Injected dependencies for one Pylon session: the HTTP client, the bearer token, and the search limiter."""

    http_client: httpx.Client
    token: str
    limiter: SlidingWindowLimiter


def build_client(
    *,
    http_client: httpx.Client | None = None,
    token: str | None = None,
    limiter: SlidingWindowLimiter | None = None,
) -> PylonClient:
    """Build a `PylonClient`, defaulting each dependency to its production implementation."""
    return PylonClient(
        http_client=http_client if http_client is not None else httpx.Client(base_url=BASE_URL),
        token=token if token is not None else read_secret('pylon'),
        limiter=limiter if limiter is not None else SlidingWindowLimiter(max_calls=SEARCH_RATE_LIMIT_PER_MINUTE),
    )


def _send(
    client: PylonClient,
    method: str,
    endpoint: str,
    *,
    json_body: Mapping[str, Any] | None = None,
    params: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if method == 'POST':
        client.limiter.acquire()
    response = request_with_retry(
        client.http_client,
        method,
        endpoint,
        headers={'Authorization': f'Bearer {client.token}'},
        json=json_body,
        params=params,
    )
    response.raise_for_status()
    return response.json()


def _paginate(
    client: PylonClient,
    method: str,
    endpoint: str,
    *,
    json_body: Mapping[str, Any] | None = None,
) -> Iterator[dict[str, Any]]:
    cursor: str | None = None
    while True:
        params = {'cursor': cursor} if cursor is not None else None
        body = _send(client, method, endpoint, json_body=json_body, params=params)
        yield body
        pagination = body.get('pagination') or {}
        if not pagination.get('has_next_page'):
            return
        cursor = pagination.get('cursor')


def build_linear_ticket_filter(config: PylonConfig, identifier: str) -> dict[str, Any]:
    """Build the tracker-link lookup filter for one Linear ticket identifier."""
    return {'field': config.linear_ticket_field, 'operator': 'equals', 'value': identifier}


def build_window_filter(
    *,
    start: str,
    end: str,
    requester_id: str | None = None,
) -> dict[str, Any]:
    """Build the time-window filter, narrowed to one requester contact UUID when given.

    A `requester_id` that does not match Pylon's contact UUID shape is dropped rather
    than sent, since an email-shaped value is never resolved.
    """
    subfilters: list[dict[str, Any]] = [
        {'field': 'created_at', 'operator': 'time_range', 'values': [start, end]},
    ]
    if requester_id is not None and _CONTACT_UUID_RE.fullmatch(requester_id):
        subfilters.append({'field': 'requester_id', 'operator': 'equals', 'value': requester_id})
    if len(subfilters) == 1:
        return subfilters[0]
    return {'operator': 'and', 'subfilters': subfilters}


def _clean_body_html(body_html: str | None) -> str | None:
    if body_html is None:
        return None
    with_newlines = _NEWLINE_TAG_RE.sub('\n', body_html)
    return html.unescape(_TAG_RE.sub('', with_newlines)).strip()


def _parse_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed.astimezone(UTC).replace(tzinfo=None) if parsed.tzinfo is not None else parsed


def _custom_field_single(custom_fields: Mapping[str, Any], field: str) -> str | None:
    entry = custom_fields.get(field)
    if not isinstance(entry, Mapping):
        return None
    return entry.get('value') or None


def _custom_field_multi(custom_fields: Mapping[str, Any], field: str) -> list[str]:
    entry = custom_fields.get(field)
    if not isinstance(entry, Mapping):
        return []
    return [value for value in entry.get('values') or [] if value]


def _resolve_link(custom_fields: Mapping[str, Any], field: str) -> tuple[str, str | None]:
    entry = custom_fields.get(field)
    if entry is None or not isinstance(entry, Mapping):
        return LINK_STATUS_UNKNOWN, None
    return (LINK_STATUS_NO_LINK, None) if entry.get('value') in {None, ''} else (LINK_STATUS_LINKED, entry['value'])


def _issue_row(record: Mapping[str, Any], config: PylonConfig, status_categories: Mapping[str, str]) -> dict[str, Any]:
    custom_fields = record.get('custom_fields') or {}
    link_status, linear_identifier = _resolve_link(custom_fields, config.linear_ticket_field)
    requester = record.get('requester') or {}
    account = record.get('account') or {}
    assignee = record.get('assignee') or {}
    state = record.get('state')
    return {
        'id': record['id'],
        'number': record.get('number'),
        'title': record.get('title'),
        'body': _clean_body_html(record.get('body_html')),
        'created_at': _parse_datetime(record.get('created_at')),
        'link': record.get('link'),
        'requester_email': requester.get('email'),
        'link_status': link_status,
        'linear_identifier': linear_identifier,
        'state': state,
        'state_category': status_categories.get(state) if state is not None else None,
        'priority': _custom_field_single(custom_fields, config.priority_field),
        'account_id': account.get('id'),
        'assignee_id': assignee.get('id'),
        'issue_type': record.get('type'),
        'is_issue_group': record.get('is_issue_group'),
        'resolution_time': _parse_datetime(record.get('resolution_time')),
        'first_response_time': _parse_datetime(record.get('first_response_time')),
        'latest_message_time': _parse_datetime(record.get('latest_message_time')),
        'source_updated_at': _parse_datetime(record.get('updated_at')),
    }


def parse_issues(
    body: Mapping[str, Any],
    config: PylonConfig,
    status_categories: Mapping[str, str] | None = None,
) -> pl.DataFrame:
    """Parse one decoded issue-search or issue-list response page into `pylon_issues`-shaped columns.

    `status_categories` maps a status slug to its Pylon category (`new`, `waiting_on_you`,
    `waiting_on_customer`, `on_hold`, `closed`); a slug missing from it parses to a null
    `state_category` rather than a guess.
    """
    categories = status_categories or {}
    rows = [_issue_row(record, config, categories) for record in body['data']]
    return pl.DataFrame(rows, schema=_ISSUE_FRAME_SCHEMA) if rows else pl.DataFrame(schema=_ISSUE_FRAME_SCHEMA)


@dataclass(frozen=True)
class PylonIssuesResult:
    """One search's issue rows alongside the tag and question-type rows read from the same pages."""

    issues: pl.DataFrame
    labels: pl.DataFrame


def _collect(
    pages: Iterator[dict[str, Any]],
    config: PylonConfig,
    categories: Mapping[str, str] | None,
) -> PylonIssuesResult:
    issue_frames = []
    label_frames = []
    for body in pages:
        issue_frames.append(parse_issues(body, config, categories))
        label_frames.append(parse_issue_labels(body, config))
    return PylonIssuesResult(
        issues=pl.concat(issue_frames) if issue_frames else pl.DataFrame(schema=_ISSUE_FRAME_SCHEMA),
        labels=pl.concat(label_frames) if label_frames else pl.DataFrame(schema=_LABEL_FRAME_SCHEMA),
    )


def fetch_issue_by_linear_ticket(
    client: PylonClient,
    config: PylonConfig,
    identifier: str,
    status_categories: Mapping[str, str] | None = None,
) -> PylonIssuesResult:
    """Fetch every Pylon issue whose tracker-link custom field equals `identifier`."""
    payload = {'filter': build_linear_ticket_filter(config, identifier), 'limit': PAGE_LIMIT}
    pages = _paginate(client, 'POST', ISSUES_SEARCH_ENDPOINT, json_body=payload)
    return _collect(pages, config, status_categories)


def fetch_issues_in_window(
    client: PylonClient,
    config: PylonConfig,
    *,
    start: str,
    end: str,
    requester_id: str | None = None,
    search_text: str | None = None,
    status_categories: Mapping[str, str] | None = None,
) -> PylonIssuesResult:
    """Fetch Pylon issues created within `[start, end)`, optionally by requester contact or free text."""
    payload: dict[str, Any] = {
        'filter': build_window_filter(start=start, end=end, requester_id=requester_id),
        'limit': PAGE_LIMIT,
    }
    if search_text is not None:
        payload['search_text'] = search_text
    pages = _paginate(client, 'POST', ISSUES_SEARCH_ENDPOINT, json_body=payload)
    return _collect(pages, config, status_categories)


def fetch_issue_statuses(client: PylonClient) -> dict[str, Any]:
    """Fetch the decoded `GET /issue-statuses` response for this workspace."""
    return _send(client, 'GET', ISSUE_STATUSES_ENDPOINT)


def parse_issue_statuses(body: Mapping[str, Any]) -> dict[str, str]:
    """Parse a decoded `/issue-statuses` response into a status-slug to category mapping."""
    return {row['value']: row['category'] for row in body['data']}


def _label_rows(record: Mapping[str, Any], config: PylonConfig) -> list[dict[str, Any]]:
    issue_id = record['id']
    rows = [{'issue_id': issue_id, 'kind': PYLON_LABEL_KIND_TAG, 'label': tag} for tag in record.get('tags') or []]
    custom_fields = record.get('custom_fields') or {}
    question_types = _custom_field_multi(custom_fields, config.question_type_field)
    rows.extend(
        {'issue_id': issue_id, 'kind': PYLON_LABEL_KIND_QUESTION_TYPE, 'label': question_type}
        for question_type in question_types
    )
    return rows


def parse_issue_labels(body: Mapping[str, Any], config: PylonConfig) -> pl.DataFrame:
    """Parse one decoded issue-search or issue-list response page into `pylon_issue_labels`-shaped columns."""
    rows = [row for record in body['data'] for row in _label_rows(record, config)]
    return pl.DataFrame(rows, schema=_LABEL_FRAME_SCHEMA) if rows else pl.DataFrame(schema=_LABEL_FRAME_SCHEMA)


def _account_row(record: Mapping[str, Any], tiers: TiersConfig) -> dict[str, Any]:
    custom_fields = record.get('custom_fields') or {}
    tier = _custom_field_single(custom_fields, tiers.account_tier_field) if tiers.account_tier_field else None
    return {'id': record['id'], 'name': record.get('name'), 'tier': tier}


def parse_accounts(body: Mapping[str, Any], tiers: TiersConfig) -> pl.DataFrame:
    """Parse one decoded `/accounts` response page into `pylon_accounts`-shaped columns."""
    rows = [_account_row(record, tiers) for record in body['data']]
    return pl.DataFrame(rows, schema=_ACCOUNT_FRAME_SCHEMA) if rows else pl.DataFrame(schema=_ACCOUNT_FRAME_SCHEMA)


def fetch_accounts(client: PylonClient, tiers: TiersConfig) -> pl.DataFrame:
    """Fetch every Pylon account, paginating through `GET /accounts`."""
    frames = [parse_accounts(body, tiers) for body in _paginate(client, 'GET', ACCOUNTS_ENDPOINT)]
    return pl.concat(frames) if frames else pl.DataFrame(schema=_ACCOUNT_FRAME_SCHEMA)
