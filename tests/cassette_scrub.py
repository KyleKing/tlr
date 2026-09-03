"""Scrub sensitive data from vcrpy cassettes at record time, and verify it stayed scrubbed at commit time.

See docs/cassettes.md for the recording workflow and what to do when the verifier rejects a field.

Every header and JSON key reachable in a cassette must be classified below as one of:

- structural: kept verbatim (`STRUCTURAL_HEADERS`, `STRUCTURAL_JSON_KEYS`)
- redacted: replaced with a stable, shape-preserving placeholder (`_REDACTED_KEY_CLASS` /
  `REDACTED_PLACEHOLDERS`)
- unknown: rejected by `main()`, which is the pre-commit gate

A key reached but not classified is a bug in this file, not a cassette to patch by hand.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

CASSETTE_DIR_NAME = 'cassettes'

REDACTED_UUID = '00000000-0000-0000-0000-000000000000'
REDACTED_EMAIL = 'redacted@example.invalid'
REDACTED_TEXT = '[REDACTED]'
REDACTED_TIMESTAMP = '2000-01-01T00:00:00.000Z'
REDACTED_IDENTIFIER = 'ORG-0000'
REDACTED_SLUG = 'redacted-slug'
REDACTED_CODE = 'ORG'
REDACTED_URL = 'https://example.invalid/redacted'

REDACTED_PLACEHOLDERS: dict[str, str] = {
    'uuid': REDACTED_UUID,
    'email': REDACTED_EMAIL,
    'text': REDACTED_TEXT,
    'timestamp': REDACTED_TIMESTAMP,
    'identifier': REDACTED_IDENTIFIER,
    'slug': REDACTED_SLUG,
    'code': REDACTED_CODE,
    'url': REDACTED_URL,
}

# Linear sends its raw key under plain `Authorization` with no `Bearer` prefix, so the substring
# rule below wouldn't catch it; DROPPED_HEADERS names it explicitly (docs/api-notes.md).
DROPPED_HEADERS = frozenset({'authorization', 'cookie', 'set-cookie', 'proxy-authorization'})
SENSITIVE_HEADER_SUBSTRINGS = ('key', 'token', 'secret', 'auth')

STRUCTURAL_HEADERS = frozenset(
    {
        'accept',
        'accept-encoding',
        'accept-ranges',
        'access-control-allow-credentials',
        'access-control-allow-origin',
        'access-control-expose-headers',
        'alt-svc',
        'cache-control',
        'cf-cache-status',
        'cf-ray',
        'connection',
        'content-encoding',
        'content-length',
        'content-security-policy',
        'content-type',
        'date',
        'etag',
        'expires',
        'host',
        'last-modified',
        'nel',
        'pragma',
        'referrer-policy',
        'report-to',
        'retry-after',
        'server',
        'strict-transport-security',
        'transfer-encoding',
        'user-agent',
        'vary',
        'via',
        'x-cache',
        'x-cache-hits',
        'x-content-type-options',
        'x-download-options',
        'x-frame-options',
        'x-github-request-id',
        'x-permitted-cross-domain-policies',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'x-request-id',
        'x-runtime',
        'x-served-by',
        'x-xss-protection',
    }
)

# JSON field names kept verbatim: pagination and container scaffolding, and values that carry no
# workspace-specific content (enums, counters, booleans, positions).
STRUCTURAL_JSON_KEYS = frozenset(
    {
        'active',
        'after',
        'and',
        'app',
        'assignee',
        'busy',
        'calendars',
        'custom_fields',
        'cycle',
        'cycles',
        'data',
        'endCursor',
        'estimate',
        'field',
        'filter',
        'final',
        'fromCycle',
        'guest',
        'hasNextPage',
        'history',
        'issue',
        'issueEstimationAllowZero',
        'issueEstimationExtended',
        'issueEstimationType',
        'items',
        'labels',
        'limit',
        'members',
        'nodes',
        'number',
        'ok',
        'operationName',
        'operator',
        'organization',
        'pageInfo',
        'pagination',
        'pagination_meta',
        'parent',
        'position',
        'priority',
        'progress',
        'project',
        'projectMilestone',
        'projectMilestones',
        'query',
        'relatedIssue',
        'relations',
        'requester',
        'schedule_entries',
        'state',
        'states',
        'status',
        'subfilters',
        'success',
        'team',
        'teams',
        'toCycle',
        'type',
        'user',
        'variables',
    }
)

# JSON field names replaced with a stable, shape-preserving placeholder. The key is the field
# name; the value names which placeholder class from REDACTED_PLACEHOLDERS applies.
_REDACTED_KEY_CLASS: dict[str, str] = {
    'archivedAt': 'timestamp',
    'body_html': 'text',
    'created_at': 'timestamp',
    'createdAt': 'timestamp',
    'description': 'text',
    'displayName': 'text',
    'email': 'email',
    'end_at': 'timestamp',
    'endsAt': 'timestamp',
    'id': 'uuid',
    'identifier': 'identifier',
    'key': 'code',
    'link': 'url',
    'name': 'text',
    'request_id': 'uuid',
    'search_text': 'text',
    'slugId': 'slug',
    'start_at': 'timestamp',
    'startDate': 'timestamp',
    'startsAt': 'timestamp',
    'targetDate': 'timestamp',
    'timeMax': 'timestamp',
    'timeMin': 'timestamp',
    'title': 'text',
    'url': 'url',
    'urlKey': 'slug',
    'value': 'text',
}

_CREDENTIAL_PATTERNS = (
    re.compile(r'lin_api_[A-Za-z0-9]+'),
    re.compile(r'xoxp-[A-Za-z0-9-]+'),
    re.compile(r'\b[0-9a-f]{32,}\b', re.IGNORECASE),
    re.compile(r'\b[A-Za-z0-9+/]{40,}={0,2}\b'),
)
_EMAIL_PATTERN = re.compile(r'[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+')


def classify_header(name: str) -> str:
    """Classify a header name as 'drop', 'keep', or 'unknown'."""
    lname = name.lower()
    if lname in DROPPED_HEADERS or any(word in lname for word in SENSITIVE_HEADER_SUBSTRINGS):
        return 'drop'
    if lname in STRUCTURAL_HEADERS:
        return 'keep'
    return 'unknown'


def classify_json_key(key: str) -> str:
    """Classify a JSON key as 'structural', 'unknown', or a REDACTED_PLACEHOLDERS class name."""
    if key in _REDACTED_KEY_CLASS:
        return _REDACTED_KEY_CLASS[key]
    if key in STRUCTURAL_JSON_KEYS:
        return 'structural'
    return 'unknown'


def scrub_json(value: Any, *, key_cls: str | None = None) -> Any:
    """Return a copy of `value` with every redacted-class key replaced by its placeholder.

    Unknown keys are passed through untouched: this hook is not the enforcement point, `main()` is.
    """
    if isinstance(value, dict):
        return {k: scrub_json(v, key_cls=classify_json_key(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub_json(item, key_cls=key_cls) for item in value]
    if value is None or key_cls in {None, 'structural', 'unknown'}:
        return value
    return REDACTED_PLACEHOLDERS[key_cls]


def _scrub_header_mapping(headers: dict[str, Any]) -> None:
    for name in list(headers):
        if classify_header(name) == 'drop':
            del headers[name]


def _scrub_json_text(text: str) -> str | None:
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return None
    return json.dumps(scrub_json(parsed))


def scrub_request(request: Any) -> Any:
    """Vcr `before_record_request` hook: drop auth-like headers, scrub the JSON body in place."""
    _scrub_header_mapping(request.headers)
    body = request.body
    if body:
        text = body.decode('utf-8') if isinstance(body, bytes) else body
        scrubbed = _scrub_json_text(text)
        if scrubbed is not None:
            request.body = scrubbed
    return request


def scrub_response(response: dict[str, Any]) -> dict[str, Any]:
    """Vcr `before_record_response` hook: drop auth-like headers, scrub the JSON body in place."""
    _scrub_header_mapping(response.get('headers') or {})
    body = response.get('body')
    if isinstance(body, dict):
        string = body.get('string')
        if string:
            text = string.decode('utf-8') if isinstance(string, bytes) else string
            scrubbed = _scrub_json_text(text)
            if scrubbed is not None:
                body['string'] = scrubbed.encode('utf-8') if isinstance(string, bytes) else scrubbed
    return response


@dataclass(frozen=True)
class Violation:
    """One reason a cassette failed verification."""

    file: str
    path: str
    message: str


def _check_leaf_patterns(value: Any, path: str, violations: list[Violation], file_label: str) -> None:
    if not isinstance(value, str):
        return
    if any(pattern.search(value) for pattern in _CREDENTIAL_PATTERNS):
        violations.append(Violation(file_label, path, 'value matches a credential-shaped pattern'))
    if _EMAIL_PATTERN.search(value) and value != REDACTED_EMAIL:
        violations.append(Violation(file_label, path, 'value contains an email that is not the redacted placeholder'))


def _walk_json(value: Any, path: str, key_cls: str | None, violations: list[Violation], file_label: str) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            child_path = f'{path}.{k}' if path else k
            cls = classify_json_key(k)
            if cls == 'unknown':
                violations.append(
                    Violation(
                        file_label,
                        child_path,
                        f"unclassified key '{k}'; add it to STRUCTURAL_JSON_KEYS or "
                        '_REDACTED_KEY_CLASS in tests/cassette_scrub.py',
                    ),
                )
            _walk_json(v, child_path, cls, violations, file_label)
        return
    if isinstance(value, list):
        for i, item in enumerate(value):
            _walk_json(item, f'{path}[{i}]', key_cls, violations, file_label)
        return
    if value is None:
        return
    _check_leaf_patterns(value, path, violations, file_label)
    if key_cls in REDACTED_PLACEHOLDERS and value != REDACTED_PLACEHOLDERS[key_cls]:
        violations.append(Violation(file_label, path, 'redacted-class key holds a value other than its placeholder'))


def _check_headers(
    headers: dict[str, Any],
    violations: list[Violation],
    file_label: str,
    direction: str,
) -> None:
    for name, values in headers.items():
        cls = classify_header(name)
        label = f'{direction} header {name!r}'
        if cls == 'drop':
            violations.append(Violation(file_label, label, 'sensitive header survived scrubbing'))
            continue
        if cls == 'unknown':
            violations.append(
                Violation(
                    file_label,
                    label,
                    f"unclassified header '{name}'; add it to STRUCTURAL_HEADERS or the drop rules "
                    'in tests/cassette_scrub.py',
                ),
            )
        for value in values if isinstance(values, list) else [values]:
            _check_leaf_patterns(value, label, violations, file_label)


def _check_body(body: Any, violations: list[Violation], file_label: str, direction: str) -> None:
    string = body.get('string') if isinstance(body, dict) else body
    if not string:
        return
    text = string.decode('utf-8') if isinstance(string, bytes) else string
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        _check_leaf_patterns(text, f'{direction} body (non-JSON)', violations, file_label)
        return
    _walk_json(parsed, direction, None, violations, file_label)


def verify_cassette(path: Path) -> list[Violation]:
    """Return every classification or leak violation found in one cassette file."""
    violations: list[Violation] = []
    file_label = str(path)
    data = yaml.safe_load(path.read_text(encoding='utf-8')) or {}
    for i, interaction in enumerate(data.get('interactions', [])):
        request = interaction.get('request') or {}
        response = interaction.get('response') or {}
        _check_headers(request.get('headers') or {}, violations, file_label, f'interaction {i} request')
        _check_headers(response.get('headers') or {}, violations, file_label, f'interaction {i} response')
        _check_body(request.get('body'), violations, file_label, f'interaction {i} request')
        _check_body(response.get('body'), violations, file_label, f'interaction {i} response')
    return violations


def find_cassettes(root: Path = Path()) -> list[Path]:
    """Return every cassette YAML file under `root`, matching the pre-commit hook's scope."""
    return sorted(p for p in root.rglob('*.yaml') if p.parent.name == CASSETTE_DIR_NAME)


def main() -> int:
    """Verify every cassette on disk. Exit non-zero on any unclassified key or leaked value."""
    cassette_paths = find_cassettes()
    violations = [violation for path in cassette_paths for violation in verify_cassette(path)]
    if violations:
        for violation in violations:
            print(f'{violation.file}: {violation.path}: {violation.message}', file=sys.stderr)  # noqa: T201
        print(f'\n{len(violations)} cassette scrub violation(s). See docs/cassettes.md.', file=sys.stderr)  # noqa: T201
        return 1
    print(f'cassette-scrub: {len(cassette_paths)} cassette(s) verified clean.')  # noqa: T201
    return 0


if __name__ == '__main__':
    sys.exit(main())
