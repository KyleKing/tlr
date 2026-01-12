"""Markdown report generation from ProjectReport data."""

from __future__ import annotations

from tlr.models import Change, IssueActivity, IssueRef, ProjectReport


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


def _format_change_line(change: Change) -> str:
    """Format a single change line."""
    field = change.field

    if field == "priority":
        from_val = _priority_name(change.from_value) if change.from_value is not None else None
        to_val = _priority_name(change.to_value)
        if from_val is None:
            return f"  - Priority: {to_val}"
        return f"  - Priority: {from_val} -> {to_val}"

    if field == "cycle":
        if change.from_value is None:
            return f"  - Added to Cycle: {change.to_value}"
        if change.to_value == "None":
            return f"  - Removed from Cycle: {change.from_value}"
        return f"  - Cycle: {change.from_value} -> {change.to_value}"

    if field == "labels_added":
        labels = ", ".join(change.to_value)
        return f"  - Labels added: {labels}"

    if field == "labels_removed":
        labels = ", ".join(change.to_value)
        return f"  - Labels removed: {labels}"

    field_display = field.replace("_", " ").title()
    if change.from_value is None:
        return f"  - {field_display}: {change.to_value}"
    return f"  - {field_display}: {change.from_value} -> {change.to_value}"


def _format_relationships(
    parent: IssueRef | None,
    children: tuple[IssueRef, ...],
    blocks: tuple[IssueRef, ...],
    blocked_by: tuple[IssueRef, ...],
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


def format_issue_activity(activity: IssueActivity) -> str:
    """Format a single issue's activity as markdown."""
    lines: list[str] = []

    ref = activity.ref
    lines.append(f"- **[{ref.identifier}]({ref.url})**: {ref.title}")

    if activity.created_in_period and activity.current_state:
        details: list[str] = []
        state = activity.current_state
        if state.status:
            details.append(f"Status: {state.status}")
        if state.assignee:
            details.append(f"Assignee: {state.assignee}")
        if state.cycle:
            details.append(f"Cycle: {state.cycle}")
        if state.priority and state.priority > 0:
            details.append(f"Priority: {_priority_name(state.priority)}")

        if details:
            lines.append(f"  - {' | '.join(details)}")
        if state.labels:
            lines.append(f"  - Labels: {', '.join(state.labels)}")
        lines.extend(_format_relationships(state.parent, state.children, state.blocks, state.blocked_by))

    for change in activity.changes:
        lines.append(_format_change_line(change))

    if not activity.created_in_period and activity.current_state:
        lines.extend(
            _format_relationships(
                activity.current_state.parent,
                activity.current_state.children,
                activity.current_state.blocks,
                activity.current_state.blocked_by,
            )
        )

    return "\n".join(lines)


def group_by_status(activities: list[IssueActivity]) -> dict[str, list[IssueActivity]]:
    """Group activities by their current status type."""
    grouped: dict[str, list[IssueActivity]] = {
        "created": [],
        "completed": [],
        "in_progress": [],
        "other": [],
    }

    for activity in activities:
        if activity.created_in_period:
            grouped["created"].append(activity)
        elif activity.current_state:
            status_type = activity.current_state.status_type
            if status_type == "completed":
                grouped["completed"].append(activity)
            elif status_type == "started":
                grouped["in_progress"].append(activity)
            else:
                grouped["other"].append(activity)

    return grouped


def format_project_report(report: ProjectReport) -> str:
    """Generate markdown for a single project report."""
    lines = [
        f"# Project Progress: {report.project_name}",
        f"**Period**: {report.period_start.strftime('%b %d, %Y')} - {report.period_end.strftime('%b %d, %Y')}",
        "",
    ]

    grouped = group_by_status(list(report.activities))

    def _render_section(title: str, activities: list[IssueActivity]) -> None:
        if not activities:
            return
        lines.append(f"## {title} ({len(activities)})")
        lines.append("")
        for activity in sorted(activities, key=lambda a: a.ref.identifier):
            lines.append(format_issue_activity(activity))
            lines.append("")

    created_ids = {a.ref.identifier for a in grouped["created"]}
    completed = [a for a in grouped["completed"] if a.ref.identifier not in created_ids]
    in_progress = [a for a in grouped["in_progress"] if a.ref.identifier not in created_ids]
    other = [a for a in grouped["other"] if a.ref.identifier not in created_ids]

    _render_section("Created", grouped["created"])
    _render_section("Completed", completed)
    _render_section("In Progress", in_progress)
    _render_section("Other Changes", other)

    if not any([grouped["created"], completed, in_progress, other]):
        lines.append("*No changes found in the specified time period.*")
        lines.append("")

    return "\n".join(lines)


def format_combined_report(reports: list[ProjectReport]) -> str:
    """Combine multiple project reports with separators."""
    report_texts = [format_project_report(report) for report in reports]
    return "\n---\n\n".join(report_texts)
