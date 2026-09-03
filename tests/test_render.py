"""Markdown and JSON rendering."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import polars as pl
import pytest

from tlr.render.json import frame_to_json, frame_to_rows, sections_to_json
from tlr.render.markdown import frame_to_markdown, sections_to_markdown


def test_pipes_and_newlines_cannot_break_a_row():
    frame = pl.DataFrame({'note': ['a | b\nc']})

    result = frame_to_markdown(frame)

    assert result.splitlines()[-1] == '| a \\| b c |'


@pytest.mark.parametrize(
    ('frame', 'expected'),
    [
        (pl.DataFrame({'points': [1.0, 12.5]}), ['| points |', '| ------ |', '| 1      |', '| 12.5   |']),
        (pl.DataFrame({'person': ['ana'], 'unestimated': [None]}), ['| person | unestimated |']),
    ],
    ids=['floats-trim-trailing-zeros', 'null-renders-empty'],
)
def test_cell_formatting(frame, expected):
    result = frame_to_markdown(frame)

    assert result.splitlines()[: len(expected)] == expected


def test_empty_frame_falls_back_to_a_placeholder():
    assert frame_to_markdown(pl.DataFrame({'person': []}), empty='_none_') == '_none_'


def test_sections_carry_their_own_heading():
    result = sections_to_markdown([('Capacity', pl.DataFrame({'person': ['ana']}))])

    assert result.startswith('## Capacity\n\n| person |')


def test_json_renders_datetimes_as_iso_strings():
    naive = datetime(2026, 9, 2, 14, 30, tzinfo=UTC).replace(tzinfo=None)
    frame = pl.DataFrame({'when': [naive], 'points': [3.0]})

    rows = frame_to_rows(frame)

    assert rows == [{'when': '2026-09-02T14:30:00', 'points': 3.0}]


def test_json_sections_key_on_their_title():
    result = sections_to_json([('Capacity', pl.DataFrame({'person': ['ana']}))])

    assert json.loads(result) == {'Capacity': [{'person': 'ana'}]}


@pytest.mark.parametrize('render', [frame_to_json, frame_to_markdown], ids=['json', 'markdown'])
def test_an_empty_frame_never_raises(render):
    assert render(pl.DataFrame({'person': []}))
