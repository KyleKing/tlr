"""Linear GraphQL adapter: fetch issues, cycles, labels, relations, projects, and milestones."""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import polars as pl

from tlr.http import Sleeper, request_with_retry
from tlr.secrets import read_secret

LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'

_PROJECTS_QUERY = """
query Projects($filter: ProjectFilter) {
  projects(filter: $filter, first: 10) {
    nodes {
      id
      name
      url
      slugId
      startDate
      targetDate
      projectMilestones(first: 50) { nodes { id name targetDate progress } }
      teams(first: 10) {
        nodes {
          id
          key
          name
          issueEstimationType
          issueEstimationAllowZero
          issueEstimationExtended
          cycles(last: 12) { nodes { number startsAt endsAt } }
          states(first: 50) { nodes { id name type position } }
        }
      }
    }
  }
}
"""

_TEAM_QUERY = """
query Team($key: String) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes {
      id key name
      issueEstimationType issueEstimationAllowZero issueEstimationExtended
      cycles(last: 12) { nodes { number startsAt endsAt } }
      states(first: 50) { nodes { id name type position } }
    }
  }
}
"""

_ISSUES_QUERY = """
query Issues($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 100, after: $after, includeArchived: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      archivedAt
      createdAt
      completedAt
      canceledAt
      title
      url
      description
      estimate
      priority
      state { name type }
      team { key }
      assignee { name }
      cycle { number }
      labels(first: 20) { nodes { name } }
      parent { identifier }
      project { name }
      projectMilestone { id }
      relations(first: 20) { nodes { type relatedIssue { identifier } } }
      history(first: 100) { nodes { createdAt fromCycle { number } toCycle { number } } }
    }
  }
}
"""

_ISSUE_SCHEMA: dict[str, Any] = {
    'id': pl.Utf8,
    'identifier': pl.Utf8,
    'title': pl.Utf8,
    'description': pl.Utf8,
    'url': pl.Utf8,
    'archived_at': pl.Datetime('us'),
    'created_at': pl.Datetime('us'),
    'estimate': pl.Float64,
    'priority': pl.Int64,
    'state_name': pl.Utf8,
    'state_type': pl.Utf8,
    'team_key': pl.Utf8,
    'assignee_name': pl.Utf8,
    'cycle_number': pl.Int64,
    'project_name': pl.Utf8,
    'project_milestone_id': pl.Utf8,
    'parent_identifier': pl.Utf8,
    'completed_at': pl.Datetime('us'),
    'canceled_at': pl.Datetime('us'),
}
_ISSUE_LABEL_SCHEMA: dict[str, Any] = {'issue_id': pl.Utf8, 'label': pl.Utf8}
_ISSUE_RELATION_SCHEMA: dict[str, Any] = {'issue_id': pl.Utf8, 'relation_type': pl.Utf8, 'related_identifier': pl.Utf8}
_CYCLE_SCHEMA: dict[str, Any] = {
    'team_key': pl.Utf8,
    'number': pl.Int64,
    'starts_at': pl.Datetime('us'),
    'ends_at': pl.Datetime('us'),
}
_PROJECT_SCHEMA: dict[str, Any] = {
    'project_id': pl.Utf8,
    'project_name': pl.Utf8,
    'project_url': pl.Utf8,
    'slug_id': pl.Utf8,
    'start_date': pl.Datetime('us'),
    'target_date': pl.Datetime('us'),
    'team_keys': pl.List(pl.Utf8),
    'milestone_id': pl.Utf8,
    'milestone_name': pl.Utf8,
    'milestone_target_date': pl.Datetime('us'),
    'milestone_progress': pl.Float64,
}

UNASSIGNED = 'Unassigned'


class GraphQLError(RuntimeError):
    """Raised when a Linear GraphQL response carries an `errors` array."""


@dataclass
class LinearClient:
    """An `httpx.Client` and the raw (non-Bearer) Linear API key to send with it."""

    http: httpx.Client
    api_key: str


def make_linear_client(*, http: httpx.Client | None = None, api_key: str | None = None) -> LinearClient:
    """Build a `LinearClient`, defaulting each dependency to its production implementation."""
    return LinearClient(
        http=http if http is not None else httpx.Client(),
        api_key=api_key if api_key is not None else read_secret('linear'),
    )


def team_issue_filter(team_key: str) -> dict[str, Any]:
    """The `IssueFilter` for a team scope, matched by key rather than id."""
    return {'team': {'key': {'eq': team_key}}}


def project_issue_filter(project_id: str) -> dict[str, Any]:
    """The `IssueFilter` for a project scope, matched by id."""
    return {'project': {'id': {'eq': project_id}}}


def project_name_filter(name: str) -> dict[str, Any]:
    """The `ProjectFilter` for a project name, via `containsIgnoreCase`."""
    return {'name': {'containsIgnoreCase': name}}


def project_slug_filter(slug_id: str) -> dict[str, Any]:
    """The `ProjectFilter` fallback when a name filter finds nothing."""
    return {'slugId': {'eq': slug_id}}


def _post(client: LinearClient, query: str, variables: dict[str, Any], *, sleep: Sleeper) -> dict[str, Any]:
    response = request_with_retry(
        client.http,
        'POST',
        LINEAR_GRAPHQL_URL,
        json={'query': query, 'variables': variables},
        headers={'Authorization': client.api_key},
        sleep=sleep,
    )
    response.raise_for_status()
    body = response.json()
    if errors := body.get('errors'):
        msg = f'Linear GraphQL error: {errors}'
        raise GraphQLError(msg)
    return body['data']


def _parse_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(UTC).replace(tzinfo=None)
    return parsed


def parse_issues(data: dict[str, Any]) -> pl.DataFrame:
    """Parse one page of the Issues query response into a store-shaped issues frame."""
    nodes = data['issues']['nodes']
    rows = []
    for node in nodes:
        state = node.get('state') or {}
        team = node.get('team') or {}
        assignee = node.get('assignee')
        cycle = node.get('cycle') or {}
        project = node.get('project') or {}
        milestone = node.get('projectMilestone')
        parent = node.get('parent')
        rows.append(
            {
                'id': node['id'],
                'identifier': node['identifier'],
                'title': node.get('title'),
                'description': node.get('description'),
                'url': node.get('url'),
                'archived_at': _parse_datetime(node.get('archivedAt')),
                'created_at': _parse_datetime(node.get('createdAt')),
                'completed_at': _parse_datetime(node.get('completedAt')),
                'canceled_at': _parse_datetime(node.get('canceledAt')),
                'estimate': node.get('estimate'),
                'priority': node.get('priority'),
                'state_name': state.get('name'),
                'state_type': state.get('type'),
                'team_key': team.get('key'),
                'assignee_name': assignee.get('name') if assignee else UNASSIGNED,
                'cycle_number': cycle.get('number'),
                'project_name': project.get('name'),
                'project_milestone_id': milestone.get('id') if milestone else None,
                'parent_identifier': parent.get('identifier') if parent else None,
            },
        )
    return pl.DataFrame(rows, schema=_ISSUE_SCHEMA) if rows else pl.DataFrame(schema=_ISSUE_SCHEMA)


def parse_issue_labels(data: dict[str, Any]) -> pl.DataFrame:
    """Parse one page of the Issues query response into (issue_id, label) rows."""
    rows = [
        {'issue_id': node['id'], 'label': label['name']}
        for node in data['issues']['nodes']
        for label in node['labels']['nodes']
    ]
    return pl.DataFrame(rows, schema=_ISSUE_LABEL_SCHEMA) if rows else pl.DataFrame(schema=_ISSUE_LABEL_SCHEMA)


def parse_issue_relations(data: dict[str, Any]) -> pl.DataFrame:
    """Parse one page of the Issues query response into one-directional relation rows.

    Linear reports each relation once, on the owning issue; symmetrizing across the
    fetched set is left to the store layer.
    """
    rows = [
        {
            'issue_id': node['id'],
            'relation_type': relation['type'],
            'related_identifier': relation['relatedIssue']['identifier'],
        }
        for node in data['issues']['nodes']
        for relation in node['relations']['nodes']
    ]
    return pl.DataFrame(rows, schema=_ISSUE_RELATION_SCHEMA) if rows else pl.DataFrame(schema=_ISSUE_RELATION_SCHEMA)


def parse_cycles(data: dict[str, Any]) -> pl.DataFrame:
    """Parse the Team query response into a cycles frame keyed on (team_key, number)."""
    teams = data['teams']['nodes']
    if not teams:
        return pl.DataFrame(schema=_CYCLE_SCHEMA)
    team = teams[0]
    rows = [
        {
            'team_key': team['key'],
            'number': cycle['number'],
            'starts_at': _parse_datetime(cycle.get('startsAt')),
            'ends_at': _parse_datetime(cycle.get('endsAt')),
        }
        for cycle in team['cycles']['nodes']
    ]
    return pl.DataFrame(rows, schema=_CYCLE_SCHEMA) if rows else pl.DataFrame(schema=_CYCLE_SCHEMA)


def parse_projects(data: dict[str, Any]) -> pl.DataFrame:
    """Parse the Projects query response into one row per project-milestone pair."""
    rows = []
    for project in data['projects']['nodes']:
        team_keys = [team['key'] for team in project['teams']['nodes']]
        milestones = project['projectMilestones']['nodes']
        base = {
            'project_id': project['id'],
            'project_name': project['name'],
            'project_url': project.get('url'),
            'slug_id': project.get('slugId'),
            'start_date': _parse_datetime(project.get('startDate')),
            'target_date': _parse_datetime(project.get('targetDate')),
            'team_keys': team_keys,
        }
        if not milestones:
            rows.append(
                {
                    **base,
                    'milestone_id': None,
                    'milestone_name': None,
                    'milestone_target_date': None,
                    'milestone_progress': None,
                },
            )
            continue
        rows.extend(
            {
                **base,
                'milestone_id': milestone['id'],
                'milestone_name': milestone['name'],
                'milestone_target_date': _parse_datetime(milestone.get('targetDate')),
                'milestone_progress': milestone.get('progress'),
            }
            for milestone in milestones
        )
    return pl.DataFrame(rows, schema=_PROJECT_SCHEMA) if rows else pl.DataFrame(schema=_PROJECT_SCHEMA)


@dataclass
class IssuesResult:
    """The three store-shaped frames one Issues query page carries."""

    issues: pl.DataFrame
    labels: pl.DataFrame
    relations: pl.DataFrame


def fetch_issues(client: LinearClient, *, issue_filter: dict[str, Any], sleep: Sleeper = time.sleep) -> IssuesResult:
    """Fetch every issue matching `issue_filter`, following Relay pagination to exhaustion."""
    issue_pages: list[pl.DataFrame] = []
    label_pages: list[pl.DataFrame] = []
    relation_pages: list[pl.DataFrame] = []
    after: str | None = None
    while True:
        data = _post(client, _ISSUES_QUERY, {'filter': issue_filter, 'after': after}, sleep=sleep)
        issue_pages.append(parse_issues(data))
        label_pages.append(parse_issue_labels(data))
        relation_pages.append(parse_issue_relations(data))
        page_info = data['issues']['pageInfo']
        if not page_info['hasNextPage']:
            break
        after = page_info['endCursor']
        if not after:
            msg = 'Linear pageInfo.hasNextPage is true but endCursor is empty'
            raise GraphQLError(msg)
    return IssuesResult(
        issues=pl.concat(issue_pages) if issue_pages else pl.DataFrame(schema=_ISSUE_SCHEMA),
        labels=pl.concat(label_pages) if label_pages else pl.DataFrame(schema=_ISSUE_LABEL_SCHEMA),
        relations=pl.concat(relation_pages) if relation_pages else pl.DataFrame(schema=_ISSUE_RELATION_SCHEMA),
    )


def fetch_team_cycles(client: LinearClient, team_key: str, *, sleep: Sleeper = time.sleep) -> pl.DataFrame:
    """Fetch the last 12 cycles for one team, oldest first per Linear's ordering."""
    data = _post(client, _TEAM_QUERY, {'key': team_key}, sleep=sleep)
    return parse_cycles(data)


def fetch_projects(
    client: LinearClient,
    *,
    project_filter: dict[str, Any],
    sleep: Sleeper = time.sleep,
) -> pl.DataFrame:
    """Fetch up to 10 projects matching `project_filter`, with their milestones and team keys.

    Not paginated: the Projects query fixes `first: 10` as the measured complexity
    ceiling and requests no `pageInfo`.
    """
    data = _post(client, _PROJECTS_QUERY, {'filter': project_filter}, sleep=sleep)
    return parse_projects(data)
