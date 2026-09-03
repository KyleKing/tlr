"""Check that all imports work as expected in the built package."""

from pprint import pprint

from tlr.__main__ import main

pprint(locals())  # ruff:ignore[p-print]
