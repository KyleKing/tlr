"""Tests for the triage domain: pure frame-in, frame-out functions."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import polars as pl
import pytest

from tlr.config import LinearConfig, PylonConfig, SlaConfig, TiersConfig, TriageConfig
from tlr.domain import triage

_SLA_TARGET_DAYS = 2


def _dt(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, tzinfo=UTC).replace(tzinfo=None)


NOW = _dt(2026, 9, 2)

_PYLON_ISSUE_DEFAULTS = {
    'title': 'issue',
    'created_at': _dt(2026, 8, 20),
    'link': 'https://pylon.example/1',
    'requester_email': 'user@example.test',
    'link_status': 'linked',
    'linear_identifier': None,
    'state': 'open',
    'state_category': 'new',
    'priority': 'medium',
    'account_id': None,
    'assignee_id': None,
    'issue_type': None,
    'is_issue_group': False,
    'resolution_time': None,
    'first_response_time': None,
    'latest_message_time': None,
    'source_updated_at': None,
}

_PYLON_ISSUE_SCHEMA: dict[str, Any] = {
    'id': pl.Utf8,
    'number': pl.Int64,
    'title': pl.Utf8,
    'created_at': pl.Datetime('us'),
    'link': pl.Utf8,
    'requester_email': pl.Utf8,
    'link_status': pl.Utf8,
    'linear_identifier': pl.Utf8,
    'state': pl.Utf8,
    'state_category': pl.Utf8,
    'priority': pl.Utf8,
    'account_id': pl.Utf8,
    'assignee_id': pl.Utf8,
    'issue_type': pl.Utf8,
    'is_issue_group': pl.Boolean,
    'resolution_time': pl.Datetime('us'),
    'first_response_time': pl.Datetime('us'),
    'latest_message_time': pl.Datetime('us'),
    'source_updated_at': pl.Datetime('us'),
}


def _pylon_issue(*, id_: str, number: int, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {'id': id_, 'number': number, **_PYLON_ISSUE_DEFAULTS}
    row.update(overrides)
    return row


def _pylon_issues(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(list(rows), schema=_PYLON_ISSUE_SCHEMA)


def _issues(*rows: dict[str, object]) -> pl.DataFrame:
    schema = {'identifier': pl.Utf8, 'state_name': pl.Utf8, 'state_type': pl.Utf8, 'assignee_name': pl.Utf8}
    return pl.DataFrame(list(rows), schema=schema) if rows else pl.DataFrame(schema=schema)


def _labels(*rows: tuple[str, str, str]) -> pl.DataFrame:
    schema = {'issue_id': pl.Utf8, 'kind': pl.Utf8, 'label': pl.Utf8, 'source': pl.Utf8}
    if not rows:
        return pl.DataFrame(schema=schema)
    return pl.DataFrame(
        [{'issue_id': issue_id, 'kind': kind, 'label': label, 'source': 'pylon'} for issue_id, kind, label in rows],
        schema=schema,
    )


def _accounts(*rows: dict[str, object]) -> pl.DataFrame:
    schema = {'id': pl.Utf8, 'name': pl.Utf8, 'tier': pl.Utf8}
    return pl.DataFrame(list(rows), schema=schema) if rows else pl.DataFrame(schema=schema)


def _build(
    pylon_issues: pl.DataFrame,
    *,
    issues: pl.DataFrame | None = None,
    labels: pl.DataFrame | None = None,
    accounts: pl.DataFrame | None = None,
    triage_config: TriageConfig | None = None,
    tiers: TiersConfig | None = None,
    sla: SlaConfig | None = None,
    pylon: PylonConfig | None = None,
    linear: LinearConfig | None = None,
    now: datetime = NOW,
) -> triage.TriageQueue:
    return triage.build_triage_queue(
        pylon_issues,
        issues if issues is not None else _issues(),
        labels if labels is not None else _labels(),
        accounts if accounts is not None else _accounts(),
        now=now,
        triage=triage_config or TriageConfig(),
        tiers=tiers or TiersConfig(),
        sla=sla or SlaConfig(),
        pylon=pylon or PylonConfig(),
        linear=linear or LinearConfig(),
    )


def test_closed_category_dropped_even_when_slug_looks_open():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, state='nar', state_category='closed'),
        _pylon_issue(id_='p2', number=2, state='closed', state_category='closed'),
        _pylon_issue(id_='p3', number=3, state='open', state_category='new'),
    )

    result = _build(pylon_issues)

    assert result.queue['pylon_number'].to_list() == [3]


def test_waiting_on_customer_section_reads_category_not_slug():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, state='snoozed', state_category='waiting_on_customer'),
    )

    result = _build(pylon_issues)

    assert result.queue.is_empty()
    waiting_section = dict(result.sections)[triage.WAITING_ON_CUSTOMER_HEADING]
    assert waiting_section['pylon_number'].to_list() == [1]


@pytest.mark.parametrize(
    ('assignee_id', 'linear_assignee_name', 'expect_queue'),
    [
        ('agent-1', None, False),
        (None, 'agent-bot', False),
        (None, 'human', True),
    ],
    ids=['pylon-assignee-route', 'linear-assignee-route', 'no-agent-owner'],
)
def test_agent_owned_via_either_route(assignee_id, linear_assignee_name, expect_queue):
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, assignee_id=assignee_id, linear_identifier='DEV-1'),
    )
    issues = _issues(
        {'identifier': 'DEV-1', 'state_name': 'Todo', 'state_type': 'unstarted', 'assignee_name': linear_assignee_name},
    )
    triage_config = TriageConfig(agent_assignee_ids=['agent-1'])
    linear = LinearConfig(agent_accounts=['agent-bot'])

    result = _build(pylon_issues, issues=issues, triage_config=triage_config, linear=linear)

    assert bool(result.queue.height) == expect_queue
    sections = dict(result.sections)
    assert (triage.AGENT_OWNED_HEADING in sections) != expect_queue


def test_config_exclusion_matches_label_regardless_of_kind():
    pylon_issues = _pylon_issues(_pylon_issue(id_='p1', number=1))
    labels = _labels(('p1', 'question_type', 'spam'))
    triage_config = TriageConfig(exclusions={'spam': ['spam']})

    result = _build(pylon_issues, labels=labels, triage_config=triage_config)

    assert result.queue.is_empty()
    spam_section = dict(result.sections)['spam']
    assert spam_section['pylon_number'].to_list() == [1]


def test_exclusions_default_is_a_no_op():
    pylon_issues = _pylon_issues(_pylon_issue(id_='p1', number=1))

    result = _build(pylon_issues)

    assert result.queue.height == 1
    assert result.sections == []


def test_precedence_waiting_on_customer_beats_agent_owned_and_exclusion():
    pylon_issues = _pylon_issues(
        _pylon_issue(
            id_='p1',
            number=1,
            state_category='waiting_on_customer',
            assignee_id='agent-1',
        ),
    )
    labels = _labels(('p1', 'tag', 'spam'))
    triage_config = TriageConfig(agent_assignee_ids=['agent-1'], exclusions={'spam': ['spam']})

    result = _build(pylon_issues, labels=labels, triage_config=triage_config)

    sections = dict(result.sections)
    assert sections[triage.WAITING_ON_CUSTOMER_HEADING]['pylon_number'].to_list() == [1]
    assert list(sections) == [triage.WAITING_ON_CUSTOMER_HEADING], 'a row lands under one heading only'


def test_linear_join_fills_state_and_survives_missing_link():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, linear_identifier='DEV-1', link_status='linked'),
        _pylon_issue(id_='p2', number=2, linear_identifier=None, link_status='no_link'),
        _pylon_issue(id_='p3', number=3, linear_identifier=None, link_status='unknown'),
    )
    issues = _issues(
        {'identifier': 'DEV-1', 'state_name': 'In Progress', 'state_type': 'started', 'assignee_name': None},
    )

    result = _build(pylon_issues, issues=issues)

    by_number = {row['pylon_number']: row for row in result.queue.iter_rows(named=True)}
    assert by_number[1]['linear_state'] == 'In Progress'
    assert by_number[2]['linear_state'] is None
    assert by_number[3]['linear_state'] is None
    assert {2, 3}.issubset(by_number.keys())


def test_sla_days_remaining_negative_when_overdue():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, priority='urgent', created_at=_dt(2026, 8, 1)),
    )
    sla = SlaConfig(target_days_by_priority={'urgent': _SLA_TARGET_DAYS})

    result = _build(pylon_issues, sla=sla)

    row = result.queue.row(0, named=True)
    assert row['sla_target_days'] == _SLA_TARGET_DAYS
    assert row['sla_days_remaining'] < 0


def test_unknown_ordering_rule_raises():
    pylon_issues = _pylon_issues(_pylon_issue(id_='p1', number=1))

    with pytest.raises(ValueError, match='bogus'):
        _build(pylon_issues, triage_config=TriageConfig(ordering=['bogus']))


def test_priority_orders_most_urgent_first_and_unknown_last():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, priority='low'),
        _pylon_issue(id_='p2', number=2, priority='urgent'),
        _pylon_issue(id_='p3', number=3, priority='does-not-exist'),
        _pylon_issue(id_='p4', number=4, priority=None),
    )

    result = _build(pylon_issues, triage_config=TriageConfig(ordering=['priority']))

    assert result.queue['pylon_number'].to_list() == [2, 1, 3, 4]


def test_tier_orders_best_first_and_unknown_last():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, account_id='acc-bronze'),
        _pylon_issue(id_='p2', number=2, account_id='acc-gold'),
        _pylon_issue(id_='p3', number=3, account_id='acc-unknown-tier'),
        _pylon_issue(id_='p4', number=4, account_id=None),
    )
    accounts = _accounts(
        {'id': 'acc-bronze', 'name': 'B', 'tier': 'bronze'},
        {'id': 'acc-gold', 'name': 'G', 'tier': 'gold'},
        {'id': 'acc-unknown-tier', 'name': 'U', 'tier': 'platinum'},
    )
    tiers = TiersConfig(names=['gold', 'bronze'], default_tier='bronze')

    result = _build(pylon_issues, accounts=accounts, triage_config=TriageConfig(ordering=['tier']), tiers=tiers)

    assert result.queue['pylon_number'].to_list() == [2, 1, 4, 3]


def test_empty_tier_names_is_a_no_op():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, account_id='acc-a'),
        _pylon_issue(id_='p2', number=2, account_id='acc-b'),
    )
    accounts = _accounts(
        {'id': 'acc-a', 'name': 'A', 'tier': 'platinum'},
        {'id': 'acc-b', 'name': 'B', 'tier': 'bronze'},
    )

    result = _build(pylon_issues, accounts=accounts, triage_config=TriageConfig(ordering=['tier']))

    assert result.queue['pylon_number'].to_list() == [1, 2]


def test_age_orders_oldest_first():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, created_at=_dt(2026, 8, 30)),
        _pylon_issue(id_='p2', number=2, created_at=_dt(2026, 8, 1)),
    )

    result = _build(pylon_issues, triage_config=TriageConfig(ordering=['age']))

    assert result.queue['pylon_number'].to_list() == [2, 1]


def test_sla_distance_orders_most_overdue_first_and_missing_target_last():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, priority='urgent', created_at=_dt(2026, 8, 20)),
        _pylon_issue(id_='p2', number=2, priority='urgent', created_at=_dt(2026, 8, 1)),
        _pylon_issue(id_='p3', number=3, priority='low', created_at=_dt(2026, 8, 25)),
    )
    sla = SlaConfig(target_days_by_priority={'urgent': 5})

    result = _build(pylon_issues, triage_config=TriageConfig(ordering=['sla_distance']), sla=sla)

    assert result.queue['pylon_number'].to_list() == [2, 1, 3]


def test_an_unmapped_status_category_stays_in_the_queue():
    pylon_issues = _pylon_issues(
        _pylon_issue(id_='p1', number=1, state_category=None),
        _pylon_issue(id_='p2', number=2, state_category='closed'),
        _pylon_issue(id_='p3', number=3, state_category='new'),
    )

    result = _build(pylon_issues)

    assert result.queue['pylon_number'].to_list() == [1, 3], 'a status tlr cannot categorize still needs triage'
