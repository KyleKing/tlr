"""Argument parsing for the tlr command line."""

from __future__ import annotations

import argparse

from tlr import __pkg_name__, __version__

FORMATS = ('json', 'md')


def _add_format(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--format', choices=FORMATS, default='json', help='output format (default: json)')


def build_parser() -> argparse.ArgumentParser:
    """Build the top-level parser with every subcommand attached."""
    parser = argparse.ArgumentParser(
        prog=__pkg_name__,
        description='Triage, capacity, and goals for a tech lead, from Linear and Pylon',
    )
    parser.add_argument('--version', action='version', version=f'%(prog)s {__version__}')
    parser.add_argument('--config', metavar='PATH', help='config file to read instead of the default XDG path')
    parser.add_argument('--db', metavar='PATH', help='DuckDB file to read instead of the configured one')
    parser.add_argument('-v', '--verbose', action='count', default=0, help='raise log verbosity (repeatable)')

    sub = parser.add_subparsers(dest='command', metavar='<command>')

    refresh = sub.add_parser('refresh', help='fetch from every configured source into the local store')
    refresh.add_argument('--source', action='append', metavar='NAME', help='limit to one source (repeatable)')
    refresh.add_argument('--dry-run', action='store_true', help='report what would be fetched and write nothing')

    capacity = sub.add_parser('capacity', help='points allocated and delivered per person per cycle')
    capacity.add_argument('--cycle', type=int, metavar='N', help='cycle number (default: the current one)')
    capacity.add_argument('--person', action='append', metavar='NAME', help='limit to one person (repeatable)')
    _add_format(capacity)

    triage = sub.add_parser('triage', help='one ordered queue across Pylon and Linear')
    triage.add_argument('--limit', type=int, default=25, metavar='N', help='rows to show (default: 25)')
    triage.add_argument('--include-excluded', action='store_true', help='list rows held out of the ordering')
    _add_format(triage)

    backlog = sub.add_parser('backlog', help='backlog age, close times, and resolved split')
    _add_format(backlog)

    snapshot = sub.add_parser(
        'snapshot',
        help='weekly/monthly picture of Linear, Pylon, and Sentry for a team check-in',
        description=(
            'A weekly or monthly picture of Linear, Pylon, and (when configured) Sentry, for a '
            'team check-in, compared against the period immediately before it.\n\n'
            "Reconstruction limits: Pylon's open-at-a-past-instant counts assume resolution_time "
            'is set once and never cleared, so a reopened-then-resolved ticket undercounts as '
            "having been open the whole time. Linear's equivalent reads completed_at/canceled_at, "
            'which Linear clears to null on reopen, so the same undercount applies there too. '
            'Priority carries no timestamp in either source as stored here, so "crossed a '
            'priority upward" and ticket reopens are not computed at all: both need a snapshot '
            'from a prior run to diff against, and none is persisted.'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    snapshot.add_argument('--period', choices=('week', 'month'), default='week', help='period length (default: week)')
    snapshot.add_argument(
        '--as-of',
        metavar='DATE',
        help='ISO date (YYYY-MM-DD) the period is computed around (default: today)',
    )
    _add_format(snapshot)

    config = sub.add_parser('config', help='show or create the config file')
    config.add_argument('action', choices=('path', 'init', 'show'), help='what to do')

    imports = sub.add_parser('import-snapshots', help='one-time import of the Deno milestone-scope history')
    imports.add_argument('sqlite_path', metavar='PATH', help='path to the Deno tlr.sqlite file')
    imports.add_argument('--dry-run', action='store_true', help='report what would be imported and write nothing')

    return parser
