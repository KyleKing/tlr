"""Linear API client functions."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from tlr.linear.models import (
    LinearHistoryEntry,
    LinearIssue,
    LinearLabel,
    LinearProject,
    LinearRelationType,
)
from tlr.linear.queries import (
    FIND_PROJECTS_QUERY,
    GET_ISSUE_HISTORY_QUERY,
    GET_LABELS_QUERY,
    GET_PROJECT_ISSUES_QUERY,
)
from tlr.models import Change, IssueActivity, IssueRef, IssueSnapshot, ProjectReport
from tlr.secrets import get_or_prompt_credential

LINEAR_API_URL = "https://api.linear.app/graphql"
KEYCHAIN_SERVICE = "tlr-linear"
KEYCHAIN_ACCOUNT = "api-key"


def get_api_key() -> str | None:
    """Get Linear API key from keychain or prompt user."""
    return get_or_prompt_credential(
        service=KEYCHAIN_SERVICE,
        account=KEYCHAIN_ACCOUNT,
        prompt_message="Enter your Linear API key: ",
        help_url="https://linear.app/settings/api",
    )


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


def find_project(api_key: str, project_query: str) -> LinearProject | None:
    """Find a Linear project by name or slug (case-insensitive partial match)."""
    data = _gql_request(api_key, FIND_PROJECTS_QUERY, {"filter": {"name": {"containsIgnoreCase": project_query}}})
    projects_data = data.get("projects", {}).get("nodes", [])

    if not projects_data:
        data = _gql_request(api_key, FIND_PROJECTS_QUERY, {"filter": {"slugId": {"containsIgnoreCase": project_query}}})
        projects_data = data.get("projects", {}).get("nodes", [])

    if not projects_data:
        return None

    projects = [LinearProject.model_validate(p) for p in projects_data]

    if len(projects) == 1:
        return projects[0]

    for proj in projects:
        if proj.name.lower() == project_query.lower() or proj.slug_id.lower() == project_query.lower():
            return proj

    return projects[0]


def fetch_project_issues(api_key: str, project_id: str) -> list[LinearIssue]:
    """Fetch all issues for a Linear project."""
    all_issues: list[LinearIssue] = []
    cursor: str | None = None

    while True:
        variables: dict[str, Any] = {"projectId": project_id}
        if cursor:
            variables["after"] = cursor

        data = _gql_request(api_key, GET_PROJECT_ISSUES_QUERY, variables)
        issues_data = data.get("issues", {})

        for issue_data in issues_data.get("nodes", []):
            if labels_data := issue_data.get("labels", {}).get("nodes"):
                issue_data["labels"] = labels_data
            if children_data := issue_data.get("children", {}).get("nodes"):
                issue_data["children"] = children_data
            if relations_data := issue_data.get("relations", {}).get("nodes"):
                issue_data["relations"] = relations_data

            all_issues.append(LinearIssue.model_validate(issue_data))

        page_info = issues_data.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        cursor = page_info.get("endCursor")

    return all_issues


def fetch_issue_history(api_key: str, issue_id: str, since: datetime) -> list[LinearHistoryEntry]:
    """Fetch history entries for an issue since a given date."""
    all_history: list[LinearHistoryEntry] = []
    cursor: str | None = None

    while True:
        variables: dict[str, Any] = {"issueId": issue_id}
        if cursor:
            variables["after"] = cursor

        data = _gql_request(api_key, GET_ISSUE_HISTORY_QUERY, variables)
        issue_data = data.get("issue")
        if not issue_data:
            break

        history_data = issue_data.get("history", {})
        nodes = history_data.get("nodes", [])

        for node in nodes:
            entry = LinearHistoryEntry.model_validate(node)
            if entry.created_at >= since:
                all_history.append(entry)

        page_info = history_data.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        cursor = page_info.get("endCursor")

    return sorted(all_history, key=lambda h: h.created_at)


def fetch_labels(api_key: str) -> dict[str, str]:
    """Fetch all labels and return mapping of ID to name."""
    data = _gql_request(api_key, GET_LABELS_QUERY)
    labels_data = data.get("issueLabels", {}).get("nodes", [])
    labels = [LinearLabel.model_validate(label) for label in labels_data]
    return {label.id: label.name for label in labels}


def _cycle_display(cycle: Any) -> str | None:
    """Format cycle for display."""
    if not cycle:
        return None
    if cycle.name:
        return cycle.name
    if cycle.number:
        return f"Cycle {cycle.number}"
    return "Unknown Cycle"


def _extract_relationships(
    issue: LinearIssue,
) -> tuple[IssueRef | None, tuple[IssueRef, ...], tuple[IssueRef, ...], tuple[IssueRef, ...]]:
    """Extract parent, children, blocks, and blocked_by from issue."""
    parent: IssueRef | None = None
    if issue.parent:
        parent = IssueRef(identifier=issue.parent.identifier, title=issue.parent.title, url=None)

    children = tuple(IssueRef(identifier=c.identifier, title=c.title, url=None) for c in issue.children)

    blocks: list[IssueRef] = []
    blocked_by: list[IssueRef] = []
    for relation in issue.relations:
        ref = IssueRef(
            identifier=relation.related_issue.identifier,
            title=relation.related_issue.title,
            url=None,
        )
        if relation.type == LinearRelationType.BLOCKS:
            blocks.append(ref)
        elif relation.type == LinearRelationType.BLOCKED:
            blocked_by.append(ref)

    return parent, children, tuple(blocks), tuple(blocked_by)


def _compute_issue_changes(
    issue: LinearIssue,
    history: list[LinearHistoryEntry],
    label_names: dict[str, str],
) -> tuple[Change, ...]:
    """Compute net changes for an issue from its history."""
    changes: list[Change] = []
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
    labels_added: list[str] = []
    labels_removed: list[str] = []

    for entry in history:
        if entry.from_state and initial_status is None:
            initial_status = entry.from_state.name
        if entry.to_state:
            final_status = entry.to_state.name

        if entry.from_cycle and initial_cycle is None:
            initial_cycle = _cycle_display(entry.from_cycle)
        if entry.to_cycle:
            final_cycle = _cycle_display(entry.to_cycle)

        if entry.from_assignee and initial_assignee is None:
            initial_assignee = entry.from_assignee.name
        if entry.to_assignee:
            final_assignee = entry.to_assignee.name

        if entry.from_priority is not None and initial_priority is None:
            initial_priority = entry.from_priority
        if entry.to_priority is not None:
            final_priority = entry.to_priority

        if entry.from_estimate is not None and initial_estimate is None:
            initial_estimate = entry.from_estimate
        if entry.to_estimate is not None:
            final_estimate = entry.to_estimate

        for label_id in entry.added_label_ids:
            if (label_name := label_names.get(label_id)):
                if label_name in labels_removed:
                    labels_removed.remove(label_name)
                elif label_name not in labels_added:
                    labels_added.append(label_name)

        for label_id in entry.removed_label_ids:
            if (label_name := label_names.get(label_id)):
                if label_name in labels_added:
                    labels_added.remove(label_name)
                elif label_name not in labels_removed:
                    labels_removed.append(label_name)

    if final_status and initial_status != final_status:
        changes.append(Change(field="status", from_value=initial_status, to_value=final_status))

    if final_assignee and initial_assignee != final_assignee:
        changes.append(Change(field="assignee", from_value=initial_assignee, to_value=final_assignee))

    if final_cycle is not None and initial_cycle != final_cycle:
        changes.append(Change(field="cycle", from_value=initial_cycle, to_value=final_cycle))

    if final_priority is not None and initial_priority != final_priority:
        changes.append(Change(field="priority", from_value=initial_priority, to_value=final_priority))

    if final_estimate is not None and initial_estimate != final_estimate:
        changes.append(Change(field="estimate", from_value=initial_estimate, to_value=final_estimate))

    if labels_added:
        changes.append(Change(field="labels_added", from_value=None, to_value=tuple(labels_added)))

    if labels_removed:
        changes.append(Change(field="labels_removed", from_value=None, to_value=tuple(labels_removed)))

    return tuple(changes)


def transform_to_report(
    project: LinearProject,
    issues: list[LinearIssue],
    histories: dict[str, list[LinearHistoryEntry]],
    label_names: dict[str, str],
    since: datetime,
    until: datetime,
) -> ProjectReport:
    """Transform Linear data to common ProjectReport."""
    activities: list[IssueActivity] = []

    for issue in issues:
        created_in_period = issue.created_at >= since
        history = histories.get(issue.id, [])

        parent, children, blocks, blocked_by = _extract_relationships(issue)

        current_state = IssueSnapshot(
            ref=IssueRef(identifier=issue.identifier, title=issue.title, url=issue.url),
            status=issue.state.name if issue.state else None,
            status_type=issue.state.type if issue.state else None,
            assignee=issue.assignee.name if issue.assignee else None,
            cycle=_cycle_display(issue.cycle),
            priority=issue.priority,
            estimate=issue.estimate,
            labels=tuple(label.name for label in issue.labels),
            parent=parent,
            children=children,
            blocks=blocks,
            blocked_by=blocked_by,
        )

        changes = _compute_issue_changes(issue, history, label_names)

        if created_in_period or changes:
            activities.append(
                IssueActivity(
                    ref=IssueRef(identifier=issue.identifier, title=issue.title, url=issue.url),
                    created_in_period=created_in_period,
                    changes=changes,
                    current_state=current_state,
                )
            )

    return ProjectReport(
        project_name=project.name,
        period_start=since,
        period_end=until,
        activities=tuple(activities),
    )
