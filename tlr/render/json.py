"""Render frames as JSON for an agent or a piped consumer."""

from __future__ import annotations

import json as stdlib_json
from datetime import date, datetime
from typing import Any

import polars as pl


def _scalar(value: Any) -> Any:
    if isinstance(value, datetime | date):
        return value.isoformat()
    return value


def frame_to_rows(frame: pl.DataFrame) -> list[dict[str, Any]]:
    """Return one JSON-safe dict per row, datetimes as ISO 8601 strings."""
    return [{name: _scalar(value) for name, value in row.items()} for row in frame.iter_rows(named=True)]


def frame_to_json(frame: pl.DataFrame) -> str:
    """Render a frame as a JSON array of row objects."""
    return stdlib_json.dumps(frame_to_rows(frame), indent=2, sort_keys=False)


def sections_to_json(sections: list[tuple[str, pl.DataFrame | str]]) -> str:
    """Render titled frames as one JSON object keyed by section title; `str` bodies emit verbatim."""
    return stdlib_json.dumps(
        {
            title: body if isinstance(body, str) else frame_to_rows(body)
            for title, body in sections
        },
        indent=2,
        sort_keys=False,
    )
