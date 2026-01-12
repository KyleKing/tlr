"""Pytest configuration and fixtures."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from tlr.models import Change, IssueActivity, IssueRef, IssueSnapshot, ProjectReport


@pytest.fixture
def vcr_config() -> dict[str, Any]:
    """Configure VCR for pytest-recording."""
    return {
        "filter_headers": ["authorization"],
        "record_mode": "once",
        "match_on": ["uri", "method"],
    }


@pytest.fixture
def sample_issue_ref() -> IssueRef:
    """Sample issue reference."""
    return IssueRef(
        identifier="ENG-123",
        title="Fix authentication bug",
        url="https://linear.app/team/issue/ENG-123",
    )


@pytest.fixture
def sample_issue_snapshot(sample_issue_ref: IssueRef) -> IssueSnapshot:
    """Sample issue snapshot."""
    return IssueSnapshot(
        ref=sample_issue_ref,
        status="Done",
        status_type="completed",
        assignee="Alice",
        cycle="Sprint 10",
        priority=2,
        estimate=3.0,
        labels=("bug", "backend"),
    )


@pytest.fixture
def sample_issue_activity_created(sample_issue_ref: IssueRef, sample_issue_snapshot: IssueSnapshot) -> IssueActivity:
    """Sample issue activity for created issue."""
    return IssueActivity(
        ref=sample_issue_ref,
        created_in_period=True,
        changes=(),
        current_state=sample_issue_snapshot,
    )


@pytest.fixture
def sample_issue_activity_with_changes() -> IssueActivity:
    """Sample issue activity with changes."""
    ref = IssueRef(
        identifier="ENG-124",
        title="Update API endpoints",
        url="https://linear.app/team/issue/ENG-124",
    )
    snapshot = IssueSnapshot(
        ref=ref,
        status="Done",
        status_type="completed",
        assignee="Alice",
    )
    return IssueActivity(
        ref=ref,
        created_in_period=False,
        changes=(
            Change(field="status", from_value="In Progress", to_value="Done"),
            Change(field="assignee", from_value="Bob", to_value="Alice"),
            Change(field="priority", from_value=3, to_value=2),
        ),
        current_state=snapshot,
    )


@pytest.fixture
def sample_project_report(
    sample_issue_activity_created: IssueActivity,
    sample_issue_activity_with_changes: IssueActivity,
) -> ProjectReport:
    """Sample project report."""
    return ProjectReport(
        project_name="Engineering",
        period_start=datetime(2024, 1, 1, tzinfo=UTC),
        period_end=datetime(2024, 1, 8, tzinfo=UTC),
        activities=(sample_issue_activity_created, sample_issue_activity_with_changes),
    )
