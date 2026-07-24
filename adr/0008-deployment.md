# 0008 — Deploying alongside yak-shears on one VM

- Status: proposed
- Date: 2026-07-23

## Context

tlr runs on a laptop today. `deno task dev` serves the board, reads Linear and Incident.io over the
network, and pulls credentials from the macOS keychain through the `security` CLI (see `linearKey` in
`scripts/issues.ts`, and the same pattern in `scripts/roster.ts` and `scripts/capacity.ts`). Each of
those reads an environment variable first (`LINEAR_API_KEY` and friends) and falls back to the keychain.
Data files under `web/data/` are gitignored so real ticket data never lands in this public repo.

The owner already runs a Hetzner VM provisioned by the `yak-shears` repo. That box carries a cloud-init
config, a hardened SSH setup, a Caddy reverse proxy terminating TLS through Let's Encrypt, a per-service
systemd unit, and a GitOps timer that polls `origin/main` every five minutes and restarts the service on
a new commit. tlr should live on that same VM as its own service, share the CPU, and reach the internet
through the same Caddy instance under its own subdomain. This is a plan, not a runbook. The actual deploy
is blocked (see "What blocks the deploy" below), so the point here is to fix the shape and name the prep
work, not to ship.

The reference mechanics come from `yak-shears/cloud-config.yaml` and `yak-shears/DEPLOYMENT.md`. One
difference to keep in mind: yak-shears is a Python app run through `uv`, so its GitOps step runs
`uv sync` and its unit runs `uv run --no-sync serve`. tlr is Deno, so the equivalents are a dependency
cache step and a `deno task`, but the surrounding frame (systemd unit, Caddy stanza, GitOps timer) is
the same.

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

`serve` here is a production task that does not yet exist (see prep work). `EnvironmentFile` is the
stopgap secret path and is itself part of what the deploy is blocked on (see below).

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

## What blocks the deploy: secrets

The VM is Linux and has no macOS keychain, so the `security find-generic-password` fallback that every
credential read uses today cannot run there. The only path that works today is the environment-variable
branch each reader checks first, fed through the systemd `EnvironmentFile` shown above. That file is a
plaintext secret on the host, which is the same gitignored-file-of-secrets shape the project is trying to
leave behind, so it is a stopgap, not the answer.

The real answer is the `SecretStore` port from [ADR 0007](0007-productization-and-domains.md).
`KeychainSecrets.get(service, userId)` stays the local adapter, and `HostedSecrets.get(service, userId)`
reads a per-user namespaced secret on the server. Once callers read through that port instead of calling
`security` directly, the hosted deploy is a matter of binding the hosted adapter, with no change in the
fetch loop. Until that port exists, a hosted deploy either ships plaintext env secrets or waits. This ADR
records that the deploy waits on ADR 0007's `SecretStore`.

## Prep work needed in tlr first

None of this is implemented here. It is the list that has to land before a deploy is real:

- A production `serve` task in `deno.json`. The current `dev` task carries `--allow-run=security,open`
  and unrestricted `--allow-net`, both aimed at a laptop. The server task should drop `security` (no
  keychain on Linux) and `open`, and scope `--allow-net` to the hosts the board actually calls plus the
  listen socket. The systemd `ExecStart` above assumes this task exists
- Host binding. `scripts/serve.ts` already reads `PORT` from the environment (default 8000), so the
  `Environment=PORT=8085` line works today. It has no `HOST`/hostname setting and binds every interface.
  Behind Caddy that is acceptable, but binding `127.0.0.1` is tighter and the port should come from a
  single config module. No `env.ts`/`config.ts` module exists yet, so the infra-parity work that would
  centralize `PORT`/`HOST` reads is still to do, not already covered
- Secret reads through the `SecretStore` port (ADR 0007), replacing the direct `security` calls in
  `scripts/issues.ts`, `scripts/roster.ts`, and `scripts/capacity.ts`. This is the item the deploy is
  blocked on
- A GitOps dependency step for Deno (`deno cache`) wired into the update script, in place of yak-shears'
  `uv sync`

## Alternatives considered

- A new VM for tlr. Full isolation, but a second box to provision, patch, and pay for, when tlr is a
  small internal board that fits beside yak-shears. Isolation this app does not need
- `deno compile` to a single binary shipped to the host. Removes the runtime dependency on the repo
  checkout, but adds a build-and-copy path nothing else on the VM uses and breaks from the GitOps loop
  that already updates yak-shears. The pull-and-run model reuses machinery that is already there
- A path route under the yak-shears domain instead of a subdomain. Saves a DNS record, but forces rewrite
  rules because tlr serves from `/` with root-relative assets. A subdomain is the smaller change
- Ship now with plaintext env secrets and skip the `SecretStore` port. Unblocks the deploy today, but
  welds a secret file onto the host and re-creates the exact shortcut ADR 0007 exists to remove. Not
  worth trading the port for a few days

## Consequences

- tlr rides the yak-shears VM's existing TLS, firewall, SSH hardening, and GitOps loop, so there is no
  new infrastructure to own, only a unit file, a Caddyfile block, an A record, and a few lines in the
  update script
- The deploy stays blocked on ADR 0007's `SecretStore` port, which is the intended gate. That work
  unblocks hosting rather than being extra scope
- Both services share one CPU with no limits, which is fine at current load and can gain `CPUQuota` later
  without disturbing anything else
- Co-hosting couples tlr's uptime to a box it does not own. A yak-shears change that reboots or breaks the
  VM takes tlr with it. Accepted, because the two are run by the same owner and neither is load-bearing
  for anyone else yet
