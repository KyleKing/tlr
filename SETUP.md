# Day-zero setup

Every credential tlr needs, where to get it, and where it lives.
Nothing here runs through Claude or an
MCP connector: each service is reached over its own REST or GraphQL API with a key you
mint yourself, so
a fresh machine can run the tool once these steps are done.

Secrets live in the macOS keychain (one entry per service, read by the `security` CLI)
or come from
1Password via `op read` (see [From 1Password](#from-1password)).
The long-term target is a hosted runner
with per-user namespaced secrets ([Long-term](#long-term-a-hosted-runner)), so treat
every service as
"one named secret" rather than "a file on my laptop".

## At a glance

`tlr/secrets.py`'s `SECRETS` registry is the source of truth for every env var and
keychain
entry below; this table follows it.

| Service         | Secret                          | Env var               | Keychain service / account   |
| --------------- | ------------------------------- | --------------------- | ---------------------------- |
| Linear          | personal API key                | `LINEAR_API_KEY`      | `tlr-linear` / `api-key`     |
| Linear (demo)   | free-workspace API key          | `LINEAR_DEMO_API_KEY` | `tlr-linear` / `demo-key`    |
| Incident.io     | API key (read schedules)        | `INCIDENT_IO_TOKEN`   | `tlr-incidentio` / `api-key` |
| Pylon           | API token (read issues)         | `PYLON_API_TOKEN`     | `tlr-pylon` / `api-token`    |
| Sentry          | auth token (read issues)        | `SENTRY_AUTH_TOKEN`   | `tlr-sentry` / `api-token`   |
| Slack           | user token, `search:read`       | `SLACK_USER_TOKEN`    | `tlr-slack` / `user-token`   |
| Google Calendar | OAuth client JSON (Desktop app) | (file, see below)     | (file, see below)            |

Only Linear, Pylon, and Sentry have adapters today.
The Incident.io, Google Calendar, and Slack rows are
here because their credential-minting steps are the part worth writing down once, and
the traps
below cost real time to find.

## Storing a secret

Keychain, one entry per service, account `api-key` (you are prompted for the value, so
it never lands in
shell history):

```sh
security add-generic-password -s <service> -a api-key -w
```

Read it back with the same `-s`/`-a` and `-w` to confirm.
Delete and re-add to rotate.

### From 1Password

If a secret already lives in 1Password, skip the keychain and pass it inline.
Every secret reads its
env var first and the keychain second, so `INCIDENT_IO_TOKEN`, `LINEAR_API_KEY`,
`LINEAR_DEMO_API_KEY`,
and `PYLON_API_TOKEN` all work this way:

```sh
LINEAR_API_KEY=$(op read "op://<vault>/<item>/<field>") uv run tlr refresh --source linear --dry-run
PYLON_API_TOKEN=$(op read "op://Private/Pylon API Token/password") uv run tlr triage --limit 5
```

An env var wins over the keychain on read.
tlr has no secret-write path at all: it reads, and you mint
and store credentials with the commands here.

## Linear

1. [Linear → Personal API keys](https://linear.app/settings/api): create a key named `tlr`,
    copy the
    value (shown once)
1. Store it: `security add-generic-password -s tlr-linear -a api-key -w` (or read from
    1Password, above)

A personal key inherits your own access, enough to read issues and resolve the roster.
The auth header
carries the raw key (`Authorization: <key>`) with no `Bearer` prefix, which is a Linear
quirk.
A
`Bearer` prefix fails with an auth error indistinguishable from a wrong key.

Verify: `uv run tlr refresh --source linear --dry-run`.

### Demo (free/test) workspace

Every write to Linear happens only after a preview a person confirms (see
[DECISIONS.md](DECISIONS.md)),
and a free Linear workspace is where to exercise that path without touching real
tickets.
Store that
workspace's key under the same service with account `demo-key`:

```sh
security add-generic-password -s tlr-linear -a demo-key -w   # paste the free-workspace key
```

Read it as the `linear-demo` secret name.
Each mode also honors an env override
(`LINEAR_API_KEY` / `LINEAR_DEMO_API_KEY`) for CI, where a keychain is not available.

## Incident.io

On-call comes from the Incident.io REST API.
There is no CLI and no MCP, so a key is the only path.

1. [Incident.io → API keys](https://app.incident.io/~/settings/api-keys): add a key named
    `tlr` and,
    under **Account-level permissions**, select only **Read schedules**.
    That covers `GET /v2/schedules`
    and `GET /v2/schedule_entries`.
    Don't grant write or manage scopes for a read-only feed
1. Leave **Team-level permissions** empty. This is the trap: a team-scoped key filters
    `GET /v2/schedules` to schedules that team owns, so an org-wide schedule (one with
    `team_ids: []`)
    drops out of the list and the feed sees zero, even though the account-level Read
    schedules grant is
    present and a fetch by schedule id still works.
    If a key already has a team (e.g. Engineering) under
    Team-level permissions, remove it
1. Copy the token (shown once) and store it:
    `security add-generic-password -s tlr-incidentio -a api-key -w`

The base host is `https://api.incident.io` and the header is
`Authorization: Bearer <key>`.
A key keeps
working after its creator is deactivated, so it acts as a service credential.

Diagnose scoping with the identity endpoint:
`curl -H "Authorization: Bearer <key>" https://api.incident.io/v1/identity` shows the
key's `teams`.
A non-empty `teams` array means the list is
team-filtered; `teams: []` sees every schedule.

On-call only counts for people already in `[[capacity.roster]]` in your config file, so
anyone on call
who is not rostered is dropped from the deflation.

## Pylon

Support tickets reach tlr as a context source (see [DECISIONS.md](DECISIONS.md)):
read-only, one search per
issue, never part of the plan.
Direct REST, because an MCP connector does not survive a scheduled run.

1. [Pylon → API tokens](https://app.usepylon.com/settings/api-tokens): create a token named
    `tlr`.
    Every
    action is attributed to the token's name, so give it one you will recognize in an audit
    log
1. Store it: `security add-generic-password -s tlr-pylon -a api-token -w` (env var
    `PYLON_API_TOKEN`)

The base host is `https://api.usepylon.com` and the header is
`Authorization: Bearer <token>`.
Issue
search is limited to 20 requests a minute on a sliding window, which every search call
goes through
`SlidingWindowLimiter` in `tlr/http.py` to respect.

Which custom field records the tracker identifier is a workspace's own choice.
Set
`[pylon].linear_ticket_field` in your config file (`config.sample.toml` has the shape);
`GET /custom-fields?object_type=issue` lists what a workspace has.

Verify: `uv run tlr refresh --source pylon --dry-run`.

## Slack

The same context source (see [DECISIONS.md](DECISIONS.md)) port, over messages.
Search needs a **user**
token (`xoxp-`), not a bot token: `search.messages` refuses a bot token outright.

1. [Slack → Your apps](https://api.slack.com/apps): create an app in the workspace, add the
    `search:read` **user** token scope under OAuth & Permissions, install it, and copy the
    User OAuth
    Token
1. Store it: `security add-generic-password -s tlr-slack -a user-token -w` (env var
    `SLACK_USER_TOKEN`)

Scoping every search to a channel list belongs in the config file when the Slack adapter
lands; several
channels are OR, so a list widens the search rather than narrowing it.
Search is limited to 20 requests
a minute.

Require search text or a reporter before running a wide search, because a date range on
its own is every
message in the workspace for a fortnight.
A reporter has to be a Slack user id (`U…`), which is the same
trap Pylon's requester filter sets: an email is dropped rather than resolved.

## Google Calendar

Out-of-office and onsite days come from Google Calendar.
Which auth model you need depends on whose
calendar you read:

- OAuth 2.0 client (Desktop app), for your own credentials.
    You consent once in a browser and the script
    caches a refresh token.
    This also reads teammates' free/busy when the Workspace shares it (the
    default), the same data the Calendar webapp's "Find a time" view shows.
    It is the right route for a
    free/busy out-days feed
- Service account with domain-wide delegation, for reading teammates' event details when
    free/busy
    sharing is off.
    A Workspace super admin authorizes the delegation.
    Not needed for a free/busy feed

### OAuth client (own credentials, free/busy)

1. [Enable the Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
    for your project
1. [Configure the consent screen](https://console.cloud.google.com/auth/branding): pick
    **Internal** if
    everyone is inside your Workspace, otherwise **External** and add yourself as a test
    user
1. [Create an OAuth client](https://console.cloud.google.com/auth/clients): application
    type
    **Desktop app**, then download the client JSON
1. Save the JSON as `gcal-client.json` in the data directory `tlr config path` reports
    (`$TLR_DATA_DIR`,
    else the XDG data dir), alongside the cached `gcal-token.json`

The first run opens the browser once for consent and caches a refresh token.
Free/busy converts into
out-days by counting a weekday once its busy time reaches 5 hours, or when it carries an
all-day block.

The refresh token is not a Console setting.
The flow opens the auth URL with `access_type=offline` and
`prompt=consent`, and Google returns the refresh token on that first consent.
Those parameters live in
the script's request, not the Console, which is why you won't find a toggle for them.

How long the cached token lasts is set by the consent screen's publishing status, not by
the auth
method.
An **External** app left in **Testing** issues refresh tokens that expire after 7 days,
so the
browser consent returns every week.
An **Internal** app (everyone inside the Workspace) or an External
app published to **In production** issues refresh tokens that do not expire on a timer,
so the one
consent holds until the token is revoked or unused for six months.
Set the consent screen to Internal,
or publish to production, to avoid the weekly re-consent.

This is the live adapter behind the out-days port (the spike-then-productionize rule in
[DECISIONS.md](DECISIONS.md)).
It runs as a local OAuth client, and moving to a hosted, per-user
credential is the remaining gap before a shared runner can use it.

### Service account (teammates' event details)

1. [Create a service account](https://console.cloud.google.com/iam-admin/serviceaccounts),
    open it →
    Keys → Add key → JSON, download it, and copy its numeric Client ID
1. A Workspace super admin authorizes delegation: Admin console → Security → Access and
    data control →
    API controls → Manage Domain Wide Delegation → Add new, paste the Client ID and the
    scopes.
    Propagation can take up to a day
1. The script impersonates each teammate by setting the subject to their email when it
    mints a token

### Scopes

Least-privilege, narrowest first:

- [`calendar.freebusy`](https://www.googleapis.com/auth/calendar.freebusy) reads free/busy
    only (what
    the spike uses)
- [`calendar.events.readonly`](https://www.googleapis.com/auth/calendar.events.readonly)
    reads events on
    the user's calendars
- [`calendar.readonly`](https://www.googleapis.com/auth/calendar.readonly) also lists
    calendars and
    covers free/busy

A teammate query returns real data only if you can see their availability: Workspace
free/busy sharing
for an OAuth user, or domain-wide delegation for the service account.
Without one, a peer query comes
back empty.

## Scheduled refresh

There is no scheduled refresh right now.
The Deno app's hourly LaunchAgent is unloaded and its
`scripts/schedule.sh` is deleted along with the rest of that implementation;
`uv run tlr refresh` is a
command you run by hand.
What it already captured sits in `web/data/tlr.sqlite`, which
`tlr import-snapshots` reads once.

Three facts from that LaunchAgent are worth keeping for whenever a schedule comes back,
because each
one cost a real debugging session:

- macOS fires a missed `StartCalendarInterval` entry once when the machine wakes, and
    folds several
    missed ones into that single run.
    `StartInterval` has no catch-up at all, which is why the schedule
    was eight calendar entries rather than one timer
- catch-up needs two guards or it becomes duplicate work: a lock file so a catch-up cannot
    collide with
    a run already going, and a minimum start-to-start interval so a catch-up landing right
    after a good
    run does nothing.
    A lock older than the worst-case bounded run is treated as abandoned and taken over
- a LaunchAgent gets no shell `PATH`, so the plist holds the absolute path to the
    interpreter and has to
    be reinstalled after upgrading it

Google Calendar stays out of any scheduled run.
Consent can need a browser, which a background job
cannot answer, so out-days keep whatever the last interactive run wrote.

## Long-term: a hosted runner

Local keychain entries are the day-zero shortcut.
On a shared runner each user's credentials become
per-user namespaced secrets (a secret manager keyed by user id), and `tlr/secrets.py`
grows a third
`SecretStore` implementation reading from that namespace instead of `security`.
The contract stays the
same: one named secret per service per user, least-privilege scopes, and read-only where
the tool only
reports.
Plan new credentials to fit that shape so the move off the laptop stays a config change.
