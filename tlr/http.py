"""HTTP retry policy and rate limiting shared by every service adapter."""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

MAX_ATTEMPTS = 3
TIMEOUT_SECONDS = 15.0
BASE_BACKOFF_SECONDS = 0.5
MAX_BACKOFF_SECONDS = 30.0

Sleeper = Callable[[float], None]
Clock = Callable[[], float]


def _backoff_seconds(attempt: int) -> float:
    return min(BASE_BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_BACKOFF_SECONDS)


def _retry_after_seconds(response: httpx.Response) -> float | None:
    value = response.headers.get('retry-after')
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return min(seconds, MAX_BACKOFF_SECONDS) if seconds > 0 else None


def _is_retryable_status(status_code: int) -> bool:
    return status_code == httpx.codes.TOO_MANY_REQUESTS or status_code >= httpx.codes.INTERNAL_SERVER_ERROR


def request_with_retry(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    sleep: Sleeper = time.sleep,
    **kwargs: Any,
) -> httpx.Response:
    """Send one request, retrying transport failures and 429/5xx up to `MAX_ATTEMPTS` times.

    Any other 4xx is returned immediately. `Retry-After` overrides the computed
    backoff when present and positive.

    Returns the last response received even when it is a failing one, so callers
    keep their own status handling. Raises only when every attempt failed at the
    transport level, with no response ever received.
    """
    response: httpx.Response | None = None
    error: httpx.TransportError | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = client.request(method, url, timeout=TIMEOUT_SECONDS, **kwargs)
        except httpx.TransportError as err:
            error = err
        else:
            if not _is_retryable_status(response.status_code):
                return response
        if attempt < MAX_ATTEMPTS:
            delay = (_retry_after_seconds(response) if response is not None else None) or _backoff_seconds(attempt)
            sleep(delay)
    if response is not None:
        return response
    if error is not None:
        raise error
    msg = 'unreachable: MAX_ATTEMPTS is always at least 1'
    raise RuntimeError(msg)


@dataclass
class SlidingWindowLimiter:
    """A rolling window rate limiter, e.g. Pylon's 20-searches-per-minute cap."""

    max_calls: int
    window_seconds: float = 60.0
    clock: Clock = time.monotonic
    sleep: Sleeper = time.sleep
    _calls: deque[float] = field(default_factory=deque, init=False, repr=False)

    def acquire(self) -> None:
        """Block until a call is allowed under the rolling window, then record it."""
        while True:
            now = self.clock()
            while self._calls and now - self._calls[0] >= self.window_seconds:
                self._calls.popleft()
            if len(self._calls) < self.max_calls:
                self._calls.append(now)
                return
            self.sleep(self._calls[0] + self.window_seconds - now)
