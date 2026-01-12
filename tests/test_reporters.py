"""Tests for reporters module."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from tlr.models import Change, IssueActivity, IssueRef, IssueSnapshot, ProjectReport
from tlr.reporters.markdown import (
    _format_change_line,
    _format_relationships,
    _priority_name,
    format_combined_report,
    format_issue_activity,
    format_project_report,
    group_by_status,
)


def test_priority_name():
    assert _priority_name(None) == "None"
    assert _priority_name(0) == "None"
    assert _priority_name(1) == "Urgent"
    assert _priority_name(2) == "High"
    assert _priority_name(3) == "Medium"
    assert _priority_name(4) == "Low"
    assert _priority_name(99) == "Unknown"


def test_format_change_line_status():
    change = Change(field="status", from_value="In Progress", to_value="Done")
    result = _format_change_line(change)
    assert "Status: In Progress -> Done" in result


def test_format_change_line_priority():
    change = Change(field="priority", from_value=3, to_value=1)
    result = _format_change_line(change)
    assert "Priority: Medium -> Urgent" in result


def test_format_change_line_priority_no_from():
    change = Change(field="priority", from_value=None, to_value=2)
    result = _format_change_line(change)
    assert "Priority: High" in result
    assert "->" not in result


def test_format_change_line_cycle_added():
    change = Change(field="cycle", from_value=None, to_value="Sprint 10")
    result = _format_change_line(change)
    assert "Added to Cycle: Sprint 10" in result


def test_format_change_line_cycle_removed():
    change = Change(field="cycle", from_value="Sprint 9", to_value="None")
    result = _format_change_line(change)
    assert "Removed from Cycle: Sprint 9" in result


def test_format_change_line_cycle_changed():
    change = Change(field="cycle", from_value="Sprint 9", to_value="Sprint 10")
    result = _format_change_line(change)
    assert "Cycle: Sprint 9 -> Sprint 10" in result


def test_format_change_line_labels_added():
    change = Change(field="labels_added", from_value=None, to_value=("bug", "urgent"))
    result = _format_change_line(change)
    assert "Labels added: bug, urgent" in result


def test_format_change_line_labels_removed():
    change = Change(field="labels_removed", from_value=None, to_value=("wontfix",))
    result = _format_change_line(change)
    assert "Labels removed: wontfix" in result


def test_format_relationships_parent():
    parent = IssueRef("ENG-100", "Parent epic", None)
    result = _format_relationships(parent, (), (), ())
    assert len(result) == 1
    assert "Parent: ENG-100 (Parent epic)" in result[0]


def test_format_relationships_children():
    children = (
        IssueRef("ENG-101", "Child 1", None),
        IssueRef("ENG-102", "Child 2", None),
    )
    result = _format_relationships(None, children, (), ())
    assert len(result) == 1
    assert "Subissues: ENG-101, ENG-102" in result[0]


def test_format_relationships_blocks():
    blocks = (IssueRef("ENG-103", "Blocked issue", None),)
    result = _format_relationships(None, (), blocks, ())
    assert len(result) == 1
    assert "Blocks: ENG-103" in result[0]


def test_format_relationships_blocked_by():
    blocked_by = (IssueRef("ENG-104", "Blocker", None),)
    result = _format_relationships(None, (), (), blocked_by)
    assert len(result) == 1
    assert "Blocked by: ENG-104" in result[0]


def test_format_relationships_all():
    parent = IssueRef("ENG-100", "Parent", None)
    children = (IssueRef("ENG-101", "Child", None),)
    blocks = (IssueRef("ENG-102", "Blocked", None),)
    blocked_by = (IssueRef("ENG-103", "Blocker", None),)
    result = _format_relationships(parent, children, blocks, blocked_by)
    assert len(result) == 4


def test_format_issue_activity_created(sample_issue_activity_created: IssueActivity):
    result = format_issue_activity(sample_issue_activity_created)
    assert "ENG-123" in result
    assert "Fix authentication bug" in result
    assert "Status: Done" in result
    assert "Assignee: Alice" in result


def test_format_issue_activity_with_changes(sample_issue_activity_with_changes: IssueActivity):
    result = format_issue_activity(sample_issue_activity_with_changes)
    assert "ENG-124" in result
    assert "Update API endpoints" in result
    assert "Status: In Progress -> Done" in result
    assert "Assignee: Bob -> Alice" in result
    assert "Priority: Medium -> High" in result


def test_format_issue_activity_with_relationships():
    ref = IssueRef("ENG-200", "Issue with relationships", "https://example.com")
    parent = IssueRef("ENG-100", "Parent", None)
    children = (IssueRef("ENG-201", "Child", None),)
    snapshot = IssueSnapshot(
        ref=ref,
        status="In Progress",
        status_type="started",
        parent=parent,
        children=children,
    )
    activity = IssueActivity(
        ref=ref,
        created_in_period=True,
        changes=(),
        current_state=snapshot,
    )
    result = format_issue_activity(activity)
    assert "Parent: ENG-100" in result
    assert "Subissues: ENG-201" in result


def test_group_by_status_created(sample_issue_activity_created: IssueActivity):
    grouped = group_by_status([sample_issue_activity_created])
    assert len(grouped["created"]) == 1
    assert len(grouped["completed"]) == 0
    assert len(grouped["in_progress"]) == 0
    assert len(grouped["other"]) == 0


def test_group_by_status_completed():
    ref = IssueRef("ENG-300", "Completed task", "https://example.com")
    snapshot = IssueSnapshot(ref=ref, status="Done", status_type="completed")
    activity = IssueActivity(
        ref=ref,
        created_in_period=False,
        changes=(Change(field="status", from_value="In Progress", to_value="Done"),),
        current_state=snapshot,
    )
    grouped = group_by_status([activity])
    assert len(grouped["created"]) == 0
    assert len(grouped["completed"]) == 1
    assert len(grouped["in_progress"]) == 0
    assert len(grouped["other"]) == 0


def test_group_by_status_in_progress():
    ref = IssueRef("ENG-400", "In progress task", "https://example.com")
    snapshot = IssueSnapshot(ref=ref, status="In Progress", status_type="started")
    activity = IssueActivity(
        ref=ref,
        created_in_period=False,
        changes=(Change(field="assignee", from_value="Alice", to_value="Bob"),),
        current_state=snapshot,
    )
    grouped = group_by_status([activity])
    assert len(grouped["created"]) == 0
    assert len(grouped["completed"]) == 0
    assert len(grouped["in_progress"]) == 1
    assert len(grouped["other"]) == 0


def test_group_by_status_other():
    ref = IssueRef("ENG-500", "Backlog task", "https://example.com")
    snapshot = IssueSnapshot(ref=ref, status="Backlog", status_type="backlog")
    activity = IssueActivity(
        ref=ref,
        created_in_period=False,
        changes=(Change(field="priority", from_value=4, to_value=3),),
        current_state=snapshot,
    )
    grouped = group_by_status([activity])
    assert len(grouped["created"]) == 0
    assert len(grouped["completed"]) == 0
    assert len(grouped["in_progress"]) == 0
    assert len(grouped["other"]) == 1


def test_format_project_report(sample_project_report: ProjectReport):
    result = format_project_report(sample_project_report)
    assert "Project Progress: Engineering" in result
    assert "Jan 01, 2024 - Jan 08, 2024" in result
    assert "## Created (1)" in result
    assert "## Completed (1)" in result
    assert "ENG-123" in result
    assert "ENG-124" in result


def test_format_project_report_empty():
    report = ProjectReport(
        project_name="Empty Project",
        period_start=datetime(2024, 1, 1, tzinfo=UTC),
        period_end=datetime(2024, 1, 8, tzinfo=UTC),
        activities=(),
    )
    result = format_project_report(report)
    assert "Project Progress: Empty Project" in result
    assert "No changes found" in result


def test_format_project_report_excludes_created_from_other_sections():
    ref_created = IssueRef("ENG-600", "Created and completed", "https://example.com")
    snapshot_created = IssueSnapshot(ref=ref_created, status="Done", status_type="completed")
    activity_created = IssueActivity(
        ref=ref_created,
        created_in_period=True,
        changes=(),
        current_state=snapshot_created,
    )

    ref_completed = IssueRef("ENG-601", "Just completed", "https://example.com")
    snapshot_completed = IssueSnapshot(ref=ref_completed, status="Done", status_type="completed")
    activity_completed = IssueActivity(
        ref=ref_completed,
        created_in_period=False,
        changes=(Change(field="status", from_value="In Progress", to_value="Done"),),
        current_state=snapshot_completed,
    )

    report = ProjectReport(
        project_name="Test Project",
        period_start=datetime(2024, 1, 1, tzinfo=UTC),
        period_end=datetime(2024, 1, 8, tzinfo=UTC),
        activities=(activity_created, activity_completed),
    )

    result = format_project_report(report)
    assert "## Created (1)" in result
    assert "## Completed (1)" in result
    created_section = result.split("## Created")[1].split("##")[0]
    assert "ENG-600" in created_section
    completed_section = result.split("## Completed")[1].split("##")[0] if "## Completed" in result.split("## Created")[1] else ""
    assert "ENG-601" in completed_section
    assert "ENG-600" not in completed_section


def test_format_combined_report(sample_project_report: ProjectReport):
    report2 = ProjectReport(
        project_name="Infrastructure",
        period_start=datetime(2024, 1, 1, tzinfo=UTC),
        period_end=datetime(2024, 1, 8, tzinfo=UTC),
        activities=(),
    )
    result = format_combined_report([sample_project_report, report2])
    assert "Project Progress: Engineering" in result
    assert "Project Progress: Infrastructure" in result
    assert "---" in result


def test_format_issue_activity_with_labels():
    ref = IssueRef("ENG-700", "Issue with labels", "https://example.com")
    snapshot = IssueSnapshot(
        ref=ref,
        status="Done",
        status_type="completed",
        labels=("bug", "frontend", "urgent"),
    )
    activity = IssueActivity(
        ref=ref,
        created_in_period=True,
        changes=(),
        current_state=snapshot,
    )
    result = format_issue_activity(activity)
    assert "Labels: bug, frontend, urgent" in result
