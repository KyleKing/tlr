"""Command line entry point."""

from __future__ import annotations

import sys
from collections.abc import Sequence


def main(argv: Sequence[str] | None = None) -> int:
    """Parse arguments and run the requested command."""
    from tlr.cli import build_parser  # noqa: PLC0415

    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0

    from tlr.services import run  # noqa: PLC0415

    try:
        return run(args, parser)
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    sys.exit(main())
