"""Pytest configuration."""

from pathlib import Path
from typing import Any

import pytest

from .cassette_scrub import DROPPED_HEADERS, scrub_request, scrub_response
from .configuration import TEST_TMP_CACHE, clear_test_cache


@pytest.fixture(scope='session')
def vcr_config() -> dict[str, Any]:
    """Wire cassette scrubbing into pytest-recording so an unscrubbed cassette never hits disk."""
    return {
        'record_mode': 'once',
        'match_on': ['method', 'scheme', 'host', 'port', 'path', 'query'],
        'filter_headers': sorted(DROPPED_HEADERS),
        'decode_compressed_response': True,
        'before_record_request': scrub_request,
        'before_record_response': scrub_response,
    }


@pytest.fixture
def fix_test_cache() -> Path:
    """Fixture to clear and return the test cache directory for use.

    Returns:
        Path: Path to the test cache directory

    """
    clear_test_cache()
    return TEST_TMP_CACHE
