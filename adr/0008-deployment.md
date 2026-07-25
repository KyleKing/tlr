# 0008 — Deploying alongside yak-shears on one VM

- Status: proposed
- Date: 2026-07-24

## Context

tlr runs on a laptop today. `deno task dev` serves the board, reads Linear and Incident.io over the
network, and pulls credentials through `src/secrets.ts`, which reads an environment variable first
(`LINEAR_API_KEY` and friends) and falls back to the macOS keychain via the `security` CLI. That module
is the one place secrets are read; off macOS the keychain call catches its own failure and returns null,
so the env branch is what a Linux host uses with no code change. Data files under `web/data/` are
gitignored so real ticket data never lands in this public repo.

The owner already runs a Hetzner VM provisioned by the `yak-shears` repo. That box carries a cloud-init
config, a hardened SSH setup, a Caddy reverse proxy terminating TLS through Let's Encrypt, a per-service
systemd unit, and a GitOps timer that polls `origin/main` every five minutes and restarts the service on
a new commit. tlr should live on that same VM as its own service, share the CPU, and reach the internet
through the same Caddy instance under its own subdomain. This is a plan, not a runbook. A few prep items
remain (see "Prep work needed in tlr first" below), so the point here is to fix the shape and name that
work, not to ship.

The reference mechanics come from `yak-shears/cloud-config.yaml` and `yak-shears/DEPLOYMENT.md`. One
difference to keep in mind: yak-shears is a Python app run through `uv`, so its GitOps step runs
`uv sync` and its unit runs `uv run --no-sync serve`. tlr is Deno, so the equivalents are a dependency
cache step and a `deno task`, but the surrounding frame (systemd unit, Caddy stanza, GitOps timer) is
the same.

## Deployment options considered

Two things dominate the effort for any hosted target: a secret backend that is not the macOS keychain
(now handled by `src/secrets.ts`, which falls to env vars off macOS), and where the state lives. tlr's
state is a `node:sqlite` file plus JSON files under `web/data/`. A long-lived host keeps those on a disk
unchanged; a serverless host has no persistent local filesystem, so both must move to a hosted store.

| Option                                          | Fit for tlr as-is                                                         | Effort   | Lock-in |
| ----------------------------------------------- | ------------------------------------------------------------------------- | -------- | ------- |
| VM + systemd (this ADR)                         | Native: Deno process, sqlite + JSON on local disk, unchanged              | Lowest   | None    |
| Container + volume (Fly/Render, cloud-agnostic) | Good: containerize, keep sqlite on a volume or move the store to Postgres | Medium   | Low     |
| Deno Deploy + Deno KV                           | Runtime native, but the snapshot store ports to Deno KV                   | Medium   | Medium  |
| AWS Fargate/App Runner                          | Containerize + EFS/RDS + Secrets Manager + ALB/Cognito                    | Med-high | Medium  |
| Cloudflare Workers + D1                         | Runtime and storage port (no local fs; sqlite → D1)                       | High     | High    |

VM wins for a single-team internal board because it changes nothing about storage and reuses a box that
already exists. Cloudflare and AWS Lambda are the worst fits as-is: neither has a persistent local
filesystem, so `node:sqlite` and the `web/data` JSON files have nowhere to live and every
`Deno.readTextFile`/`Deno.Command` path would have to go. Their payoff is real but specific (Cloudflare's
D1 is sqlite and Access gives SSO auth almost free; AWS suits deep org-SSO integration), so they are the
second step only if tlr becomes a product for others. The refresh scripts (`issues`, `capacity`,
`roster`) shell out and write files, so on any serverless host they become a scheduled job that writes to
the hosted store rather than running in-process; on the VM they run unchanged.

## Decision

Run tlr as a second systemd service on the yak-shears VM, cloned and updated the same way yak-shears is,
served on a distinct localhost port, and exposed through a new Caddy site block on its own subdomain.

### Build and ship: git-pull-and-run, not a compiled binary

Match the yak-shears pattern. The VM clones the repo, and a GitOps timer pulls `origin/main` and restarts
the service. For Deno this means the update step runs `deno cache` (or `deno install`) to warm the
dependency cache in place of `uv sync`, then restarts the unit. No `deno compile` step, because a
compiled binary would need a separate build-and-copy path that nothing else on this VM uses, and the
whole value of co-hosting is that tlr updates through the same loop yak-shears already does. Deno caches
remote and npm imports, so the first `deno cache` is the only slow step and later restarts are fast.

A GitOps script for tlr, adapted from `yak-shears/cloud-config.yaml`:

```bash
#!/bin/bash
set -euo pipefail

cd /home/yakshears/tlr || exit 1
git fetch origin main || exit 1

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "Updates detected. Pulling changes..."
  git pull origin main || exit 1
  /home/yakshears/.local/bin/mise install || exit 1
  deno cache ./scripts/serve.ts || exit 1
  systemctl restart tlr || exit 1
  echo "Update completed"
else
  echo "No updates available"
fi
```

This can reuse the existing `gitops-update.service`/`.timer` pair (add the tlr steps to the one script)
or run as its own timer. One timer covering both repos is simpler and is the recommendation.

### The systemd unit

Adapted from the `yak-shears.service` block in `cloud-config.yaml`. It runs under the same `yakshears`
user, out of the tlr clone, on a port that does not collide with yak-shears (which uses 8084):

```ini
[Unit]
Description=tlr planning board
After=network.target

[Service]
User=yakshears
WorkingDirectory=/home/yakshears/tlr
ExecStart=/home/yakshears/.local/bin/deno task serve
Restart=always
RestartSec=10
Environment=PORT=8085
EnvironmentFile=/home/yakshears/tlr/.env

[Install]
WantedBy=multi-user.target
```

`serve` here is a production task that does not yet exist (see prep work). `EnvironmentFile` supplies the
API secrets that `src/secrets.ts` reads by env var on the host (see "Secrets on the VM" below).

### The scheduled snapshot on the host

Locally the `deno task snapshot` run is a per-user launchd LaunchAgent that fires every three hours,
eight `StartCalendarInterval` entries in an array (`scripts/schedule.sh`, [SETUP.md](../SETUP.md)). The
calendar form is deliberate over `StartInterval`: launchd fires a missed calendar interval when the
laptop wakes and coalesces several missed ones into a single run. On the VM that problem does not exist,
since the box does not sleep, so the hosted equivalent is a systemd timer beside the service unit: a
`tlr-snapshot.service` of `Type=oneshot` running the same task under the same user and
`EnvironmentFile`, plus a `tlr-snapshot.timer` with `OnCalendar=*-*-* 00/3:00:00` and `Persistent=true`
(which covers a run missed while the VM was down, the same catch-up launchd gives). No unit file ships
in this repo: an untested unit committed next to a working LaunchAgent invites someone to trust it, and
the run-level guards that matter (the lock and the minimum interval, in `src/runLock.ts`) live in the
task itself rather than in the scheduler, so they carry over to systemd unchanged.

### The Caddy route

Add a second site block to `/etc/caddy/Caddyfile` next to the yak-shears one, on a new subdomain. The
global `email` directive and Let's Encrypt flow already handle TLS, so a new subdomain only needs an A
record pointing at the VM IP and a new block. Adapted from the yak-shears stanza:

```caddyfile
tlr.kyleking.me {
    reverse_proxy localhost:8085 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "same-origin"
        X-XSS-Protection "1; mode=block"
        Permissions-Policy "geolocation=(), microphone=(), camera=()"
    }

    log {
        output file /var/log/caddy/tlr.log
    }
}
```

A subdomain is cleaner than a path prefix (`yak-shears.kyleking.me/tlr`) because tlr serves from `/` and
its static assets are root-relative, so a path route would need rewrite rules that a subdomain avoids.

### Sharing the CPU

Both services run on the one VM under the same user, so they share CPU and memory with no explicit
limits. tlr is a low-traffic internal board, so this is fine to start. If contention ever shows up, the
systemd unit can gain `CPUQuota=` and `MemoryMax=` without touching anything else. Adding those now would
be guessing at a limit before there is a load to size it against.

## Secrets on the VM

The VM is Linux and has no macOS keychain. That no longer blocks anything, because every credential now
reads through `src/secrets.ts`, which checks the environment variable first and only then tries the
keychain (and catches the failure when `security` is absent). On the VM the systemd `EnvironmentFile`
supplies `LINEAR_API_KEY`, `LINEAR_DEMO_API_KEY`, and `INCIDENT_IO_TOKEN`, and `getSecret` reads them
with no code change. `secrets.ts` is the pragmatic form of ADR 0007's `SecretStore`: the env branch is
the hosted backend, the keychain branch is the local one.

Security posture for that path:

- Secrets are read into an `Authorization` header and never logged. The request logger records method,
  path, and status, not headers or bodies.
- The keychain lookup passes an argument array to `security`, not a shell string, so a service/account
  value cannot inject a command. The service/account names are hardcoded constants.
- The `EnvironmentFile` is a plaintext secret on the host. Keep it `chmod 600`, owned by the service
  user, outside the repo checkout. This is acceptable for a single-owner VM. If tlr ever holds other
  people's credentials, swap the env backend in `secrets.ts` for a real manager (Vault, Infisical, or the
  host cloud's secret store) behind the same `getSecret` call, with no change to callers.
- The board's write endpoints (`/api/edit`, `/api/config`, `/api/refresh`) have no auth of their own.
  On the VM they sit behind Caddy on a subdomain; put an auth layer in front (Caddy basic auth, an
  oauth2-proxy, or Tailscale-only exposure) before the board is reachable off the private network. The
  Caddy block below already sets HSTS and the standard hardening headers.

Google Calendar is the one credential still outside `getSecret`: it uses an OAuth client whose token is
cached in a file and refreshed through a browser handoff (`open`). That flow is laptop-shaped and is
listed in the prep work below; on a headless host it moves to a service account or a pre-seeded refresh
token.

## Prep work needed in tlr first

Two items below are done; the rest still has to land before a deploy is real.

- Done: secret reads go through `src/secrets.ts` (env-then-keychain), replacing the direct `security`
  calls that were duplicated in `scripts/issues.ts`, `scripts/roster.ts`, and `scripts/capacity.ts`.
- Done: config is centralized in `src/utils/env.ts` (`getEnvConfig`), which reads `PORT` and `HOST`
  (default `localhost` in dev, `0.0.0.0` in production) plus `LOG_LEVEL` and `DEMO`. `scripts/serve.ts`
  binds `config.HOST`/`config.PORT`, so `Environment=PORT=8085` works and the host is tunable.
- A production `serve` task in `deno.json`. The current `dev` task carries `--allow-run=security,open`
  and unrestricted `--allow-net`, both aimed at a laptop. The server task should keep `--allow-run=security`
  only if the VM uses the keychain (it will not — it uses env vars, so drop `security` and `open`), and
  scope `--allow-net` to the hosts the board calls plus the listen socket. The systemd `ExecStart` above
  assumes this task exists.
- Google Calendar off the laptop-shaped OAuth `open` flow: move to a service account or a pre-seeded
  refresh token so no browser handoff is needed on a headless host.
- A GitOps dependency step for Deno (`deno cache`) wired into the update script, in place of yak-shears'
  `uv sync`.

## Alternatives considered

- A new VM for tlr. Full isolation, but a second box to provision, patch, and pay for, when tlr is a
  small internal board that fits beside yak-shears. Isolation this app does not need
- `deno compile` to a single binary shipped to the host. Removes the runtime dependency on the repo
  checkout, but adds a build-and-copy path nothing else on the VM uses and breaks from the GitOps loop
  that already updates yak-shears. The pull-and-run model reuses machinery that is already there
- A path route under the yak-shears domain instead of a subdomain. Saves a DNS record, but forces rewrite
  rules because tlr serves from `/` with root-relative assets. A subdomain is the smaller change
- A managed secret store (Vault, Infisical, cloud secret manager) instead of the env `EnvironmentFile`.
  The right answer once tlr holds more than the owner's own credentials, and `getSecret` is the single
  seam to add it behind. Overkill for a single-owner VM today, where a `chmod 600` env file is proportionate

## Consequences

- tlr rides the yak-shears VM's existing TLS, firewall, SSH hardening, and GitOps loop, so there is no
  new infrastructure to own, only a unit file, a Caddyfile block, an A record, and a few lines in the
  update script
- Secrets no longer block the deploy: `src/secrets.ts` reads env vars on the VM through the same
  `getSecret` call the laptop uses against the keychain. The remaining secret work is swapping the env
  backend for a managed store if tlr ever holds other people's credentials
- Both services share one CPU with no limits, which is fine at current load and can gain `CPUQuota` later
  without disturbing anything else
- Co-hosting couples tlr's uptime to a box it does not own. A yak-shears change that reboots or breaks the
  VM takes tlr with it. Accepted, because the two are run by the same owner and neither is load-bearing
  for anyone else yet
