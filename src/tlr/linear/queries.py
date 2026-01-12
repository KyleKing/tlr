"""GraphQL queries for Linear API."""

from __future__ import annotations

from textwrap import dedent

FIND_PROJECTS_QUERY = dedent("""\
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

GET_PROJECT_ISSUES_QUERY = dedent("""\
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

GET_ISSUE_HISTORY_QUERY = dedent("""\
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

GET_LABELS_QUERY = dedent("""\
    query Labels {
        issueLabels(first: 250) {
            nodes {
                id
                name
            }
        }
    }""")
