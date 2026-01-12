"""Linear-specific Pydantic models for API responses."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LinearState(BaseModel):
    """Linear issue state."""

    id: str
    name: str
    type: str


class LinearUser(BaseModel):
    """Linear user."""

    id: str
    name: str


class LinearCycle(BaseModel):
    """Linear cycle."""

    id: str
    name: str | None = None
    number: int | None = None


class LinearLabel(BaseModel):
    """Linear label."""

    id: str
    name: str


class LinearIssueRef(BaseModel):
    """Reference to another Linear issue."""

    id: str
    identifier: str
    title: str


class LinearRelation(BaseModel):
    """Issue relation (blocks/blocked)."""

    type: str
    related_issue: LinearIssueRef = Field(alias="relatedIssue")


class LinearIssue(BaseModel):
    """Linear issue from API."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    identifier: str
    title: str
    url: str
    created_at: datetime = Field(alias="createdAt")
    state: LinearState | None = None
    assignee: LinearUser | None = None
    cycle: LinearCycle | None = None
    priority: int | None = None
    estimate: float | None = None
    labels: list[LinearLabel] = Field(default_factory=list)
    parent: LinearIssueRef | None = None
    children: list[LinearIssueRef] = Field(default_factory=list)
    relations: list[LinearRelation] = Field(default_factory=list)


class LinearHistoryEntry(BaseModel):
    """Linear issue history entry."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    created_at: datetime = Field(alias="createdAt")
    from_state: LinearState | None = Field(default=None, alias="fromState")
    to_state: LinearState | None = Field(default=None, alias="toState")
    from_cycle: LinearCycle | None = Field(default=None, alias="fromCycle")
    to_cycle: LinearCycle | None = Field(default=None, alias="toCycle")
    from_assignee: LinearUser | None = Field(default=None, alias="fromAssignee")
    to_assignee: LinearUser | None = Field(default=None, alias="toAssignee")
    from_priority: int | None = Field(default=None, alias="fromPriority")
    to_priority: int | None = Field(default=None, alias="toPriority")
    from_estimate: float | None = Field(default=None, alias="fromEstimate")
    to_estimate: float | None = Field(default=None, alias="toEstimate")
    added_label_ids: list[str] = Field(default_factory=list, alias="addedLabelIds")
    removed_label_ids: list[str] = Field(default_factory=list, alias="removedLabelIds")


class LinearProject(BaseModel):
    """Linear project."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    slug_id: str = Field(alias="slugId")
    state: str
