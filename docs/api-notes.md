# API notes

What Linear, Pylon, Incident.io, and Google Calendar actually do, as opposed to what
their docs say.
Every fact here was paid for once against a real workspace by the Deno implementation,
and this file is
where it survives that implementation's deletion.
Exact strings beat prose: an approximate query is
worth nothing.

## Auth, per service

| Service         | Header                          | Secret source                                                   |
| --------------- | ------------------------------- | --------------------------------------------------------------- |
| Linear          | `Authorization: <key>` (raw)    | `LINEAR_API_KEY`, else keychain `tlr-linear` / `api-key`        |
| Linear (demo)   | `Authorization: <key>` (raw)    | `LINEAR_DEMO_API_KEY`, else keychain `tlr-linear` / `demo-key`  |
| Pylon           | `Authorization: Bearer <token>` | `PYLON_API_TOKEN`, else keychain `tlr-pylon` / `api-token`      |
| Incident.io     | `Authorization: Bearer <token>` | `INCIDENT_IO_TOKEN`, else keychain `tlr-incidentio` / `api-key` |
| Slack           | `Authorization: Bearer <token>` | `SLACK_USER_TOKEN`, else keychain `tlr-slack` / `user-token`    |
| Google Calendar | `Authorization: Bearer <token>` | OAuth loopback, client JSON and refresh token in the data dir   |

Linear is the odd one: the header carries the raw personal API key with no `Bearer`
prefix.
A `Bearer`
prefix fails with an auth error indistinguishable from a wrong key.

Keychain reads shell out to
`security find-generic-password -s <service> -a <account> -w` with an
argument array, never an interpolated shell string.
A non-zero exit or a missing `security` binary
resolves to "not found" rather than an error, which is the non-macOS path.
Writes use
`add-generic-password -U` with the value piped on stdin twice (the tool prompts for
confirmation),
never as an argv element where the process table would show it.
A write is refused while the
corresponding env var is set, because the env var wins on read and the write would be
invisible.

## Linear GraphQL

Endpoint `https://api.linear.app/graphql`.
Relay pagination throughout: `first`/`after` with
`pageInfo { hasNextPage endCursor }`.

### Query complexity is a real wall

Complexity scales as `outer * teams * (cycles + states)`.
The project query caps the outer `projects`
connection at `first: 10` because that was the measured ceiling before Linear answers
"Query too
complex".
If that error appears, the nested limits are the first thing to cut, not the outer one.

### Projects, teams, cycles, and states

```graphql
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
```

Filter by `containsIgnoreCase` on `name`, then fall back to `slugId`.

The cycles connection is ordered oldest first, so `last: 12` is required.
`first: 12` silently returns
the twelve earliest cycles a long-running team ever had.

### Team by key

```graphql
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
```

### Issues

```graphql
query Issues($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 100, after: $after, includeArchived: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      archivedAt
      createdAt
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
```

Project scope filters `{ project: { id: { eq: $projectId } } }`.
Team scope filters
`{ team: { key: { eq: $teamKey } } }` by key, never by id: a filter on a DEV team's id
returned 1305
issues belonging to the CUS and DES teams.

`includeArchived: true` is mandatory. Without it an archived issue and a deleted one
look identical.

### Users

```graphql
query Users($after: String) {
  users(first: 250, after: $after) {
    nodes { name displayName email active app guest }
    pageInfo { hasNextPage endCursor }
  }
}
```

`app: true` marks Linear's own integration accounts (Slack, Sentry, Codex, Incident.io)
which carry
synthetic `@*.linear.app` addresses, and `guest: true` marks external collaborators.
Neither is ever on
call or out of office, so both are dropped from the roster.

### Workspace identity

```graphql
query Workspace { organization { urlKey } }
```

### Issue context for a write

Fetched only when an edit touches milestone, status, cycle, or assignee, because those
arrive as names
and numbers and have to become UUIDs.

```graphql
query IssueContext($id: String!) {
  issue(id: $id) {
    team {
      states(first: 50) { nodes { id name type } }
      cycles(first: 50) { nodes { id number } }
      members(first: 100) { nodes { id name displayName } }
    }
    project { projectMilestones(first: 50) { nodes { id name } } }
  }
}
```

### The one write

```graphql
mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}
```

`IssueUpdateInput` fields used: `title`, `description`, `estimate`, `priority`,
`projectMilestoneId`,
`stateId`, `cycleId`, `assigneeId`.
The three id fields accept `null` to clear.

A write requires the issue's Linear UUID recorded at ingest.
Seed and offline data has no UUID and can
never be a write target until re-ingested.

Status resolution disambiguates by state `name` on the issue's own team before falling
back to the first
state of the matching `type`, because a team routinely has two `type: started` states
("In Progress" and
"In Review") and picking by type alone moves the ticket to the wrong column.

`TeamUpdateInput`'s field names were never exercised against the real API.
Introspect
`__type(name: "TeamUpdateInput")` before trusting any of `cyclesEnabled`,
`cycleDuration`,
`issueEstimationType`, `issueEstimationAllowZero`, `issueEstimationExtended`, or
`triageEnabled`.

### Field rationale worth keeping

`state { name type }` needs both: `type` is the coarse bucket and `name` separates
same-type states.
`assignee { name }` rather than `displayName`, because the roster and every grouping key
on `name`, and
the two differ per user.
A null assignee normalizes to the string `Unassigned`, since downstream sorts
call `localeCompare` and crash on null.
`history` with `fromCycle`/`toCycle` reconstructs which cycles an
issue passed through, which is how hop counts are correct on a first run instead of
after weeks of
snapshots.

Cycle numbers are unique per team, not per project.
A project spanning two teams gets two cycles both
numbered 12 with overlapping dates.
Keep only the cycle numbers the project's own issues reference.

`relations` reports each relation once, on the owning issue: `A blocks B` appears on A
and never as
`blocked` on B.
Symmetrize in application code across the fetched set, or fetch `inverseRelations` and
pay the complexity.
Either way a blocker outside the fetched scope stays invisible.

Pagination fails loudly when `hasNextPage` is true and `endCursor` is empty.
Truncating instead reads
downstream as a mass deletion.

## Pylon REST

Base `https://api.usepylon.com`. The endpoints tlr uses are `GET /issues`,
`POST /issues/search`,
`GET /issue-statuses`, and
`GET /accounts`.
`GET /issues/{id}` and `POST /accounts/search` also exist.
The response cache sits outside the rate limiter so a cache hit costs no quota.

Refresh reads `GET /issues`, not per-ticket search: it takes required
`start_time`/`end_time` RFC3339 query params (rejects naive timestamps) with a 365-day
cap, paginates by `cursor`, and is not billed against the search rate limit.
A Linear link shows up in a row's `external_issues`
(`{"source": "linear", "link": "https://linear.app/<ws>/issue/<IDENT>/…"}`) and
sometimes in the `linear_ticket`
custom field, which holds either a bare identifier or a full URL; the identifier is
pulled out of either shape by regex.

Lookup by tracker link:

```json
{
  "filter": {
    "field": "linear_ticket",
    "operator": "equals",
    "value": "DEV-1234"
  },
  "limit": 25
}
```

Wider net over a time window, optionally by requester and free text:

```json
{
  "filter": {
    "operator": "and",
    "subfilters": [
      {
        "field": "created_at",
        "operator": "time_range",
        "values": [
          "<start>",
          "<end>"
        ]
      },
      {
        "field": "requester_id",
        "operator": "equals",
        "value": "<pylon-contact-uuid>"
      }
    ]
  },
  "limit": 25,
  "search_text": "<free text>"
}
```

A single subfilter drops the `and` wrapper.
No window and no tracker id means no request at all: a bare
date range over the whole workspace is never asked for.
An empty result set returns only `{"request_id": ...}` — `data` and `pagination` are
omitted rather than emptied.

Which custom field holds the tracker identifier is workspace configuration, defaulting
to
`linear_ticket`.
Discover it with `GET /custom-fields?object_type=issue`.

The requester filter wants a Pylon contact UUID matching
`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
An email-shaped value is dropped
rather than resolved.

`body_html` needs entity decoding and tag stripping, with `<br>`, `</p>`, `</div>`, and
`</li>` becoming newlines.
The record's full shape is below.

### Statuses and categories

`GET /issue-statuses` returns every status this workspace has.
Each one carries a `slug`,
a `label`, and a `category`.
The five categories are Pylon's own vocabulary and
are stable across workspaces: `new`, `waiting_on_you`, `waiting_on_customer`, `on_hold`,
and
`closed`.
The slugs are not stable, because an admin adds statuses freely.

This workspace has ten statuses across those five categories, and four of them
(`closed`, `nar`, `resolved`, `won_t_fix`) sit in the `closed` category.
So a query that
excludes the slug `closed` still returns closed tickets, which I confirmed by running
one:
it came back full of `nar` rows.
Read the category for every open, closed, or
waiting-on-customer decision, and treat the slug as display text.

`state_category` is stored on each row for exactly this reason, and an unmapped slug
stores
`NULL` rather than a guess.

### The issue record

A real record carries `id`, `number`, `title`, `body_html`, `created_at`, `updated_at`,
`link`, `state`, `tags`, `custom_fields`, `source`, `type`, `is_issue_group`, `account`,
`assignee`, `requester`, `team`, `resolution_time`, `resolution_seconds`,
`business_hours_resolution_seconds`, `first_response_time`, `latest_message_time`,
`time_in_status_seconds`, `business_hours_time_in_status_seconds`, `number_of_touches`,
`attachment_urls`, `customer_portal_visible`, `author_unverified`, and
`workspace_email`.

`resolution_time` is the close timestamp.
There is no `resolved_at` on the record: that name
exists only as a filter attribute, alongside `solved_at`.
`assignee` is `null` when nobody
owns the ticket.
`link` looks like `https://app.usepylon.com/issues?issueNumber=<number>`, not
the `/issues/<id>` form an earlier note claimed.

`time_in_status_seconds` breaks time down per status, and
`issue_in_current_state_duration`
exists as a filter attribute.
tlr stores neither, which is why the backlog metric counts days
since creation rather than days in the current state.

### Custom fields

`custom_fields` is keyed by slug, and each value is an object rather than a scalar:

```text
"custom_fields": {
  "priority": {"value": "low", "interpreted_value": "Low"},
  "question_type": {"value": "", "values": ["no_action_required"], "interpreted_values": ["No Action Required"]}
}
```

Single-valued fields use `value`, multiselects use `values`, and the `interpreted_*`
variants
carry the human label.
Reading the container as `{<slug>: <scalar>}` yields a dict where a
string belongs, so a linked ticket looks linked while its identifier is unusable.
An entry
present in an unexpected shape resolves to `link_status: unknown`, because a confident
`no_link` on a shape nobody has seen is the worse answer.

This workspace's issue fields include `linear_ticket` (text), `priority` (select, with
the
options `urgent`, `high`, `medium`, `low`), `question_type` (multiselect, with `bug`,
`feature_request`, `user_error`, `general_support`, `no_action_required`, and
`admin_request`), `due_date`, and `article_status`.
Discover them with
`GET /custom-fields?object_type=issue`.

### Accounts and tiers

`GET /accounts` and `POST /accounts/search` both exist, and an account carries `id`,
`name`,
`type`, `domain`, `tags`, `custom_fields` in the same shape as above, `owner`, and
`external_ids`.

There is no tier field. This workspace's account custom fields are a lifecycle select, a
products multiselect, two Hubspot revenue fields, and two calendar meeting dates.
Their
option values are workspace vocabulary, so they stay out of this repo and in the local
config.
So tier ordering in
the triage queue has no data source until someone picks a field for it, and
`[tiers].account_tier_field` names whichever one that turns out to be.
Left empty, every
account keeps `[tiers].default_tier` and the tier ordering rule does nothing.
The lifecycle field and annual revenue are the two candidates, and choosing
between them is a judgment call rather than a lookup.

A tier set by hand survives every later refresh, because `pylon_accounts` is
provenance-tracked and `manual` outranks `pylon` on a field.

### Pagination

Every list and search response wraps its payload the same way:

```json
{
  "data": [],
  "pagination": {
    "cursor": "string",
    "has_next_page": true
  },
  "request_id": "string"
}
```

Where the cursor goes back depends on the method.
`GET` list endpoints take it as a **query parameter** (`?cursor=<value>`).
`POST /issues/search` takes it as a **`cursor` field in the request body**, and silently
ignores the query-parameter form: every page returns page one's rows, with no error to
notice.
`has_next_page` says whether to ask again either way.

### Rate limiting

The documented limit covers issue searches: 20 a minute, enforced with a sliding
60-second
window of call timestamps.
tlr passes `POST` searches through that window and lets `GET`
requests past it, because no published limit covers them.
If a `GET` starts returning 429 the
shared retry policy already honors `Retry-After`, so the failure degrades into slowness
rather than an error, and that is the signal to widen the limiter.

The budgets are separate, confirmed by `x-rate-limit-remaining` on live responses:
`GET /accounts` reported 299 (a ~300 ceiling) while `POST /issues/search` reported 119
(a ~120 ceiling) and stayed at 119 across four rapid calls, so the header's window is
longer than a minute or lags.
GETs do not consume the search budget; what consumes the
search budget beyond each POST is unknown.

### Still unverified

- The AI-agent filter attributes (`issue_ai_agent_has_resolved`, `issue_ai_agent_id`, and
    about a dozen more) appear in the filter vocabulary but did not appear on the record I
    read,
    which had no agent involvement.
    They are the native answer to splitting resolved tickets by
    human against agent, and tlr's configured-id list is the stopgap until their record
    shape is
    known

## Incident.io

Base `https://api.incident.io`.

- `GET /v2/schedules`, paginated by `pagination_meta.after` passed back as
    `?after=<cursor>`
- `GET /v2/schedule_entries?schedule_id=<id>&entry_window_start=<ISO>&entry_window_end=<ISO>`,
    reading
    `schedule_entries.final[]` for `user.email`, `user.name`, `start_at`, and `end_at`
- `GET /v1/identity` is the diagnostic: its `teams` array tells you whether the key is
    team-scoped

The expensive fact: an API key must have **empty** team-level permissions.
Any team-level grant filters
`GET /v2/schedules` to that team's own schedules, so an org-wide schedule
(`team_ids: []`) vanishes from
the list even though the account-level "Read schedules" grant is present and fetching
that same schedule
by id still works.
The failure mode is a silent zero, not an error.

## Google Calendar

OAuth 2.0 desktop-app flow over a loopback listener, scope
`https://www.googleapis.com/auth/calendar.freebusy` (the narrowest that answers the
question).

- Consent `https://accounts.google.com/o/oauth2/v2/auth` with
    `access_type=offline&prompt=consent`
- Token `https://oauth2.googleapis.com/token`, `grant_type=authorization_code` then
    `refresh_token`
- Data `POST https://www.googleapis.com/calendar/v3/freeBusy` with
    `{ timeMin, timeMax, items: [{ id }] }`

`access_type=offline&prompt=consent` are request parameters, and they are the only way
to guarantee a
refresh token on first consent.
No Console setting substitutes.

Refresh-token lifetime follows the consent screen's publishing status rather than the
grant type.
An
External app left in Testing issues tokens that expire in seven days, which means
re-consenting weekly.
Internal, or External in production, issues tokens that live until revoked or unused for
six months.

Free/busy under-reports time off: a busy day is inferred from five hours of busy time or
an all-day
block, so an onsite that never reaches the calendar is invisible, and an all-day event
marked Free does
not appear in free/busy at all.

The OAuth flow can open a browser, so out-of-office is excluded from any unattended
scheduled run.

## Slack

`POST /search.messages` with a user token (`xoxp-`).
Bot tokens are refused outright, which is why the
grant flow insists on user token scopes.

- `after:` and `before:` exclude the day they name, so widen the window by a day on each
    side
- A window that excludes everything is ignored rather than rejected, answering as though
    no dates were
    given, so never send an empty or inverted window
- Multiple `in:` channel terms OR together and widen the search rather than narrowing it
- A bad token or a missing scope returns HTTP 200 with
    `{ "ok": false, "error": "missing_scope" }`, so
    check the body and not the status, or a scope error reads as "nobody discussed this
    ticket"
- Identifier search is fuzzy, so confirm client-side that the identifier really appears in
    the body

## Retry policy

Three attempts, 15-second timeout per attempt with its own abort signal, backoff
`500ms * 2 ** (attempt - 1)` capped at 30 seconds.

Retry on transport failures and on HTTP 429 or 5xx.
Any other 4xx returns immediately, because an auth
failure or a malformed query is the caller's bug and retrying only burns quota.

`Retry-After` (delta seconds, which is the form Linear sends) overrides the computed
backoff when
present and positive, capped at the same 30 seconds.

No jitter, deliberately. A single-process scheduled run has no herd to spread out, and a
pure function
of the attempt number is testable.
