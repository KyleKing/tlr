"""Pylon REST adapter over `POST /issues/search`.

Pagination, the tracker-link and time-window filter payloads, the rate limit, and the
`body_html` cleanup all come from `docs/api-notes.md`, which also records the two response
shapes this module assumes and nobody has yet confirmed: the `custom_fields` container and
the `pagination.cursor` field.
"""

from __future__ import annotations

import html
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import polars as pl

from tlr.config import PylonConfig
from tlr.http import SlidingWindowLimiter, request_with_retry
from tlr.secrets import read_secret
from tlr.store import (
    _PYLON_DOMAIN_COLS,
    _PYLON_SCHEMA,
    LINK_STATUS_LINKED,
    LINK_STATUS_NO_LINK,
    LINK_STATUS_UNKNOWN,
)

BASE_URL = 'https://api.usepylon.com'
ISSUES_SEARCH_ENDPOINT = '/issues/search'
SEARCH_RATE_LIMIT_PER_MINUTE = 20
PAGE_LIMIT = 100

_CONTACT_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
_NEWLINE_TAG_RE = re.compile(r'<(?:br\s*/?|/p|/div|/li)>', re.IGNORECASE)
_TAG_RE = re.compile(r'<[^>]+>')

_ISSUE_FRAME_SCHEMA = {'id': _PYLON_SCHEMA['id'], **{col: _PYLON_SCHEMA[col] for col in _PYLON_DOMAIN_COLS}}


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


def _post(client: PylonClient, endpoint: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    client.limiter.acquire()
    response = request_with_retry(
        client.http_client,
        'POST',
        endpoint,
        headers={'Authorization': f'Bearer {client.token}'},
        json=payload,
    )
    response.raise_for_status()
    return response.json()


def _paginate(client: PylonClient, endpoint: str, base_payload: Mapping[str, Any]) -> Iterator[dict[str, Any]]:
    cursor: str | None = None
    while True:
        payload = dict(base_payload)
        if cursor is not None:
            payload['cursor'] = cursor
        body = _post(client, endpoint, payload)
        yield body
        cursor = (body.get('pagination') or {}).get('cursor')
        if not cursor:
            return


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


def _resolve_link(custom_fields: Mapping[str, Any], field: str) -> tuple[str, str | None]:
    if field not in custom_fields:
        return LINK_STATUS_UNKNOWN, None
    value = custom_fields[field]
    if value in {None, ''}:
        return LINK_STATUS_NO_LINK, None
    return LINK_STATUS_LINKED, str(value)


def _issue_row(record: Mapping[str, Any], config: PylonConfig) -> dict[str, Any]:
    custom_fields = record.get('custom_fields') or {}
    link_status, linear_identifier = _resolve_link(custom_fields, config.linear_ticket_field)
    requester = record.get('requester') or {}
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
    }


def parse_issues(body: Mapping[str, Any], config: PylonConfig) -> pl.DataFrame:
    """Parse one decoded `/issues/search` response page into `pylon_issues`-shaped columns."""
    rows = [_issue_row(record, config) for record in body['data']]
    return pl.DataFrame(rows, schema=_ISSUE_FRAME_SCHEMA) if rows else pl.DataFrame(schema=_ISSUE_FRAME_SCHEMA)


def fetch_issue_by_linear_ticket(client: PylonClient, config: PylonConfig, identifier: str) -> pl.DataFrame:
    """Fetch every Pylon issue whose tracker-link custom field equals `identifier`."""
    payload = {'filter': build_linear_ticket_filter(config, identifier), 'limit': PAGE_LIMIT}
    frames = [parse_issues(body, config) for body in _paginate(client, ISSUES_SEARCH_ENDPOINT, payload)]
    return pl.concat(frames) if frames else pl.DataFrame(schema=_ISSUE_FRAME_SCHEMA)


def fetch_issues_in_window(
    client: PylonClient,
    config: PylonConfig,
    *,
    start: str,
    end: str,
    requester_id: str | None = None,
    search_text: str | None = None,
) -> pl.DataFrame:
    """Fetch Pylon issues created within `[start, end)`, optionally by requester contact or free text."""
    payload: dict[str, Any] = {
        'filter': build_window_filter(start=start, end=end, requester_id=requester_id),
        'limit': PAGE_LIMIT,
    }
    if search_text is not None:
        payload['search_text'] = search_text
    frames = [parse_issues(body, config) for body in _paginate(client, ISSUES_SEARCH_ENDPOINT, payload)]
    return pl.concat(frames) if frames else pl.DataFrame(schema=_ISSUE_FRAME_SCHEMA)
