"""Triage queue: one row per open Pylon issue, ordered and split into held-out sections.

Every function here is pure: frames and config values in, a frame out. No network, no store
connection, no config file read.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import polars as pl

from tlr.config import LinearConfig, PylonConfig, SlaConfig, TiersConfig, TriageConfig

STATE_CATEGORY_CLOSED = 'closed'
STATE_CATEGORY_WAITING_ON_CUSTOMER = 'waiting_on_customer'

WAITING_ON_CUSTOMER_HEADING = 'waiting_on_customer'
AGENT_OWNED_HEADING = 'agent_owned'

_ORDERING_RULES = frozenset({'priority', 'tier', 'age', 'sla_distance'})

_QUEUE_SCHEMA: dict[str, Any] = {
    'pylon_number': pl.Int64,
    'title': pl.Utf8,
    'age_days': pl.Int64,
    'priority': pl.Utf8,
    'tier': pl.Utf8,
    'linear_identifier': pl.Utf8,
    'linear_state': pl.Utf8,
    'link_status': pl.Utf8,
    'waiting_on_customer': pl.Boolean,
    'agent_owned': pl.Boolean,
    'sla_target_days': pl.Int64,
    'sla_days_remaining': pl.Int64,
    'link': pl.Utf8,
}


@dataclass(frozen=True)
class TriageQueue:
    """The ordered triage queue plus the sections held out of it, ready for `sections_to_markdown`."""

    queue: pl.DataFrame
    sections: list[tuple[str, pl.DataFrame]]


def _rank(column: str, ranked_values: list[str]) -> pl.Expr:
    rank_map = {value: index for index, value in enumerate(ranked_values)}
    return pl.col(column).replace_strict(rank_map, default=len(ranked_values), return_dtype=pl.Int64)


def _sla_target(sla: SlaConfig) -> pl.Expr:
    by_priority = pl.col('priority').replace_strict(sla.target_days_by_priority, default=None, return_dtype=pl.Int64)
    by_tier = pl.col('tier').replace_strict(sla.target_days_by_tier, default=None, return_dtype=pl.Int64)
    return pl.min_horizontal(by_priority, by_tier)


def _exclusion_by_issue_id(pylon_issue_labels: pl.DataFrame, exclusions: dict[str, list[str]]) -> pl.DataFrame:
    empty = pl.DataFrame(schema={'issue_id': pl.Utf8, 'section': pl.Utf8})
    if not exclusions or pylon_issue_labels.is_empty():
        return empty

    heading_rank = {heading: index for index, heading in enumerate(exclusions)}
    exclusion_rows = [
        {'label': label, 'section': heading, 'rank': heading_rank[heading]}
        for heading, labels in exclusions.items()
        for label in labels
    ]
    if not exclusion_rows:
        return empty
    exclusion_frame = pl.DataFrame(exclusion_rows)

    matched = pylon_issue_labels.select('issue_id', 'label').join(exclusion_frame, on='label', how='inner')
    if matched.is_empty():
        return empty
    return (
        matched.sort('rank')
        .group_by('issue_id', maintain_order=True)
        .agg(pl.col('section').first())
        .select('issue_id', 'section')
    )


def _build_working_frame(
    pylon_issues: pl.DataFrame,
    issues: pl.DataFrame,
    pylon_issue_labels: pl.DataFrame,
    pylon_accounts: pl.DataFrame,
    *,
    now: datetime,
    triage: TriageConfig,
    tiers: TiersConfig,
    sla: SlaConfig,
    linear: LinearConfig,
) -> pl.DataFrame:
    linear_states = issues.select(
        pl.col('identifier').alias('linear_identifier'),
        pl.col('state_name').alias('linear_state'),
        pl.col('assignee_name').alias('linear_assignee_name'),
    )
    accounts = pylon_accounts.select(pl.col('id').alias('account_id'), pl.col('tier'))
    exclusion_headings = _exclusion_by_issue_id(pylon_issue_labels, triage.exclusions)

    joined = (
        pylon_issues.join(linear_states, on='linear_identifier', how='left')
        .join(accounts, on='account_id', how='left')
        .join(exclusion_headings, left_on='id', right_on='issue_id', how='left')
        .with_columns(pl.col('tier').fill_null(tiers.default_tier))
    )

    age_days = (pl.lit(now) - pl.col('created_at')).dt.total_days().cast(pl.Int64)
    waiting_on_customer = pl.col('state_category') == STATE_CATEGORY_WAITING_ON_CUSTOMER
    agent_owned = pl.col('assignee_id').is_in(triage.agent_assignee_ids).fill_null(value=False) | pl.col(
        'linear_assignee_name',
    ).is_in(linear.agent_accounts).fill_null(value=False)

    with_derived = joined.with_columns(
        age_days.alias('age_days'),
        waiting_on_customer.alias('waiting_on_customer'),
        agent_owned.alias('agent_owned'),
        _sla_target(sla).alias('sla_target_days'),
    ).with_columns((pl.col('sla_target_days') - pl.col('age_days')).alias('sla_days_remaining'))

    section = (
        pl.when(pl.col('waiting_on_customer'))
        .then(pl.lit(WAITING_ON_CUSTOMER_HEADING))
        .when(pl.col('agent_owned'))
        .then(pl.lit(AGENT_OWNED_HEADING))
        .otherwise(pl.col('section'))
    )

    return with_derived.with_columns(section.alias('section')).select(
        pl.col('id').alias('issue_id'),
        pl.col('section'),
        pl.col('number').alias('pylon_number'),
        pl.col('title'),
        pl.col('age_days'),
        pl.col('priority'),
        pl.col('tier'),
        pl.col('linear_identifier'),
        pl.col('linear_state'),
        pl.col('link_status'),
        pl.col('waiting_on_customer'),
        pl.col('agent_owned'),
        pl.col('sla_target_days'),
        pl.col('sla_days_remaining'),
        pl.col('link'),
    )


def _order(rows: pl.DataFrame, ordering: list[str], pylon: PylonConfig, tiers: TiersConfig) -> pl.DataFrame:
    unknown = [rule for rule in ordering if rule not in _ORDERING_RULES]
    if unknown:
        msg = f'unknown triage ordering rule: {unknown[0]!r}'
        raise ValueError(msg)
    if rows.is_empty():
        return rows.select(list(_QUEUE_SCHEMA))

    rank_exprs = {
        'priority': _rank('priority', pylon.priority_values).alias('_priority_rank'),
        'tier': _rank('tier', tiers.names).alias('_tier_rank'),
        'age': (-pl.col('age_days')).alias('_age_rank'),
        'sla_distance': pl.col('sla_days_remaining').fill_null(2**62).alias('_sla_rank'),
    }
    rank_columns = {'priority': '_priority_rank', 'tier': '_tier_rank', 'age': '_age_rank', 'sla_distance': '_sla_rank'}

    ranked = rows.with_columns(*(rank_exprs[rule] for rule in ordering))
    sort_cols = [rank_columns[rule] for rule in ordering]
    return ranked.sort(sort_cols, maintain_order=True).select(list(_QUEUE_SCHEMA))


def build_triage_queue(
    pylon_issues: pl.DataFrame,
    issues: pl.DataFrame,
    pylon_issue_labels: pl.DataFrame,
    pylon_accounts: pl.DataFrame,
    *,
    now: datetime,
    triage: TriageConfig,
    tiers: TiersConfig,
    sla: SlaConfig,
    pylon: PylonConfig,
    linear: LinearConfig,
) -> TriageQueue:
    """Build the ordered triage queue and its held-out sections.

    `sla_target_days` is the tighter (smaller) of `SlaConfig.target_days_by_priority` and
    `target_days_by_tier` when both apply to a row; either being absent leaves that half out
    of the comparison, and neither applying leaves the target, and so `sla_days_remaining`, null.

    A row whose `state_category` is `closed` is dropped entirely. A null category means the
    status slug was not in the workspace's status list, so the row stays in the queue: an
    unrecognized status is the one most in need of a human look.

    Everything else held out of the ordered queue is held out by this precedence:
    waiting-on-customer, agent-owned, then the first matching heading in `triage.exclusions`.
    Everything left is the ordered queue. A section with no rows is left out.
    """
    open_issues = pylon_issues.filter(pl.col('state_category').ne_missing(STATE_CATEGORY_CLOSED))
    working = _build_working_frame(
        open_issues,
        issues,
        pylon_issue_labels,
        pylon_accounts,
        now=now,
        triage=triage,
        tiers=tiers,
        sla=sla,
        linear=linear,
    )

    headings = [WAITING_ON_CUSTOMER_HEADING, AGENT_OWNED_HEADING, *triage.exclusions]
    queue_rows = working.filter(pl.col('section').is_null()).drop('issue_id', 'section')
    queue = _order(queue_rows, triage.ordering, pylon, tiers)

    sections: list[tuple[str, pl.DataFrame]] = []
    for heading in headings:
        section_rows = working.filter(pl.col('section') == heading).drop('issue_id', 'section')
        if section_rows.is_empty():
            continue
        sections.append((heading, _order(section_rows, triage.ordering, pylon, tiers)))

    return TriageQueue(queue=queue, sections=sections)
