"""Sentry REST adapter over `GET /organizations/{org}/issues/`, paginated through the `Link` header."""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import polars as pl

from tlr.config import SentryConfig
from tlr.http import request_with_retry
from tlr.secrets import read_secret
from tlr.store import _SENTRY_DOMAIN_COLS, _SENTRY_SCHEMA

BASE_URL = 'https://sentry.io/api/0'
ISSUES_ENDPOINT_TEMPLATE = '/organizations/{org_slug}/issues/'
DEFAULT_QUERY = 'is:unresolved'
PAGE_LIMIT = 100

_NEXT_LINK_RE = re.compile(r'<([^>]+)>;\s*rel="next";\s*results="true"')

_ISSUE_FRAME_SCHEMA: dict[str, Any] = {
    'id': _SENTRY_SCHEMA['id'],
    **{col: _SENTRY_SCHEMA[col] for col in _SENTRY_DOMAIN_COLS},
}


@dataclass
class SentryClient:
    """Injected dependencies for one Sentry session: the HTTP client and the bearer token."""

    http_client: httpx.Client
    token: str


def build_client(*, http_client: httpx.Client | None = None, token: str | None = None) -> SentryClient:
    """Build a `SentryClient`, defaulting each dependency to its production implementation."""
    return SentryClient(
        http_client=http_client if http_client is not None else httpx.Client(base_url=BASE_URL),
        token=token if token is not None else read_secret('sentry'),
    )


def _send(client: SentryClient, url: str, params: Mapping[str, Any] | None) -> httpx.Response:
    response = request_with_retry(
        client.http_client,
        'GET',
        url,
        headers={'Authorization': f'Bearer {client.token}'},
        params=params,
    )
    response.raise_for_status()
    return response


def _next_url(response: httpx.Response) -> str | None:
    link = response.headers.get('link')
    if not link:
        return None
    match = _NEXT_LINK_RE.search(link)
    return match.group(1) if match else None


def _paginate(client: SentryClient, endpoint: str, params: Mapping[str, Any]) -> Iterator[list[dict[str, Any]]]:
    url: str = endpoint
    next_params: Mapping[str, Any] | None = params
    while True:
        response = _send(client, url, next_params)
        yield response.json()
        next_url = _next_url(response)
        if next_url is None:
            return
        url = next_url
        next_params = None


def _parse_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed.astimezone(UTC).replace(tzinfo=None) if parsed.tzinfo is not None else parsed


def _issue_row(record: Mapping[str, Any]) -> dict[str, Any]:
    project = record.get('project') or {}
    count = record.get('count')
    return {
        'id': record['id'],
        'project_slug': project.get('slug'),
        'title': record.get('title'),
        'culprit': record.get('culprit'),
        'level': record.get('level'),
        'status': record.get('status'),
        'times_seen': int(count) if count is not None else None,
        'first_seen': _parse_datetime(record.get('firstSeen')),
        'last_seen': _parse_datetime(record.get('lastSeen')),
        'permalink': record.get('permalink'),
    }


def parse_issues(records: list[dict[str, Any]]) -> pl.DataFrame:
    """Parse one decoded page of `/organizations/{org}/issues/` into `sentry_issues`-shaped columns."""
    rows = [_issue_row(record) for record in records]
    return pl.DataFrame(rows, schema=_ISSUE_FRAME_SCHEMA) if rows else pl.DataFrame(schema=_ISSUE_FRAME_SCHEMA)


def fetch_issues(
    client: SentryClient,
    config: SentryConfig,
    *,
    stats_period: str = '14d',
    query: str = DEFAULT_QUERY,
) -> pl.DataFrame:
    """Fetch every issue matching `query` for `config.org_slug`, following `Link`-header pagination."""
    endpoint = ISSUES_ENDPOINT_TEMPLATE.format(org_slug=config.org_slug)
    params: dict[str, Any] = {'query': query, 'statsPeriod': stats_period, 'limit': PAGE_LIMIT}
    if config.project_slugs:
        params['project'] = config.project_slugs
    frames = [parse_issues(page) for page in _paginate(client, endpoint, params)]
    return pl.concat(frames) if frames else pl.DataFrame(schema=_ISSUE_FRAME_SCHEMA)
