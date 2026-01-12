"""Tests for Linear Pydantic models."""

from __future__ import annotations

from datetime import UTC, datetime

from tlr.linear.models import (
    LinearCycle,
    LinearHistoryEntry,
    LinearIssue,
    LinearIssueRef,
    LinearLabel,
    LinearProject,
    LinearRelation,
    LinearState,
    LinearUser,
)


def test_linear_state():
    state = LinearState(id="state-1", name="In Progress", type="started")
    assert state.id == "state-1"
    assert state.name == "In Progress"
    assert state.type == "started"


def test_linear_user():
    user = LinearUser(id="user-1", name="Alice")
    assert user.id == "user-1"
    assert user.name == "Alice"


def test_linear_cycle():
    cycle = LinearCycle(id="cycle-1", name="Sprint 10", number=10)
    assert cycle.id == "cycle-1"
    assert cycle.name == "Sprint 10"
    assert cycle.number == 10


def test_linear_cycle_optional_fields():
    cycle = LinearCycle(id="cycle-1")
    assert cycle.id == "cycle-1"
    assert cycle.name is None
    assert cycle.number is None


def test_linear_label():
    label = LinearLabel(id="label-1", name="bug")
    assert label.id == "label-1"
    assert label.name == "bug"


def test_linear_issue_ref():
    ref = LinearIssueRef(id="issue-1", identifier="ENG-123", title="Fix bug")
    assert ref.id == "issue-1"
    assert ref.identifier == "ENG-123"
    assert ref.title == "Fix bug"


def test_linear_relation():
    relation = LinearRelation.model_validate({
        "type": "blocks",
        "relatedIssue": {
            "id": "issue-2",
            "identifier": "ENG-124",
            "title": "Related issue",
        },
    })
    assert relation.type == "blocks"
    assert relation.related_issue.identifier == "ENG-124"


def test_linear_issue_minimal():
    issue = LinearIssue.model_validate({
        "id": "issue-1",
        "identifier": "ENG-123",
        "title": "Fix authentication",
        "url": "https://linear.app/team/issue/ENG-123",
        "createdAt": "2024-01-01T00:00:00.000Z",
    })
    assert issue.id == "issue-1"
    assert issue.identifier == "ENG-123"
    assert issue.title == "Fix authentication"
    assert issue.url == "https://linear.app/team/issue/ENG-123"
    assert issue.created_at == datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC)
    assert issue.state is None
    assert issue.assignee is None


def test_linear_issue_full():
    issue = LinearIssue.model_validate({
        "id": "issue-1",
        "identifier": "ENG-123",
        "title": "Fix authentication",
        "url": "https://linear.app/team/issue/ENG-123",
        "createdAt": "2024-01-01T00:00:00.000Z",
        "state": {"id": "state-1", "name": "Done", "type": "completed"},
        "assignee": {"id": "user-1", "name": "Alice"},
        "cycle": {"id": "cycle-1", "name": "Sprint 10", "number": 10},
        "priority": 2,
        "estimate": 3.0,
        "labels": [
            {"id": "label-1", "name": "bug"},
            {"id": "label-2", "name": "backend"},
        ],
        "parent": {"id": "parent-1", "identifier": "ENG-100", "title": "Parent epic"},
        "children": [
            {"id": "child-1", "identifier": "ENG-124", "title": "Child 1"},
        ],
        "relations": [
            {
                "type": "blocks",
                "relatedIssue": {"id": "related-1", "identifier": "ENG-125", "title": "Blocked issue"},
            },
        ],
    })
    assert issue.state is not None
    assert issue.state.name == "Done"
    assert issue.assignee is not None
    assert issue.assignee.name == "Alice"
    assert issue.cycle is not None
    assert issue.cycle.name == "Sprint 10"
    assert issue.priority == 2
    assert issue.estimate == 3.0
    assert len(issue.labels) == 2
    assert issue.labels[0].name == "bug"
    assert issue.parent is not None
    assert issue.parent.identifier == "ENG-100"
    assert len(issue.children) == 1
    assert issue.children[0].identifier == "ENG-124"
    assert len(issue.relations) == 1
    assert issue.relations[0].type == "blocks"


def test_linear_history_entry_minimal():
    entry = LinearHistoryEntry.model_validate({
        "id": "history-1",
        "createdAt": "2024-01-02T00:00:00.000Z",
    })
    assert entry.id == "history-1"
    assert entry.created_at == datetime(2024, 1, 2, 0, 0, 0, tzinfo=UTC)
    assert entry.from_state is None
    assert entry.to_state is None


def test_linear_history_entry_full():
    entry = LinearHistoryEntry.model_validate({
        "id": "history-1",
        "createdAt": "2024-01-02T00:00:00.000Z",
        "fromState": {"id": "state-1", "name": "In Progress", "type": "started"},
        "toState": {"id": "state-2", "name": "Done", "type": "completed"},
        "fromCycle": {"id": "cycle-1", "name": "Sprint 9", "number": 9},
        "toCycle": {"id": "cycle-2", "name": "Sprint 10", "number": 10},
        "fromAssignee": {"id": "user-1", "name": "Alice"},
        "toAssignee": {"id": "user-2", "name": "Bob"},
        "fromPriority": 3,
        "toPriority": 2,
        "fromEstimate": 2.0,
        "toEstimate": 3.0,
        "addedLabelIds": ["label-1", "label-2"],
        "removedLabelIds": ["label-3"],
    })
    assert entry.from_state is not None
    assert entry.from_state.name == "In Progress"
    assert entry.to_state is not None
    assert entry.to_state.name == "Done"
    assert entry.from_cycle is not None
    assert entry.from_cycle.name == "Sprint 9"
    assert entry.to_cycle is not None
    assert entry.to_cycle.name == "Sprint 10"
    assert entry.from_assignee is not None
    assert entry.from_assignee.name == "Alice"
    assert entry.to_assignee is not None
    assert entry.to_assignee.name == "Bob"
    assert entry.from_priority == 3
    assert entry.to_priority == 2
    assert entry.from_estimate == 2.0
    assert entry.to_estimate == 3.0
    assert entry.added_label_ids == ["label-1", "label-2"]
    assert entry.removed_label_ids == ["label-3"]


def test_linear_project():
    project = LinearProject.model_validate({
        "id": "project-1",
        "name": "Engineering",
        "slugId": "ENG",
        "state": "started",
    })
    assert project.id == "project-1"
    assert project.name == "Engineering"
    assert project.slug_id == "ENG"
    assert project.state == "started"
