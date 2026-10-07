"""Render a frame as a GitHub-flavored markdown table."""

from __future__ import annotations

import polars as pl

_MISSING = ''


def _cell(value: object) -> str:
    if value is None:
        return _MISSING
    text = f'{value:g}' if isinstance(value, float) else str(value)
    return text.replace('|', '\\|').replace('\n', ' ')


def frame_to_markdown(frame: pl.DataFrame, *, empty: str = '_none_') -> str:
    """Render a frame as a markdown table, or `empty` when it has no rows."""
    if not frame.width:
        return empty
    header = [_cell(name) for name in frame.columns]
    rows = [[_cell(value) for value in row] for row in frame.iter_rows()]
    if not rows:
        return empty
    widths = [max(len(header[idx]), *(len(row[idx]) for row in rows)) for idx in range(frame.width)]
    lines = [
        '| ' + ' | '.join(name.ljust(widths[idx]) for idx, name in enumerate(header)) + ' |',
        '| ' + ' | '.join('-' * widths[idx] for idx in range(frame.width)) + ' |',
    ]
    lines.extend('| ' + ' | '.join(value.ljust(widths[idx]) for idx, value in enumerate(row)) + ' |' for row in rows)
    return '\n'.join(lines)


def sections_to_markdown(sections: list[tuple[str, pl.DataFrame | str]], *, level: int = 2) -> str:
    """Render titled frames as consecutive markdown sections; a `str` body emits verbatim."""
    prefix = '#' * level
    return '\n\n'.join(
        f'{prefix} {title}\n\n{body if isinstance(body, str) else frame_to_markdown(body)}'
        for title, body in sections
    )
