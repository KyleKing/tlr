# API notes

What Linear, Pylon, Incident.io, and Google Calendar actually do, as opposed to what their docs say.
Every fact here was paid for once against a real workspace by the Deno implementation, and this file is
where it survives that implementation's deletion. Exact strings beat prose: an approximate query is
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

Linear is the odd one: the header carries the raw personal API key with no `Bearer` prefix. A `Bearer`
prefix fails with an auth error indistinguishable from a wrong key.

Keychain reads shell out to `security find-generic-password -s <service> -a <account> -w` with an
argument array, never an interpolated shell string. A non-zero exit or a missing `security` binary
resolves to "not found" rather than an error, which is the non-macOS path. Writes use
`add-generic-password -U` with the value piped on stdin twice (the tool prompts for confirmation),
never as an argv element where the process table would show it. A write is refused while the
corresponding env var is set, because the env var wins on read and the write would be invisible.

## Linear GraphQL

Endpoint `https://api.linear.app/graphql`. Relay pagination throughout: `first`/`after` with
`pageInfo { hasNextPage endCursor }`.

### Query complexity is a real wall

Complexity scales as `outer * teams * (cycles + states)`. The project query caps the outer `projects`
connection at `first: 10` because that was the measured ceiling before Linear answers "Query too
complex". If that error appears, the nested limits are the first thing to cut, not the outer one.

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

The cycles connection is ordered oldest first, so `last: 12` is required. `first: 12` silently returns
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

Project scope filters `{ project: { id: { eq: $projectId } } }`. Team scope filters
`{ team: { key: { eq: $teamKey } } }` by key, never by id: a filter on a DEV team's id returned 1305
issues belonging to the CUS and DES teams.

`includeArchived: true` is mandatory. Without it an archived issue and a deleted one look identical.

### Users

```graphql
query Users($after: String) {
  users(first: 250, after: $after) {
    nodes { name displayName email active app guest }
    pageInfo { hasNextPage endCursor }
  }
}
```

`app: true` marks Linear's own integration accounts (Slack, Sentry, Codex, Incident.io) which carry
synthetic `@*.linear.app` addresses, and `guest: true` marks external collaborators. Neither is ever on
call or out of office, so both are dropped from the roster.

### Workspace identity

```graphql
query Workspace { organization { urlKey } }
```

### Issue context for a write

Fetched only when an edit touches milestone, status, cycle, or assignee, because those arrive as names
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

`IssueUpdateInput` fields used: `title`, `description`, `estimate`, `priority`, `projectMilestoneId`,
`stateId`, `cycleId`, `assigneeId`. The three id fields accept `null` to clear.

A write requires the issue's Linear UUID recorded at ingest. Seed and offline data has no UUID and can
never be a write target until re-ingested.

Status resolution disambiguates by state `name` on the issue's own team before falling back to the first
state of the matching `type`, because a team routinely has two `type: started` states ("In Progress" and
"In Review") and picking by type alone moves the ticket to the wrong column.

`TeamUpdateInput`'s field names were never exercised against the real API. Introspect
`__type(name: "TeamUpdateInput")` before trusting any of `cyclesEnabled`, `cycleDuration`,
`issueEstimationType`, `issueEstimationAllowZero`, `issueEstimationExtended`, or `triageEnabled`.

### Field rationale worth keeping

`state { name type }` needs both: `type` is the coarse bucket and `name` separates same-type states.
`assignee { name }` rather than `displayName`, because the roster and every grouping key on `name`, and
the two differ per user. A null assignee normalizes to the string `Unassigned`, since downstream sorts
call `localeCompare` and crash on null. `history` with `fromCycle`/`toCycle` reconstructs which cycles an
issue passed through, which is how hop counts are correct on a first run instead of after weeks of
snapshots.

Cycle numbers are unique per team, not per project. A project spanning two teams gets two cycles both
numbered 12 with overlapping dates. Keep only the cycle numbers the project's own issues reference.

`relations` reports each relation once, on the owning issue: `A blocks B` appears on A and never as
`blocked` on B. Symmetrize in application code across the fetched set, or fetch `inverseRelations` and
pay the complexity. Either way a blocker outside the fetched scope stays invisible.

Pagination fails loudly when `hasNextPage` is true and `endCursor` is empty. Truncating instead reads
downstream as a mass deletion.

## Pylon REST

Base `https://api.usepylon.com`. One endpoint carries the whole integration: `POST /issues/search`.
Rate limit is 20 searches a minute, enforced with a sliding 60-second window of call timestamps. The
response cache sits outside the limiter so a cache hit costs no quota.

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
        "values": ["<start>", "<end>"]
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

A single subfilter drops the `and` wrapper. No window and no tracker id means no request at all: a bare
date range over the whole workspace is never asked for.

Which custom field holds the tracker identifier is workspace configuration, defaulting to
`linear_ticket`. Discover it with `GET /custom-fields?object_type=issue`.

The requester filter wants a Pylon contact UUID matching
`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. An email-shaped value is dropped
rather than resolved.

Responses shape as `{ data: [{ id, number, title, body_html, created_at, link, requester: { id, email } }],
pagination, request_id }`. `body_html` needs entity decoding and tag stripping, with `<br>`, `</p>`,
`</div>`, and `</li>` becoming newlines.

## Incident.io

Base `https://api.incident.io`.

- `GET /v2/schedules`, paginated by `pagination_meta.after` passed back as `?after=<cursor>`
- `GET /v2/schedule_entries?schedule_id=<id>&entry_window_start=<ISO>&entry_window_end=<ISO>`, reading
  `schedule_entries.final[]` for `user.email`, `user.name`, `start_at`, and `end_at`
- `GET /v1/identity` is the diagnostic: its `teams` array tells you whether the key is team-scoped

The expensive fact: an API key must have **empty** team-level permissions. Any team-level grant filters
`GET /v2/schedules` to that team's own schedules, so an org-wide schedule (`team_ids: []`) vanishes from
the list even though the account-level "Read schedules" grant is present and fetching that same schedule
by id still works. The failure mode is a silent zero, not an error.

## Google Calendar

OAuth 2.0 desktop-app flow over a loopback listener, scope
`https://www.googleapis.com/auth/calendar.freebusy` (the narrowest that answers the question).

- Consent `https://accounts.google.com/o/oauth2/v2/auth` with `access_type=offline&prompt=consent`
- Token `https://oauth2.googleapis.com/token`, `grant_type=authorization_code` then `refresh_token`
- Data `POST https://www.googleapis.com/calendar/v3/freeBusy` with `{ timeMin, timeMax, items: [{ id }] }`

`access_type=offline&prompt=consent` are request parameters, and they are the only way to guarantee a
refresh token on first consent. No Console setting substitutes.

Refresh-token lifetime follows the consent screen's publishing status rather than the grant type. An
External app left in Testing issues tokens that expire in seven days, which means re-consenting weekly.
Internal, or External in production, issues tokens that live until revoked or unused for six months.

Free/busy under-reports time off: a busy day is inferred from five hours of busy time or an all-day
block, so an onsite that never reaches the calendar is invisible, and an all-day event marked Free does
not appear in free/busy at all.

The OAuth flow can open a browser, so out-of-office is excluded from any unattended scheduled run.

## Slack

`POST /search.messages` with a user token (`xoxp-`). Bot tokens are refused outright, which is why the
grant flow insists on user token scopes.

- `after:` and `before:` exclude the day they name, so widen the window by a day on each side
- A window that excludes everything is ignored rather than rejected, answering as though no dates were
  given, so never send an empty or inverted window
- Multiple `in:` channel terms OR together and widen the search rather than narrowing it
- A bad token or a missing scope returns HTTP 200 with `{ "ok": false, "error": "missing_scope" }`, so
  check the body and not the status, or a scope error reads as "nobody discussed this ticket"
- Identifier search is fuzzy, so confirm client-side that the identifier really appears in the body

## Retry policy

Three attempts, 15-second timeout per attempt with its own abort signal, backoff
`500ms * 2 ** (attempt - 1)` capped at 30 seconds.

Retry on transport failures and on HTTP 429 or 5xx. Any other 4xx returns immediately, because an auth
failure or a malformed query is the caller's bug and retrying only burns quota.

`Retry-After` (delta seconds, which is the form Linear sends) overrides the computed backoff when
present and positive, capped at the same 30 seconds.

No jitter, deliberately. A single-process scheduled run has no herd to spread out, and a pure function
of the attempt number is testable.
