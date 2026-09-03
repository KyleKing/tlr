"""Command line parsing."""

from __future__ import annotations

import pytest

from tlr.__main__ import main
from tlr.cli import build_parser


def test_no_command_prints_help_and_succeeds(capsys):
    assert main([]) == 0

    assert 'usage: tlr' in capsys.readouterr().out


@pytest.mark.parametrize('command', ['capacity', 'triage', 'backlog'])
def test_every_reporting_command_defaults_to_json(command):
    args = build_parser().parse_args([command])

    assert args.format == 'json'


def test_an_unknown_format_is_rejected():
    with pytest.raises(SystemExit):
        build_parser().parse_args(['capacity', '--format', 'csv'])


def test_repeatable_options_accumulate():
    args = build_parser().parse_args(['refresh', '--source', 'linear', '--source', 'pylon'])

    assert args.source == ['linear', 'pylon']
