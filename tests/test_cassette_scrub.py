"""Tests for cassette scrubbing and verification."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .cassette_scrub import (
    REDACTED_EMAIL,
    REDACTED_TEXT,
    REDACTED_UUID,
    classify_header,
    classify_json_key,
    find_cassettes,
    main,
    scrub_json,
    scrub_request,
    scrub_response,
    verify_cassette,
)


@dataclass
class _FakeRequest:
    headers: dict[str, str]
    body: str


def _cassette_text(
    *,
    request_headers: dict[str, Any],
    request_body: dict[str, Any],
    response_headers: dict[str, Any],
    response_body: dict[str, Any],
) -> str:
    interaction = {
        'request': {
            'body': {'string': json.dumps(request_body)},
            'headers': request_headers,
            'method': 'POST',
            'uri': 'https://api.linear.app/graphql',
        },
        'response': {
            'body': {'string': json.dumps(response_body)},
            'headers': response_headers,
            'status': {'code': 200, 'message': 'OK'},
        },
    }
    return yaml.safe_dump({'interactions': [interaction], 'version': 1})


def _clean_cassette(tmp_path: Path) -> Path:
    cassette_dir = tmp_path / 'cassettes'
    cassette_dir.mkdir()
    path = cassette_dir / 'clean.yaml'
    path.write_text(
        _cassette_text(
            request_headers={'Content-Type': ['application/json']},
            request_body={'query': 'query { viewer { id } }'},
            response_headers={'Content-Type': ['application/json']},
            response_body={
                'data': {
                    'id': REDACTED_UUID,
                    'name': REDACTED_TEXT,
                    'email': REDACTED_EMAIL,
                    'estimate': 3,
                    'hasNextPage': False,
                },
            },
        ),
    )
    return path


def test_classify_header_drops_raw_linear_key_with_no_bearer_prefix() -> None:
    assert classify_header('Authorization') == 'drop'
    assert classify_header('X-Api-Token') == 'drop'
    assert classify_header('Content-Type') == 'keep'
    assert classify_header('X-Totally-Unknown') == 'unknown'


def test_classify_json_key_covers_structural_and_redacted_and_unknown() -> None:
    assert classify_json_key('hasNextPage') == 'structural'
    assert classify_json_key('estimate') == 'structural'
    assert classify_json_key('id') == 'uuid'
    assert classify_json_key('email') == 'email'
    assert classify_json_key('somethingNeverSeen') == 'unknown'


def test_scrub_json_replaces_redacted_keys_and_keeps_structural_shape() -> None:
    scrubbed = scrub_json(
        {
            'id': 'real-uuid-1234',
            'estimate': 5,
            'nodes': [{'email': 'person@company.com', 'priority': 2}],
        }
    )
    assert scrubbed == {
        'id': REDACTED_UUID,
        'estimate': 5,
        'nodes': [{'email': REDACTED_EMAIL, 'priority': 2}],
    }


def test_scrub_request_drops_auth_header_and_scrubs_body() -> None:
    request = _FakeRequest(
        headers={'Authorization': 'lin_api_realsecret1234567890', 'Content-Type': 'application/json'},
        body=json.dumps({'query': 'x', 'variables': {'id': 'real-id', 'title': 'Roadmap: launch plan'}}),
    )
    scrubbed = scrub_request(request)
    assert 'Authorization' not in scrubbed.headers
    body = json.loads(scrubbed.body)
    assert body['variables']['id'] == REDACTED_UUID
    assert body['variables']['title'] == REDACTED_TEXT


def test_scrub_response_drops_auth_header_and_scrubs_body() -> None:
    response = {
        'headers': {'Set-Cookie': ['session=abc'], 'Content-Type': ['application/json']},
        'body': {'string': json.dumps({'data': {'email': 'real@company.com'}})},
    }
    scrubbed = scrub_response(response)
    assert 'Set-Cookie' not in scrubbed['headers']
    assert json.loads(scrubbed['body']['string']) == {'data': {'email': REDACTED_EMAIL}}


def test_verify_cassette_accepts_a_correctly_scrubbed_cassette(tmp_path: Path) -> None:
    assert verify_cassette(_clean_cassette(tmp_path)) == []


def test_verify_cassette_rejects_unclassified_key(tmp_path: Path) -> None:
    cassette_dir = tmp_path / 'cassettes'
    cassette_dir.mkdir()
    path = cassette_dir / 'unknown_key.yaml'
    path.write_text(
        _cassette_text(
            request_headers={'Content-Type': ['application/json']},
            request_body={'query': 'query { viewer { id } }'},
            response_headers={'Content-Type': ['application/json']},
            response_body={'data': {'id': REDACTED_UUID, 'totallyUnclassifiedField': 'value'}},
        ),
    )
    violations = verify_cassette(path)
    assert any('totallyUnclassifiedField' in v.message for v in violations)


def test_verify_cassette_rejects_surviving_auth_header(tmp_path: Path) -> None:
    cassette_dir = tmp_path / 'cassettes'
    cassette_dir.mkdir()
    path = cassette_dir / 'leaked_header.yaml'
    path.write_text(
        _cassette_text(
            request_headers={'Authorization': ['lin_api_realsecret1234567890'], 'Content-Type': ['application/json']},
            request_body={'query': 'query { viewer { id } }'},
            response_headers={'Content-Type': ['application/json']},
            response_body={'data': {'id': REDACTED_UUID}},
        ),
    )
    violations = verify_cassette(path)
    assert any('survived scrubbing' in v.message for v in violations)


def test_verify_cassette_rejects_a_credential_shaped_value(tmp_path: Path) -> None:
    cassette_dir = tmp_path / 'cassettes'
    cassette_dir.mkdir()
    path = cassette_dir / 'leaked_key.yaml'
    path.write_text(
        _cassette_text(
            request_headers={'Content-Type': ['application/json']},
            request_body={'query': 'query { viewer { id } } lin_api_realsecret1234567890'},
            response_headers={'Content-Type': ['application/json']},
            response_body={'data': {'id': REDACTED_UUID}},
        ),
    )
    violations = verify_cassette(path)
    assert any('credential-shaped' in v.message for v in violations)


def test_verify_cassette_rejects_a_real_email(tmp_path: Path) -> None:
    cassette_dir = tmp_path / 'cassettes'
    cassette_dir.mkdir()
    path = cassette_dir / 'leaked_email.yaml'
    path.write_text(
        _cassette_text(
            request_headers={'Content-Type': ['application/json']},
            request_body={'query': 'contact person@customer.com for details'},
            response_headers={'Content-Type': ['application/json']},
            response_body={'data': {'id': REDACTED_UUID}},
        ),
    )
    violations = verify_cassette(path)
    assert any('email that is not the redacted placeholder' in v.message for v in violations)


def test_find_cassettes_only_matches_cassettes_directory(tmp_path: Path) -> None:
    _clean_cassette(tmp_path)
    (tmp_path / 'not_cassettes').mkdir()
    (tmp_path / 'not_cassettes' / 'other.yaml').write_text('interactions: []\n')
    found = find_cassettes(tmp_path)
    assert [p.name for p in found] == ['clean.yaml']


def test_main_exits_nonzero_on_violation(tmp_path: Path, monkeypatch: Any) -> None:
    cassette_dir = tmp_path / 'cassettes'
    cassette_dir.mkdir()
    (cassette_dir / 'bad.yaml').write_text(
        _cassette_text(
            request_headers={'Content-Type': ['application/json']},
            request_body={'query': 'x'},
            response_headers={'Content-Type': ['application/json']},
            response_body={'data': {'unknownField': 'x'}},
        ),
    )
    monkeypatch.chdir(tmp_path)
    assert main() == 1


def test_main_exits_zero_when_clean(tmp_path: Path, monkeypatch: Any) -> None:
    _clean_cassette(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main() == 0
