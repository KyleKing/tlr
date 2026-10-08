"""Cassette layout for the recorded adapter tests in this package."""

from pathlib import Path

import pytest

from tlr.secrets import read_secret


@pytest.fixture(scope='module')
def vcr_cassette_dir(request: pytest.FixtureRequest) -> str:
    """Write cassettes directly under `cassettes/`, where `cassette_scrub.find_cassettes` looks."""
    return str(Path(str(request.node.fspath)).parent / 'cassettes')


def secret_or_placeholder(name: str) -> str:
    """Return the real secret when one is configured (recording), else a placeholder (replay).

    The placeholder is enough on replay: cassettes match on method and URL, not headers.
    """
    try:
        return read_secret(name)
    except LookupError:
        return 'placeholder'
