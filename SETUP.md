# Day-zero setup

Every credential TLR needs, where to get it, and where it lives. Nothing here runs through Claude or an
MCP connector: each service is reached by a script with a key you mint yourself, so a fresh machine can
run the tool once these steps are done.

Secrets live in the macOS keychain (one entry per service, read by the `security` CLI) or come from
1Password via `op read` (see [From 1Password](#from-1password)). The long-term target is a hosted runner
with per-user namespaced secrets ([Long-term](#long-term-a-hosted-runner)), so treat every service as
"one named secret" rather than "a file on my laptop".

## At a glance

| Service         | Secret                          | Stored as                              | Used by                                |
| --------------- | ------------------------------- | -------------------------------------- | -------------------------------------- |
| Linear          | personal API key                | keychain `tlr-linear` or `op read`     | issue fetch, `deno task roster`        |
| Incident.io     | API key (read schedules)        | keychain `tlr-incidentio` or `op read` | `deno task capacity --source incident` |
| Google Calendar | OAuth client JSON (Desktop app) | `web/data/gcal-client.json`            | `deno task gcal:freebusy`              |

## Storing a secret

Keychain, one entry per service, account `api-key` (you are prompted for the value, so it never lands in
shell history):

```sh
security add-generic-password -s <service> -a api-key -w
```

Read it back with the same `-s`/`-a` and `-w` to confirm. Delete and re-add to rotate.

### From 1Password

If a secret already lives in 1Password, skip the keychain and pass it inline. The scripts read the env
vars `LINEAR_API_KEY` and `INCIDENT_IO_TOKEN` as well as the keychain:

```sh
LINEAR_API_KEY=$(op read "op://<vault>/<item>/<field>") deno task roster --dry-run --force
```

## Linear

1. [Linear → Personal API keys](https://linear.app/settings/api): create a key named `tlr`, copy the
   value (shown once)
2. Store it: `security add-generic-password -s tlr-linear -a api-key -w` (or read from 1Password, above)

A personal key inherits your own access, enough to read issues and resolve the roster. The auth header
is the raw key (`Authorization: <key>`), not a Bearer token, which is a Linear quirk.

Verify: `deno task roster --dry-run --force` prints each assignee resolved to an email, and
`deno task issues "<project name>" --dry-run` prints the project's issue count.

### Demo (free/test) workspace

Edits from the Review page write to Linear. To try them without touching real tickets, run the server in
demo mode against a free Linear workspace. Store that workspace's key under the same service with account
`demo-key`, then launch with `TLR_DEMO=1`:

```sh
security add-generic-password -s tlr-linear -a demo-key -w   # paste the free-workspace key
TLR_DEMO=1 deno task dev                                     # banner shows you are in demo mode
```

Live mode (the default, no `TLR_DEMO`) uses the `api-key` entry above. Each mode also honors an env
override (`LINEAR_API_KEY` / `LINEAR_DEMO_API_KEY`) for CI, where a keychain is not available. To edit a
ticket, first refresh issues from that workspace so each carries its Linear id; the edit form refuses to
write a ticket it has no id for.

To fill an empty demo workspace with sample data, `deno task seed:linear` creates a throwaway "Horse
Tinder" project (milestones, issues, a couple with deliberate slop, a few relations). It is guarded to
the `tlr-demo-workspace` org and dry-runs by default; pass `--write` to apply, and re-running archives
the prior seed rather than piling up duplicates. Then ingest it with
`LINEAR_API_KEY=$(security find-generic-password -s tlr-linear -a demo-key -w) deno task issues "Horse Tinder" --data ./web/data/horse-tinder.json`.

## Incident.io

On-call comes from the Incident.io REST API. There is no CLI and no MCP, so a key is the only path.

1. [Incident.io → API keys](https://app.incident.io/~/settings/api-keys): add a key named `tlr` and,
   under **Account-level permissions**, select only **Read schedules**. That covers `GET /v2/schedules`
   and `GET /v2/schedule_entries`. Don't grant write or manage scopes for a read-only feed
2. Leave **Team-level permissions** empty. This is the trap: a team-scoped key filters
   `GET /v2/schedules` to schedules that team owns, so an org-wide schedule (one with `team_ids: []`)
   drops out of the list and the feed sees zero, even though the account-level Read schedules grant is
   present and a fetch by schedule id still works. If a key already has a team (e.g. Engineering) under
   Team-level permissions, remove it
3. Copy the token (shown once) and store it: `security add-generic-password -s tlr-incidentio -a api-key -w`

The base host is `https://api.incident.io` and the header is `Authorization: Bearer <key>`. A key keeps
working after its creator is deactivated, so it acts as a service credential.

Diagnose scoping with the identity endpoint: `curl -H "Authorization: Bearer <key>"
https://api.incident.io/v1/identity` shows the key's `teams`. A non-empty `teams` array means the list is
team-filtered; `teams: []` sees every schedule.

Verify: `deno task capacity --source incident --dry-run`. Note that on-call only shows for people already
in `capacity.roster` (add them under Settings → Roster), so anyone on call who isn't rostered is dropped.

## Google Calendar

Out-of-office and onsite days come from Google Calendar. Which auth model you need depends on whose
calendar you read:

- OAuth 2.0 client (Desktop app), for your own credentials. You consent once in a browser and the script
  caches a refresh token. This also reads teammates' free/busy when the Workspace shares it (the
  default), the same data the Calendar webapp's "Find a time" view shows. It is the right route for a
  free/busy out-days feed
- Service account with domain-wide delegation, for reading teammates' event details when free/busy
  sharing is off. A Workspace super admin authorizes the delegation. Not needed for a free/busy feed

### OAuth client (own credentials, free/busy)

1. [Enable the Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   for your project
2. [Configure the consent screen](https://console.cloud.google.com/auth/branding): pick **Internal** if
   everyone is inside your Workspace, otherwise **External** and add yourself as a test user
3. [Create an OAuth client](https://console.cloud.google.com/auth/clients): application type
   **Desktop app**, then download the client JSON
4. Save the JSON to `web/data/gcal-client.json` (gitignored)

Verify: `deno task gcal:freebusy`. The first run opens the browser once for consent, caches a refresh
token in `web/data/gcal-token.json`, and prints each roster member's busy blocks for the next two weeks.
Later runs are silent. The same client and token feed `deno task capacity --source gcal`, which converts
free/busy into out-days (a weekday counts once its busy time reaches 5 hours, or it's an all-day block)
without needing a separate handoff file.

The refresh token is not a Console setting. The flow opens the auth URL with `access_type=offline` and
`prompt=consent`, and Google returns the refresh token on that first consent. Those parameters live in
the script's request, not the Console, which is why you won't find a toggle for them.

How long the cached token lasts is set by the consent screen's publishing status, not by the auth
method. An **External** app left in **Testing** issues refresh tokens that expire after 7 days, so the
browser consent returns every week. An **Internal** app (everyone inside the Workspace) or an External
app published to **In production** issues refresh tokens that do not expire on a timer, so the one
consent holds until the token is revoked or unused for six months. Set the consent screen to Internal,
or publish to production, to avoid the weekly re-consent.

This is the `CapacitySource.outDays` port's live adapter ([ADR 0007](adr/0007-productization-and-domains.md));
it still runs as a local OAuth client rather than a hosted, per-user credential, which is the remaining
gap before a shared runner can use it.

### Service account (teammates' event details)

1. [Create a service account](https://console.cloud.google.com/iam-admin/serviceaccounts), open it →
   Keys → Add key → JSON, download it, and copy its numeric Client ID
2. A Workspace super admin authorizes delegation: Admin console → Security → Access and data control →
   API controls → Manage Domain Wide Delegation → Add new, paste the Client ID and the scopes.
   Propagation can take up to a day
3. The script impersonates each teammate by setting the subject to their email when it mints a token

### Scopes

Least-privilege, narrowest first:

- [`calendar.freebusy`](https://www.googleapis.com/auth/calendar.freebusy) reads free/busy only (what
  the spike uses)
- [`calendar.events.readonly`](https://www.googleapis.com/auth/calendar.events.readonly) reads events on
  the user's calendars
- [`calendar.readonly`](https://www.googleapis.com/auth/calendar.readonly) also lists calendars and
  covers free/busy

A teammate query returns real data only if you can see their availability: Workspace free/busy sharing
for an OAuth user, or domain-wide delegation for the service account. Without one, a peer query comes
back empty.

## Daily snapshots on a schedule

`deno task snapshot` refreshes every project in `web/data/projects.json` from Linear and Incident.io and
captures a snapshot, the same work the board's Refresh button does. Run it by hand any time; the section
below puts it on a daily launchd timer so the history builds without anyone remembering.

Out-of-office is left out of a scheduled run. Google Calendar consent can need a browser, which a
background job cannot answer, so out-days stay whatever the last interactive `deno task capacity` wrote.

```sh
./scripts/schedule.sh install              # daily at 09:00
./scripts/schedule.sh install --at 07:30   # pick the hour
./scripts/schedule.sh install --dry-run    # print the plist and the commands, change nothing
```

Install is safe to re-run, and you have to re-run it after upgrading Deno: the plist holds the absolute
path to the `deno` binary, because a LaunchAgent gets no shell `PATH`.

Check it:

```sh
./scripts/schedule.sh status
launchctl list | grep me.kyleking.tlr.snapshot     # PID, last exit code, label
tail web/data/snapshot-launchd.log                 # stdout and stderr of the last runs
tail web/data/snapshot-runs.jsonl                  # one line per run: outcome, duration, error
```

Remove it:

```sh
./scripts/schedule.sh uninstall
```

macOS fires a missed daily run once when the machine wakes, and folds several missed days into that one
run, so a closed laptop does not lose its snapshot. Two guards keep that from turning into duplicate
work: a lock file (`web/data/snapshot-run.lock`) so a catch-up run cannot collide with a run already
going, and a 12-hour minimum interval so a catch-up landing right after a good run does nothing. A lock
older than 30 minutes is treated as abandoned and taken over, so a killed run does not wedge the
schedule. `--force` overrides the interval; nothing overrides the lock.

Failures surface in the app. Every run appends a line to `web/data/snapshot-runs.jsonl`, and the board
shows a dismissible banner when the last run failed or nothing has been captured for two days. With no
schedule installed there is no banner, which is the normal state, not a warning.

## Long-term: a hosted runner

Local keychain entries are the day-zero shortcut, not the destination. On a shared runner each user's
credentials become per-user namespaced secrets (a secret manager keyed by user id), and the same scripts
read from that namespace instead of `security`. The contract stays the same: one named secret per
service per user, least-privilege scopes, and read-only where the tool only reports. Plan new
credentials to fit that shape so the move off the laptop is a config change, not a rewrite.
