"""Tests for tlr.http."""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest

from tlr.http import (
    MAX_ATTEMPTS,
    MAX_BACKOFF_SECONDS,
    SlidingWindowLimiter,
    _backoff_seconds,
    request_with_retry,
)


def _responder(statuses: Iterator[int], headers: Iterator[dict[str, str]] | None = None) -> httpx.MockTransport:
    def _handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(next(statuses), headers=next(headers) if headers else {})

    return httpx.MockTransport(_handle)


def _client(transport: httpx.MockTransport) -> httpx.Client:
    return httpx.Client(transport=transport, base_url='https://example.test')


def _recording_sleep() -> tuple[list[float], object]:
    delays: list[float] = []

    def _sleep(seconds: float) -> None:
        delays.append(seconds)

    return delays, _sleep


@pytest.mark.parametrize(
    ('statuses', 'expected_final_status', 'expected_sleep_count'),
    [
        ([200], 200, 0),
        ([404], 404, 0),
        ([429, 200], 200, 1),
        ([500, 500, 200], 200, 2),
        ([500, 500, 500], 500, 2),
        ([429, 503, 502], 502, 2),
    ],
)
def test_retry_matrix(statuses: list[int], expected_final_status: int, expected_sleep_count: int) -> None:
    delays, sleep = _recording_sleep()
    client = _client(_responder(iter(statuses)))
    response = request_with_retry(client, 'GET', '/thing', sleep=sleep)
    assert response.status_code == expected_final_status
    assert len(delays) == expected_sleep_count


def test_non_retryable_4xx_returns_on_first_attempt_without_sleeping() -> None:
    calls = 0

    def _handle(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(403)

    delays, sleep = _recording_sleep()
    client = _client(httpx.MockTransport(_handle))
    response = request_with_retry(client, 'GET', '/thing', sleep=sleep)
    assert response.status_code == httpx.codes.FORBIDDEN
    assert calls == 1
    assert delays == []


def test_transport_failure_all_attempts_raises() -> None:
    calls = 0

    def _handle(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectError('boom')

    delays, sleep = _recording_sleep()
    client = _client(httpx.MockTransport(_handle))
    with pytest.raises(httpx.ConnectError):
        request_with_retry(client, 'GET', '/thing', sleep=sleep)
    assert calls == MAX_ATTEMPTS
    assert len(delays) == MAX_ATTEMPTS - 1


def test_transport_failure_then_success_returns_the_response() -> None:
    attempts = iter([httpx.ConnectError('boom'), None])

    def _handle(request: httpx.Request) -> httpx.Response:
        outcome = next(attempts)
        if outcome is not None:
            raise outcome
        return httpx.Response(200)

    delays, sleep = _recording_sleep()
    client = _client(httpx.MockTransport(_handle))
    response = request_with_retry(client, 'GET', '/thing', sleep=sleep)
    assert response.status_code == httpx.codes.OK
    assert len(delays) == 1


def test_retry_after_overrides_computed_backoff() -> None:
    delays, sleep = _recording_sleep()
    client = _client(_responder(iter([429, 200]), iter([{'retry-after': '7'}, {}])))
    response = request_with_retry(client, 'GET', '/thing', sleep=sleep)
    assert response.status_code == httpx.codes.OK
    assert delays == [7.0]


def test_retry_after_is_capped_at_max_backoff() -> None:
    delays, sleep = _recording_sleep()
    client = _client(_responder(iter([429, 200]), iter([{'retry-after': '9999'}, {}])))
    request_with_retry(client, 'GET', '/thing', sleep=sleep)
    assert delays == [MAX_BACKOFF_SECONDS]


def test_non_positive_retry_after_falls_back_to_computed_backoff() -> None:
    delays, sleep = _recording_sleep()
    client = _client(_responder(iter([429, 200]), iter([{'retry-after': '0'}, {}])))
    request_with_retry(client, 'GET', '/thing', sleep=sleep)
    assert delays == [_backoff_seconds(1)]


@pytest.mark.parametrize(('attempt', 'expected'), [(1, 0.5), (2, 1.0), (3, 2.0), (7, MAX_BACKOFF_SECONDS)])
def test_backoff_seconds_doubles_and_caps(attempt: int, expected: float) -> None:
    assert _backoff_seconds(attempt) == expected


def test_sliding_window_limiter_waits_until_oldest_call_falls_out() -> None:
    now = [0.0]
    sleeps: list[float] = []

    def _clock() -> float:
        return now[0]

    def _sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    limiter = SlidingWindowLimiter(max_calls=2, window_seconds=60.0, clock=_clock, sleep=_sleep)
    limiter.acquire()
    now[0] += 10
    limiter.acquire()
    limiter.acquire()

    assert sleeps == [50.0]


def test_sliding_window_limiter_allows_calls_once_window_has_passed_naturally() -> None:
    now = [0.0]

    def _clock() -> float:
        return now[0]

    def _sleep(_seconds: float) -> None:
        pytest.fail('should not need to sleep when the window already passed')

    limiter = SlidingWindowLimiter(max_calls=1, window_seconds=60.0, clock=_clock, sleep=_sleep)
    limiter.acquire()
    now[0] += 61
    limiter.acquire()
