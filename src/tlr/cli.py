"""CLI for Tech Lead Reporter."""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from textwrap import dedent

from tlr.linear import (
    fetch_issue_history,
    fetch_labels,
    fetch_project_issues,
    find_project,
    get_api_key,
    transform_to_report,
)
from tlr.reporters import format_combined_report


def _handle_linear(args: argparse.Namespace) -> int:
    """Handle linear subcommand."""
    if not (api_key := get_api_key()):
        print("Error: No API key provided", file=sys.stderr)
        return 1

    until = datetime.now(UTC)
    since = until - timedelta(days=args.days)

    print(f"Generating report for last {args.days} days...", file=sys.stderr)
    print(file=sys.stderr)

    reports = []
    for project_query in args.projects:
        print(f"Searching for project: {project_query}...", file=sys.stderr)
        if not (project := find_project(api_key, project_query)):
            print(f"Warning: No project found matching '{project_query}'", file=sys.stderr)
            print(file=sys.stderr)
            continue

        print(f"Found project: {project.name}", file=sys.stderr)

        print("Fetching issues...", file=sys.stderr)
        issues = fetch_project_issues(api_key, project.id)
        print(f"Found {len(issues)} issues", file=sys.stderr)

        print("Processing history...", file=sys.stderr)
        histories = {}
        all_label_ids = set()

        for issue in issues:
            history = fetch_issue_history(api_key, issue.id, since)
            histories[issue.id] = history

            for entry in history:
                all_label_ids.update(entry.added_label_ids)
                all_label_ids.update(entry.removed_label_ids)

        label_names = fetch_labels(api_key) if all_label_ids else {}

        report = transform_to_report(project, issues, histories, label_names, since, until)
        reports.append(report)

        print(f"Found {len([a for a in report.activities if a.created_in_period])} created, "
              f"{len([a for a in report.activities if a.changes])} with changes", file=sys.stderr)
        print(file=sys.stderr)

    if not reports:
        print("Error: No valid projects found", file=sys.stderr)
        return 1

    combined = format_combined_report(reports)

    if args.output:
        output_path = Path(args.output)
        output_path.write_text(combined, encoding="utf-8")
        print(f"Report written to: {args.output}", file=sys.stderr)
    else:
        print(combined)

    return 0


def _create_parser() -> argparse.ArgumentParser:
    """Create argument parser."""
    parser = argparse.ArgumentParser(
        description="Tech Lead Reporter - Generate progress reports",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    subparsers = parser.add_subparsers(dest="command", required=True, help="Service to report on")

    linear_parser = subparsers.add_parser(
        "linear",
        help="Generate Linear project report",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=dedent("""\
            Examples:
              tlr linear "My Project"
              tlr linear "Project 1" "Project 2" --days 14
              tlr linear "ENG" "INFRA" --days 3 --output report.md

            API Key:
              Stored in Mac Keychain. Will prompt to add if not found."""),
    )
    linear_parser.add_argument(
        "projects",
        nargs="+",
        metavar="PROJECT",
        help="Project name(s) or slug(s) to generate report for",
    )
    linear_parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Number of days to look back (default: 7)",
    )
    linear_parser.add_argument(
        "--output",
        "-o",
        help="Output file path (default: stdout)",
    )

    return parser


def main() -> int:
    """Main entry point."""
    parser = _create_parser()
    args = parser.parse_args()

    if args.command == "linear":
        return _handle_linear(args)

    return 1


if __name__ == "__main__":
    sys.exit(main())
