"""Tests for the snapshot domain: period math and pure frame-in, frame-out functions."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import polars as pl
import pytest

from tlr.config import SlaConfig
from tlr.domain import snapshot

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=UTC).replace(tzinfo=None)  # a Thursday
_EXPECTED_URGENT_OPEN_COUNT = 2

_LINEAR_DEFAULTS = {
    'id': 'issue-1',
    'identifier': 'DEV-1',
    'title': 'Fix the widget',
    'created_at': NOW - timedelta(days=1),
    'completed_at': None,
    'canceled_at': None,
    'priority': 2,
    'assignee_name': 'Ada Example',
}

_PYLON_DEFAULTS = {
    'id': 'pylon-1',
    'number': 1,
    'title': 'Widget broke',
    'created_at': NOW - timedelta(days=1),
    'resolution_time': None,
    'priority': 'high',
}


def _linear_issue(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = dict(_LINEAR_DEFAULTS)
    row.update(overrides)
    return row


def _linear_issues(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(
        list(rows),
        schema={
            'id': pl.Utf8,
            'identifier': pl.Utf8,
            'title': pl.Utf8,
            'created_at': pl.Datetime('us'),
            'completed_at': pl.Datetime('us'),
            'canceled_at': pl.Datetime('us'),
            'priority': pl.Int64,
            'assignee_name': pl.Utf8,
        },
    )


def _pylon_issue(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = dict(_PYLON_DEFAULTS)
    row.update(overrides)
    return row


def _pylon_issues(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(
        list(rows),
        schema={
            'id': pl.Utf8,
            'number': pl.Int64,
            'title': pl.Utf8,
            'created_at': pl.Datetime('us'),
            'resolution_time': pl.Datetime('us'),
            'priority': pl.Utf8,
        },
    )


def _naive(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, tzinfo=UTC).replace(tzinfo=None)


@pytest.mark.parametrize(
    ('period', 'as_of', 'expected_start', 'expected_end', 'expected_previous_start'),
    [
        ('week', _naive(2026, 9, 24), _naive(2026, 9, 21), _naive(2026, 9, 28), _naive(2026, 9, 14)),
        ('month', _naive(2026, 9, 24), _naive(2026, 9, 1), _naive(2026, 10, 1), _naive(2026, 8, 1)),
        ('month', _naive(2026, 12, 15), _naive(2026, 12, 1), _naive(2027, 1, 1), _naive(2026, 11, 1)),
    ],
    ids=['week-mon-sun', 'month', 'month-crosses-year'],
)
def test_period_window_bounds(period, as_of, expected_start, expected_end, expected_previous_start):
    window = snapshot.period_window(period, as_of)

    assert window.start == expected_start
    assert window.end == expected_end
    assert window.previous_start == expected_previous_start
    assert window.previous_end == expected_start


def test_linear_priority_breakdown_reconstructs_open_count_and_delta():
    previous_at = NOW - timedelta(days=7)
    still_open = _linear_issue(id='still-open', priority=1, created_at=previous_at - timedelta(days=10))
    created_this_period = _linear_issue(id='new', priority=1, created_at=NOW - timedelta(days=1))
    closed_before_previous = _linear_issue(
        id='closed-before',
        priority=1,
        created_at=previous_at - timedelta(days=20),
        completed_at=previous_at - timedelta(days=1),
    )
    issues = _linear_issues(still_open, created_this_period, closed_before_previous)

    result = snapshot.linear_priority_breakdown(issues, now=NOW, previous_at=previous_at)

    urgent = result.filter(pl.col('priority') == 'Urgent').to_dicts()[0]
    assert urgent['open_count'] == _EXPECTED_URGENT_OPEN_COUNT
    assert urgent['delta'] == 1
    assert result['priority'].to_list() == snapshot.LINEAR_PRIORITY_ORDER


def test_linear_created_closed_counts_within_window():
    created = _linear_issue(id='created', created_at=NOW - timedelta(hours=1))
    closed = _linear_issue(
        id='closed',
        created_at=NOW - timedelta(days=10),
        completed_at=NOW - timedelta(hours=1),
    )
    outside_window = _linear_issue(id='old', created_at=NOW - timedelta(days=30))
    issues = _linear_issues(created, closed, outside_window)

    result = snapshot.linear_created_closed(
        issues,
        window_start=NOW - timedelta(days=1),
        window_end=NOW + timedelta(days=1),
    )

    row = result.to_dicts()[0]
    assert row['created'] == 1
    assert row['closed'] == 1


def test_linear_untracked_counts_no_priority_and_no_assignee():
    no_priority = _linear_issue(id='no-priority', priority=0)
    no_assignee = _linear_issue(id='no-assignee', assignee_name=snapshot.UNASSIGNED)
    tracked = _linear_issue(id='tracked')
    issues = _linear_issues(no_priority, no_assignee, tracked)

    result = snapshot.linear_untracked(issues, now=NOW)

    row = result.to_dicts()[0]
    assert row['no_priority'] == 1
    assert row['no_assignee'] == 1


def test_linear_oldest_open_respects_limit_per_priority():
    older = _linear_issue(id='older', priority=2, created_at=NOW - timedelta(days=20))
    newer = _linear_issue(id='newer', priority=2, created_at=NOW - timedelta(days=5))
    issues = _linear_issues(older, newer)

    result = snapshot.linear_oldest_open(issues, now=NOW, limit=1)

    assert result['identifier'].to_list() == ['DEV-1']  # both rows share the same identifier fixture default
    assert result.height == 1
    assert result['age_days'].item() == 20  # noqa: PLR2004


def test_linear_label_distribution_counts_labels_on_issues_created_in_window():
    issues = _linear_issues(_linear_issue(id='a'), _linear_issue(id='b', identifier='DEV-2'))
    issue_labels = pl.DataFrame({'issue_id': ['a', 'a', 'b'], 'label': ['bug', 'p1', 'bug']})

    result = snapshot.linear_label_distribution(
        issues,
        issue_labels,
        window_start=NOW - timedelta(days=2),
        window_end=NOW + timedelta(days=1),
        top_n=10,
    )

    counts = dict(zip(result['label'].to_list(), result['count'].to_list(), strict=True))
    assert counts == {'bug': 2, 'p1': 1}


@pytest.mark.parametrize(
    ('issue_labels', 'expected_sparse'),
    [
        (pl.DataFrame({'issue_id': [], 'label': []}, schema={'issue_id': pl.Utf8, 'label': pl.Utf8}), True),
        (pl.DataFrame({'issue_id': ['a', 'b'], 'label': ['bug', 'bug']}), False),
    ],
    ids=['no-labels-is-sparse', 'every-issue-labeled-is-not-sparse'],
)
def test_labels_are_sparse(issue_labels, expected_sparse):
    issues = _linear_issues(_linear_issue(id='a'), _linear_issue(id='b', identifier='DEV-2'))

    result = snapshot.labels_are_sparse(
        issues,
        issue_labels,
        window_start=NOW - timedelta(days=2),
        window_end=NOW + timedelta(days=1),
    )

    assert result is expected_sparse


def test_pylon_priority_breakdown_reconstructs_open_count_and_delta():
    previous_at = NOW - timedelta(days=7)
    still_open = _pylon_issue(id='still-open', priority='high', created_at=previous_at - timedelta(days=10))
    resolved_since = _pylon_issue(
        id='resolved',
        priority='high',
        created_at=previous_at - timedelta(days=10),
        resolution_time=NOW - timedelta(days=1),
    )
    issues = _pylon_issues(still_open, resolved_since)

    result = snapshot.pylon_priority_breakdown(
        issues,
        ['urgent', 'high', 'medium', 'low'],
        now=NOW,
        previous_at=previous_at,
    )

    high = result.filter(pl.col('priority') == 'high').to_dicts()[0]
    assert high['open_count'] == 1
    assert high['delta'] == -1


def test_pylon_created_resolved_counts_within_window():
    created = _pylon_issue(id='created', created_at=NOW - timedelta(hours=1))
    resolved = _pylon_issue(
        id='resolved',
        created_at=NOW - timedelta(days=10),
        resolution_time=NOW - timedelta(hours=1),
    )
    issues = _pylon_issues(created, resolved)

    result = snapshot.pylon_created_resolved(
        issues,
        window_start=NOW - timedelta(days=1),
        window_end=NOW + timedelta(days=1),
    )

    row = result.to_dicts()[0]
    assert row['created'] == 1
    assert row['resolved'] == 1


def test_pylon_oldest_open_orders_oldest_first():
    older = _pylon_issue(id='older', number=1, created_at=NOW - timedelta(days=30))
    newer = _pylon_issue(id='newer', number=2, created_at=NOW - timedelta(days=1))
    issues = _pylon_issues(older, newer)

    result = snapshot.pylon_oldest_open(issues, now=NOW, limit=5)

    assert result['number'].to_list() == [1, 2]


def test_pylon_top_tags_counts_only_tag_kind_labels():
    labels = pl.DataFrame(
        {
            'issue_id': ['a', 'a', 'b'],
            'kind': ['tag', 'question_type', 'tag'],
            'label': ['billing', 'refund', 'billing'],
        },
    )

    result = snapshot.pylon_top_tags(labels, top_n=10)

    assert result.to_dicts() == [{'label': 'billing', 'count': 2}]


def test_pylon_over_sla_flags_only_issues_past_their_priority_target():
    over = _pylon_issue(id='over', priority='urgent', created_at=NOW - timedelta(days=5))
    under = _pylon_issue(id='under', priority='low', created_at=NOW - timedelta(days=5))
    issues = _pylon_issues(over, under)
    sla = SlaConfig(target_days_by_priority={'urgent': 1, 'low': 10})

    result = snapshot.pylon_over_sla(issues, sla, now=NOW)

    assert result['title'].to_list() == ['Widget broke']
    assert result.height == 1


def test_pylon_over_sla_is_empty_without_configured_targets():
    issues = _pylon_issues(_pylon_issue())

    result = snapshot.pylon_over_sla(issues, SlaConfig(), now=NOW)

    assert result.is_empty()
    assert result.columns == ['number', 'title', 'priority', 'age_days', 'sla_target_days']


def test_sentry_section_reports_not_configured_without_a_token():
    sections = snapshot.sentry_section(
        pl.DataFrame(schema={'first_seen': pl.Datetime('us')}),
        configured=False,
        window_start=NOW - timedelta(days=7),
        window_end=NOW,
    )

    assert [title for title, _ in sections] == ['Sentry']
    assert sections[0][1]['note'].to_list() == ['Sentry: not configured']


def test_sentry_section_reports_new_and_top_issues_when_configured():
    sentry_issues = pl.DataFrame(
        {
            'project_slug': ['backend', 'backend'],
            'title': ['NPE in handler', 'Timeout in worker'],
            'times_seen': [50, 10],
            'first_seen': [NOW - timedelta(hours=1), NOW - timedelta(days=30)],
            'permalink': ['https://sentry.test/1', 'https://sentry.test/2'],
        },
    )

    sections = dict(
        snapshot.sentry_section(
            sentry_issues,
            configured=True,
            window_start=NOW - timedelta(days=7),
            window_end=NOW + timedelta(hours=1),
        ),
    )

    assert sections['Sentry: summary'].to_dicts() == [{'new_unresolved_this_period': 1, 'total_unresolved_tracked': 2}]
    assert sections['Sentry: top by event count']['title'].to_list() == ['NPE in handler', 'Timeout in worker']


def test_build_snapshot_sections_covers_every_documented_heading():
    window = snapshot.period_window('week', NOW)
    issues = _linear_issues(_linear_issue())
    pylon_issues = _pylon_issues(_pylon_issue())

    sections = snapshot.build_snapshot_sections(
        issues,
        pl.DataFrame(schema={'issue_id': pl.Utf8, 'label': pl.Utf8}),
        pylon_issues,
        pl.DataFrame(schema={'issue_id': pl.Utf8, 'kind': pl.Utf8, 'label': pl.Utf8}),
        pl.DataFrame(schema={'first_seen': pl.Datetime('us')}),
        window=window,
        pylon_priority_values=['urgent', 'high', 'medium', 'low'],
        sla=SlaConfig(target_days_by_priority={'high': 3}),
        sentry_configured=False,
    )

    headings = [title for title, _ in sections]
    assert headings == [
        'Linear: open by priority',
        'Linear: created/closed this period',
        'Linear: untracked',
        'Linear: oldest open by priority',
        'Linear: top labels created this period (labels are sparse this period)',
        'Pylon: open by priority',
        'Pylon: created/resolved this period',
        'Pylon: resolution time this period',
        'Pylon: oldest open',
        'Pylon: top tags',
        'Sentry',
        'Notable: Pylon past SLA',
        'Notable: not computed',
    ]
