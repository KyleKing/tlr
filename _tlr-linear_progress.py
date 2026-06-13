#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx",
# ]
# ///
"""Generate a progress report for Linear projects.

Usage:
    ./linear_progress.py "Project Name" --days 7
    ./linear_progress.py "Project 1" "Project 2" --days 14

Requirements:
    - API key stored in Mac Keychain (will prompt to add if not found)
    - uv installed (https://docs.astral.sh/uv/)
"""

from __future__ import annotations

import argparse
import getpass
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from textwrap import dedent
from typing import Any

import httpx

LINEAR_API_URL = "https://api.linear.app/graphql"
KEYCHAIN_SERVICE = "linear-progress-report"
KEYCHAIN_ACCOUNT = "api-key"


def _get_api_key_from_keychain() -> str | None:
    """Retrieve API key from Mac Keychain."""
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError:
        return None


def _store_api_key_in_keychain(api_key: str) -> bool:
    """Store API key in Mac Keychain."""
    try:
        subprocess.run(
            ["security", "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", api_key],
            check=True,
            capture_output=True,
        )
        return True
    except subprocess.CalledProcessError:
        try:
            subprocess.run(
                ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["security", "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", api_key],
                check=True,
                capture_output=True,
            )
            return True
        except subprocess.CalledProcessError:
            return False


def _get_or_prompt_api_key() -> str | None:
    """Get API key from keychain or prompt user to enter one."""
    if api_key := _get_api_key_from_keychain():
        return api_key

    print("No Linear API key found in Keychain.", file=sys.stderr)
    print("Get your API key from: https://linear.app/settings/api", file=sys.stderr)
    print("", file=sys.stderr)

    api_key = getpass.getpass("Enter your Linear API key: ")
    if not api_key:
        return None

    if _store_api_key_in_keychain(api_key):
        print("API key stored in Keychain.", file=sys.stderr)
    else:
        print("Warning: Failed to store API key in Keychain.", file=sys.stderr)

    return api_key


@dataclass
class IssueRef:
    """A reference to an issue (for relationships)."""

    identifier: str
    title: str


@dataclass
class CreatedIssue:
    """An issue created during the time period."""

    identifier: str
    title: str
    url: str
    status: str | None = None
    status_type: str | None = None
    assignee: str | None = None
    cycle: str | None = None
    priority: int | None = None
    estimate: float | None = None
    labels: list[str] = field(default_factory=list)
    parent: IssueRef | None = None
    children: list[IssueRef] = field(default_factory=list)
    blocks: list[IssueRef] = field(default_factory=list)
    blocked_by: list[IssueRef] = field(default_factory=list)


@dataclass
class IssueChange:
    """Tracks changes to an issue over the time period."""

    identifier: str
    title: str
    url: str
    initial_status: str | None = None
    final_status: str | None = None
    initial_cycle: str | None = None
    final_cycle: str | None = None
    initial_assignee: str | None = None
    final_assignee: str | None = None
    initial_priority: int | None = None
    final_priority: int | None = None
    initial_estimate: float | None = None
    final_estimate: float | None = None
    labels_added: list[str] = field(default_factory=list)
    labels_removed: list[str] = field(default_factory=list)
    current_status: str | None = None
    current_status_type: str | None = None
    parent: IssueRef | None = None
    children: list[IssueRef] = field(default_factory=list)
    blocks: list[IssueRef] = field(default_factory=list)
    blocked_by: list[IssueRef] = field(default_factory=list)

    def has_changes(self) -> bool:
        return any([
            self.initial_status != self.final_status and self.final_status is not None,
            self.initial_cycle != self.final_cycle and self.final_cycle is not None,
            self.initial_assignee != self.final_assignee and self.final_assignee is not None,
            self.initial_priority != self.final_priority and self.final_priority is not None,
            self.initial_estimate != self.final_estimate and self.final_estimate is not None,
            self.labels_added,
            self.labels_removed,
        ])


def _gql_request(api_key: str, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
    """Execute a GraphQL request against Linear API."""
    headers = {
        "Authorization": api_key,
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {"query": query}
    if variables:
        payload["variables"] = variables

    with httpx.Client(timeout=30.0) as client:
        response = client.post(LINEAR_API_URL, json=payload, headers=headers)
        response.raise_for_status()
        result = response.json()

    if "errors" in result:
        error_messages = [e.get("message", str(e)) for e in result["errors"]]
        raise RuntimeError(f"GraphQL errors: {'; '.join(error_messages)}")

    return result.get("data", {})


def _find_project(api_key: str, project_query: str) -> dict[str, Any] | None:
    """Find a project by name or slug (case-insensitive partial match)."""
    query = dedent("""\
        query Projects($filter: ProjectFilter) {
            projects(filter: $filter, first: 50) {
                nodes {
                    id
                    name
                    slugId
                    state
                }
            }
        }""")

    data = _gql_request(api_key, query, {"filter": {"name": {"containsIgnoreCase": project_query}}})
    projects = data.get("projects", {}).get("nodes", [])

    if not projects:
        data = _gql_request(api_key, query, {"filter": {"slugId": {"containsIgnoreCase": project_query}}})
        projects = data.get("projects", {}).get("nodes", [])

    if not projects:
        return None
    if len(projects) == 1:
        return projects[0]

    for proj in projects:
        if proj["name"].lower() == project_query.lower() or proj["slugId"].lower() == project_query.lower():
            return proj

    return projects[0]


def _get_project_issues(api_key: str, project_id: str) -> list[dict[str, Any]]:
    """Get all issues for a project."""
    query = dedent("""\
        query ProjectIssues($projectId: String!, $after: String) {
            issues(
                filter: { project: { id: { eq: $projectId } } }
                first: 100
                after: $after
            ) {
                pageInfo {
                    hasNextPage
                    endCursor
                }
                nodes {
                    id
                    identifier
                    title
                    url
                    createdAt
                    state {
                        id
                        name
                        type
                    }
                    assignee {
                        id
                        name
                    }
                    cycle {
                        id
                        name
                        number
                    }
                    priority
                    estimate
                    labels {
                        nodes {
                            id
                            name
                        }
                    }
                    parent {
                        id
                        identifier
                        title
                    }
                    children {
                        nodes {
                            id
                            identifier
                            title
                        }
                    }
                    relations {
                        nodes {
                            type
                            relatedIssue {
                                id
                                identifier
                                title
                            }
                        }
                    }
                }
            }
        }""")

    all_issues: list[dict[str, Any]] = []
    cursor: str | None = None

    while True:
        variables: dict[str, Any] = {"projectId": project_id}
        if cursor:
            variables["after"] = cursor

        data = _gql_request(api_key, query, variables)
        issues_data = data.get("issues", {})
        all_issues.extend(issues_data.get("nodes", []))

        page_info = issues_data.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        cursor = page_info.get("endCursor")

    return all_issues


def _get_issue_history(api_key: str, issue_id: str, since: datetime) -> list[dict[str, Any]]:
    """Get history entries for an issue since a given date."""
    query = dedent("""\
        query IssueHistory($issueId: String!, $after: String) {
            issue(id: $issueId) {
                history(first: 100, after: $after) {
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                    nodes {
                        id
                        createdAt
                        fromState { id name }
                        toState { id name }
                        fromCycle { id name number }
                        toCycle { id name number }
                        fromAssignee { id name }
                        toAssignee { id name }
                        fromPriority
                        toPriority
                        fromEstimate
                        toEstimate
                        addedLabelIds
                        removedLabelIds
                    }
                }
            }
        }""")

    all_history: list[dict[str, Any]] = []
    cursor: str | None = None

    while True:
        variables: dict[str, Any] = {"issueId": issue_id}
        if cursor:
            variables["after"] = cursor

        data = _gql_request(api_key, query, variables)
        issue_data = data.get("issue")
        if not issue_data:
            break

        history_data = issue_data.get("history", {})
        nodes = history_data.get("nodes", [])

        for node in nodes:
            created_at = datetime.fromisoformat(node["createdAt"].replace("Z", "+00:00"))
            if created_at >= since:
                all_history.append(node)

        page_info = history_data.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        cursor = page_info.get("endCursor")

    return sorted(all_history, key=lambda h: h["createdAt"])


def _get_labels_by_ids(api_key: str, label_ids: list[str]) -> dict[str, str]:
    """Fetch label names by their IDs."""
    if not label_ids:
        return {}

    query = dedent("""\
        query Labels {
            issueLabels(first: 250) {
                nodes {
                    id
                    name
                }
            }
        }""")

    data = _gql_request(api_key, query)
    labels = data.get("issueLabels", {}).get("nodes", [])
    return {label["id"]: label["name"] for label in labels}


def _priority_name(priority: int | None) -> str:
    """Convert priority number to human-readable name."""
    priority_map = {
        0: "None",
        1: "Urgent",
        2: "High",
        3: "Medium",
        4: "Low",
    }
    return priority_map.get(priority, "Unknown") if priority is not None else "None"


def _cycle_display(cycle: dict[str, Any] | None) -> str | None:
    """Format cycle for display."""
    if not cycle:
        return None
    name = cycle.get("name")
    number = cycle.get("number")
    if name:
        return name
    if number:
        return f"Cycle {number}"
    return "Unknown Cycle"


def _extract_relationships(
    issue: dict[str, Any],
) -> tuple[IssueRef | None, list[IssueRef], list[IssueRef], list[IssueRef]]:
    """Extract parent, children, blocks, and blocked_by from issue data."""
    parent: IssueRef | None = None
    if parent_data := issue.get("parent"):
        parent = IssueRef(identifier=parent_data["identifier"], title=parent_data["title"])

    children: list[IssueRef] = []
    for child in issue.get("children", {}).get("nodes", []):
        children.append(IssueRef(identifier=child["identifier"], title=child["title"]))

    blocks: list[IssueRef] = []
    blocked_by: list[IssueRef] = []
    for relation in issue.get("relations", {}).get("nodes", []):
        related = relation.get("relatedIssue")
        if not related:
            continue
        ref = IssueRef(identifier=related["identifier"], title=related["title"])
        match relation.get("type"):
            case "blocks":
                blocks.append(ref)
            case "blocked":
                blocked_by.append(ref)

    return parent, children, blocks, blocked_by


def _process_issue_changes(
    api_key: str,
    issues: list[dict[str, Any]],
    since: datetime,
) -> list[IssueChange]:
    """Process all issues and their history to compute net changes."""
    all_label_ids: set[str] = set()
    issue_histories: dict[str, list[dict[str, Any]]] = {}

    for issue in issues:
        history = _get_issue_history(api_key, issue["id"], since)
        issue_histories[issue["id"]] = history

        for entry in history:
            all_label_ids.update(entry.get("addedLabelIds") or [])
            all_label_ids.update(entry.get("removedLabelIds") or [])

    label_names = _get_labels_by_ids(api_key, list(all_label_ids))
    changes: list[IssueChange] = []

    for issue in issues:
        history = issue_histories[issue["id"]]
        if not history:
            continue

        parent, children, blocks, blocked_by = _extract_relationships(issue)
        change = IssueChange(
            identifier=issue["identifier"],
            title=issue["title"],
            url=issue["url"],
            current_status=issue["state"]["name"] if issue.get("state") else None,
            current_status_type=issue["state"]["type"] if issue.get("state") else None,
            parent=parent,
            children=children,
            blocks=blocks,
            blocked_by=blocked_by,
        )

        for entry in history:
            if (from_state := entry.get("fromState")) and change.initial_status is None:
                change.initial_status = from_state["name"]
            if to_state := entry.get("toState"):
                change.final_status = to_state["name"]

            if (from_cycle := entry.get("fromCycle")) and change.initial_cycle is None:
                change.initial_cycle = _cycle_display(from_cycle)
            if to_cycle := entry.get("toCycle"):
                change.final_cycle = _cycle_display(to_cycle)

            if (from_assignee := entry.get("fromAssignee")) and change.initial_assignee is None:
                change.initial_assignee = from_assignee["name"]
            if to_assignee := entry.get("toAssignee"):
                change.final_assignee = to_assignee["name"]

            if (from_priority := entry.get("fromPriority")) is not None and change.initial_priority is None:
                change.initial_priority = from_priority
            if (to_priority := entry.get("toPriority")) is not None:
                change.final_priority = to_priority

            if (from_estimate := entry.get("fromEstimate")) is not None and change.initial_estimate is None:
                change.initial_estimate = from_estimate
            if (to_estimate := entry.get("toEstimate")) is not None:
                change.final_estimate = to_estimate

            for label_id in entry.get("addedLabelIds") or []:
                if (label_name := label_names.get(label_id)):
                    if label_name in change.labels_removed:
                        change.labels_removed.remove(label_name)
                    elif label_name not in change.labels_added:
                        change.labels_added.append(label_name)

            for label_id in entry.get("removedLabelIds") or []:
                if (label_name := label_names.get(label_id)):
                    if label_name in change.labels_added:
                        change.labels_added.remove(label_name)
                    elif label_name not in change.labels_removed:
                        change.labels_removed.append(label_name)

        if change.has_changes():
            changes.append(change)

    return changes


def _extract_created_issues(issues: list[dict[str, Any]], since: datetime) -> list[CreatedIssue]:
    """Extract issues created during the time period."""
    created: list[CreatedIssue] = []

    for issue in issues:
        created_at = datetime.fromisoformat(issue["createdAt"].replace("Z", "+00:00"))
        if created_at >= since:
            labels = [label["name"] for label in issue.get("labels", {}).get("nodes", [])]
            parent, children, blocks, blocked_by = _extract_relationships(issue)
            created.append(CreatedIssue(
                identifier=issue["identifier"],
                title=issue["title"],
                url=issue["url"],
                status=issue["state"]["name"] if issue.get("state") else None,
                status_type=issue["state"]["type"] if issue.get("state") else None,
                assignee=issue["assignee"]["name"] if issue.get("assignee") else None,
                cycle=_cycle_display(issue.get("cycle")),
                priority=issue.get("priority"),
                estimate=issue.get("estimate"),
                labels=labels,
                parent=parent,
                children=children,
                blocks=blocks,
                blocked_by=blocked_by,
            ))

    return created


def _format_change_line(label: str, from_val: Any, to_val: Any) -> str:
    """Format a single change line."""
    if from_val is None:
        return f"  - {label}: {to_val}"
    return f"  - {label}: {from_val} -> {to_val}"


def _format_relationships(
    parent: IssueRef | None,
    children: list[IssueRef],
    blocks: list[IssueRef],
    blocked_by: list[IssueRef],
) -> list[str]:
    """Format relationship lines for markdown output."""
    lines: list[str] = []

    if parent:
        lines.append(f"  - Parent: {parent.identifier} ({parent.title})")

    if children:
        child_refs = ", ".join(c.identifier for c in children)
        lines.append(f"  - Subissues: {child_refs}")

    if blocked_by:
        blocker_refs = ", ".join(b.identifier for b in blocked_by)
        lines.append(f"  - Blocked by: {blocker_refs}")

    if blocks:
        blocking_refs = ", ".join(b.identifier for b in blocks)
        lines.append(f"  - Blocks: {blocking_refs}")

    return lines


def _generate_markdown(
    project_name: str,
    changes: list[IssueChange],
    created: list[CreatedIssue],
    since: datetime,
    until: datetime,
) -> str:
    """Generate markdown report from changes."""
    lines = [
        f"# Project Progress: {project_name}",
        f"**Period**: {since.strftime('%b %d, %Y')} - {until.strftime('%b %d, %Y')}",
        "",
    ]

    created_ids = {c.identifier for c in created}

    completed: list[IssueChange] = []
    in_progress: list[IssueChange] = []
    other: list[IssueChange] = []

    for change in changes:
        if change.identifier in created_ids:
            continue
        status_type = change.current_status_type
        if status_type == "completed":
            completed.append(change)
        elif status_type == "started":
            in_progress.append(change)
        else:
            other.append(change)

    def _render_created_section() -> None:
        if not created:
            return
        lines.append(f"## Created ({len(created)})")
        lines.append("")
        for issue in sorted(created, key=lambda c: c.identifier):
            lines.append(f"- **[{issue.identifier}]({issue.url})**: {issue.title}")

            details: list[str] = []
            if issue.status:
                details.append(f"Status: {issue.status}")
            if issue.assignee:
                details.append(f"Assignee: {issue.assignee}")
            if issue.cycle:
                details.append(f"Cycle: {issue.cycle}")
            if issue.priority and issue.priority > 0:
                details.append(f"Priority: {_priority_name(issue.priority)}")

            if details:
                lines.append(f"  - {' | '.join(details)}")
            if issue.labels:
                lines.append(f"  - Labels: {', '.join(issue.labels)}")
            lines.extend(_format_relationships(issue.parent, issue.children, issue.blocks, issue.blocked_by))

            lines.append("")

    def _render_change_section(title: str, items: list[IssueChange]) -> None:
        if not items:
            return
        lines.append(f"## {title} ({len(items)})")
        lines.append("")
        for change in sorted(items, key=lambda c: c.identifier):
            lines.append(f"- **[{change.identifier}]({change.url})**: {change.title}")

            if change.final_status and change.initial_status != change.final_status:
                lines.append(_format_change_line("Status", change.initial_status, change.final_status))

            if change.final_assignee and change.initial_assignee != change.final_assignee:
                lines.append(_format_change_line("Assignee", change.initial_assignee, change.final_assignee))

            if change.final_cycle is not None:
                if change.initial_cycle != change.final_cycle:
                    if change.initial_cycle is None:
                        lines.append(f"  - Added to Cycle: {change.final_cycle}")
                    elif change.final_cycle == "None":
                        lines.append(f"  - Removed from Cycle: {change.initial_cycle}")
                    else:
                        lines.append(_format_change_line("Cycle", change.initial_cycle, change.final_cycle))

            if change.final_priority is not None and change.initial_priority != change.final_priority:
                lines.append(_format_change_line(
                    "Priority",
                    _priority_name(change.initial_priority),
                    _priority_name(change.final_priority),
                ))

            if change.final_estimate is not None and change.initial_estimate != change.final_estimate:
                lines.append(_format_change_line("Estimate", change.initial_estimate, change.final_estimate))

            if change.labels_added:
                lines.append(f"  - Labels added: {', '.join(change.labels_added)}")
            if change.labels_removed:
                lines.append(f"  - Labels removed: {', '.join(change.labels_removed)}")
            lines.extend(_format_relationships(change.parent, change.children, change.blocks, change.blocked_by))

            lines.append("")

    _render_created_section()
    _render_change_section("Completed", completed)
    _render_change_section("In Progress", in_progress)
    _render_change_section("Other Changes", other)

    if not any([created, completed, in_progress, other]):
        lines.append("*No changes found in the specified time period.*")
        lines.append("")

    return "\n".join(lines)


def _process_single_project(
    api_key: str,
    project_query: str,
    since: datetime,
    until: datetime,
) -> str | None:
    """Process a single project and return markdown, or None if not found."""
    print(f"Searching for project: {project_query}...", file=sys.stderr)
    if not (project := _find_project(api_key, project_query)):
        print(f"Warning: No project found matching '{project_query}'", file=sys.stderr)
        return None

    project_name = project["name"]
    project_id = project["id"]
    print(f"Found project: {project_name}", file=sys.stderr)

    print(f"Fetching issues...", file=sys.stderr)
    issues = _get_project_issues(api_key, project_id)
    print(f"Found {len(issues)} issues", file=sys.stderr)

    print(f"Processing history...", file=sys.stderr)
    created = _extract_created_issues(issues, since)
    changes = _process_issue_changes(api_key, issues, since)
    print(f"Found {len(created)} created, {len(changes)} with changes", file=sys.stderr)

    return _generate_markdown(project_name, changes, created, since, until)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate a progress report for Linear projects.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=dedent("""\
            Examples:
              %(prog)s "My Project"
              %(prog)s "Project 1" "Project 2" --days 14
              %(prog)s "ENG" "INFRA" --days 3

            API Key:
              Stored in Mac Keychain. Will prompt to add if not found."""),
    )
    parser.add_argument(
        "projects",
        nargs="+",
        metavar="PROJECT",
        help="Project name(s) or slug(s) to generate report for",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Number of days to look back (default: 7)",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="Output file path (default: stdout)",
    )

    args = parser.parse_args()

    if not (api_key := _get_or_prompt_api_key()):
        print("Error: No API key provided", file=sys.stderr)
        return 1

    until = datetime.now(UTC)
    since = until - timedelta(days=args.days)

    print(f"Generating report for last {args.days} days...", file=sys.stderr)
    print("", file=sys.stderr)

    reports: list[str] = []
    for project_query in args.projects:
        if markdown := _process_single_project(api_key, project_query, since, until):
            reports.append(markdown)
        print("", file=sys.stderr)

    if not reports:
        print("Error: No valid projects found", file=sys.stderr)
        return 1

    combined = "\n---\n\n".join(reports)

    if args.output:
        with open(args.output, "w") as f:
            f.write(combined)
        print(f"Report written to: {args.output}", file=sys.stderr)
    else:
        print(combined)

    return 0


if __name__ == "__main__":
    sys.exit(main())
