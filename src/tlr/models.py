"""Common data models for reporting across all services."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class IssueRef:
    """Reference to an issue (any service)."""

    identifier: str
    title: str
    url: str | None = None


@dataclass(frozen=True)
class Change:
    """A single change to a field."""

    field: str
    from_value: Any
    to_value: Any


@dataclass(frozen=True)
class IssueSnapshot:
    """Snapshot of an issue at a point in time."""

    ref: IssueRef
    status: str | None = None
    status_type: str | None = None
    assignee: str | None = None
    cycle: str | None = None
    priority: int | None = None
    estimate: float | None = None
    labels: tuple[str, ...] = ()
    parent: IssueRef | None = None
    children: tuple[IssueRef, ...] = ()
    blocks: tuple[IssueRef, ...] = ()
    blocked_by: tuple[IssueRef, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class IssueActivity:
    """Activity on an issue during a time period."""

    ref: IssueRef
    created_in_period: bool = False
    changes: tuple[Change, ...] = ()
    current_state: IssueSnapshot | None = None


@dataclass(frozen=True)
class ProjectReport:
    """Report data for a single project (any service)."""

    project_name: str
    period_start: datetime
    period_end: datetime
    activities: tuple[IssueActivity, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)
