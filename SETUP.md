# Day-zero setup

Every credential TLR needs, how to get it by hand, and where it lives. Nothing here runs through
Claude or an MCP connector. Each service is reached by a script with a key you mint yourself, so a
fresh machine can run the whole tool once these steps are done.

Secrets live in the macOS keychain today, one entry per service, read by the `security` CLI. The
long-term target is a hosted runner with per-user namespaced secrets (see the last section), so treat
every service below as "one named secret" rather than "a file on my laptop".

## At a glance

| Service | Secret | Keychain service | Used by |
| --- | --- | --- | --- |
| Linear | personal API key | `tlr-linear` | issue fetch, `deno task roster` |
| Incident.io | API key (read schedules) | `tlr-incidentio` | `deno task capacity --source incident` |
| Google Calendar | OAuth client JSON (Desktop app) | `web/data/gcal-client.json` | free/busy spike `deno task gcal:freebusy` |

Each keychain entry uses account `api-key`. Store one like this (you are prompted for the value, so it
never lands in shell history):

```sh
security add-generic-password -s <service> -a api-key -w
```

Read it back with `-w` and the same `-s`/`-a` to confirm it is there. Delete and re-add to rotate.

## Linear

1. Open Linear, then Settings → Security & access → Personal API keys (`https://linear.app/settings/api`)
2. Create a key, name it `tlr`, and copy the value (shown once)
3. Store it: `security add-generic-password -s tlr-linear -a api-key -w`

A personal key inherits your own access, which is enough to read issues and resolve the roster. The
auth header is the raw key (`Authorization: <key>`), not a Bearer token, which is a Linear quirk.

Verify: `deno task roster --dry-run --force` should print each assignee resolved to an email.

## Incident.io

On-call comes from the Incident.io REST API. There is no CLI and no MCP, so a key is the only path.

1. Sign in at `app.incident.io`
2. Go to Settings → API keys (`https://app.incident.io/~/settings/api-keys`)
3. Add a key, name it `tlr`, and under permissions select only **Read schedules**. That one scope
   covers both `GET /v2/schedules` and `GET /v2/schedule_entries`. Do not grant write or manage scopes
   for a read-only feed
4. If your org uses team-scoped keys, grant Read schedules at the account level to see every schedule,
   or scope it to the teams whose rotations you need
5. Copy the token (shown once) and store it: `security add-generic-password -s tlr-incidentio -a api-key -w`

The base host is `https://api.incident.io` and the header is `Authorization: Bearer <key>`. A key keeps
working after the person who made it is deactivated, so it acts as a service credential. Scope it down
rather than looking for a separate bot-key type, because Incident.io does not offer one in this flow.

Verify: `deno task capacity --source incident --dry-run`.

## Google Calendar

Out-of-office and onsite days come from Google Calendar. Two auth models exist, and which one you need
depends on whose calendar you read.

- OAuth 2.0 client (Desktop app), for your own credentials. You consent once in a browser and the
  script keeps a refresh token. No Workspace admin is involved. This route also reads teammates'
  free/busy when the Workspace shares it (the default), which is the same data the Calendar webapp's
  "Find a time" view shows. It is the right route for an out-days feed built on free/busy
- Service account with domain-wide delegation, for reading teammates' event details across the
  Workspace without each person consenting. The service account impersonates each user, and a Workspace
  super admin has to authorize the delegation. Only needed when free/busy sharing is off or you need
  event contents rather than busy blocks

Today the standalone Google path is not built. Out-days flow through the Google Calendar MCP inside a
Claude session, which reads the current user only and writes a small handoff file that
`deno task capacity --source gcal --calendar-file <path>` merges. The steps below are what a
reproducible `deno task capacity` run will need once that path replaces the MCP handoff.

### Google Cloud Console

1. Create a project: project picker → New project, or IAM & Admin → Manage resources → Create project
2. Enable the API: APIs & Services → Library → "Google Calendar API" → Enable
   (`https://console.cloud.google.com/apis/library/calendar-json.googleapis.com`)
3. Configure the consent screen: Google Auth platform → Branding (`https://console.cloud.google.com/auth/branding`).
   Pick **Internal** if everyone is inside your Workspace, otherwise **External** and add yourself as a
   test user. Set the app name, support email, and the scopes below

For the OAuth client (own calendar):

4. Google Auth platform → Clients (`https://console.cloud.google.com/auth/clients`) → Create client →
   Application type **Desktop app**
5. Download the client JSON (`client_id` and `client_secret`). That is all the Console needs; store the
   file where the script can read it

The refresh token is not a Console setting. It comes from the consent the script triggers: the flow
opens the authorization URL with `access_type=offline` and `prompt=consent`, and Google returns a
refresh token on that first consent. Those two parameters live in the script's auth request, not
anywhere in the Console, which is why you won't find a toggle for them.

Verify: save the downloaded client JSON to `web/data/gcal-client.json`, then `deno task gcal:freebusy`.
The first run opens the browser once for consent, caches the refresh token in `web/data/gcal-token.json`
(both files gitignored), and prints each roster member's busy blocks for the next two weeks. This is a
spike that proves the free/busy read; the shipped `GoogleCalendarSource` adapter (ADR 0007) is later work.

For the service account (teammates' calendars):

6. IAM & Admin → Service Accounts (`https://console.cloud.google.com/iam-admin/serviceaccounts`) →
   Create service account → open it → Keys → Add key → JSON, and download it
7. Copy the service account's numeric Client ID
8. A Workspace super admin authorizes delegation in the Admin console: Security → Access and data
   control → API controls → Manage Domain Wide Delegation → Add new, paste the Client ID, and enter the
   scopes as a comma-separated list. Propagation is usually quick but can take up to a day
9. The script then impersonates each teammate by setting the subject to their email when it mints a token

### Scopes

Read the least-privilege scope that works:

- `https://www.googleapis.com/auth/calendar.events.readonly` reads events on the user's calendars
- `https://www.googleapis.com/auth/calendar.readonly` also lists calendars and covers free/busy, so use
  it if you enumerate calendars
- `https://www.googleapis.com/auth/calendar.freebusy` is the narrow free/busy-only scope

A read-only out-days feed needs `calendar.events.readonly` plus `calendar.freebusy`, or just
`calendar.readonly` on its own.

### The teammate caveat

A free/busy query for a teammate returns real data only if you can see their availability. Get that
either from Workspace free/busy sharing (Admin console → Apps → Google Workspace → Calendar, sharing set
to at least "free/busy") for an ordinary OAuth user, or from domain-wide delegation for the service
account. Without one of those, a peer query comes back empty.

## Long-term: a hosted runner

Local keychain entries are the day-zero shortcut, not the destination. On a shared runner each user's
Linear, Incident.io, and Google credentials become per-user namespaced secrets (a secret manager keyed
by user id), and the same scripts read from that namespace instead of `security`. The contract stays
the same: one named secret per service per user, least-privilege scopes, and read-only where the tool
only reports. Plan new credentials to fit that shape so the move off the laptop is a config change, not
a rewrite.
