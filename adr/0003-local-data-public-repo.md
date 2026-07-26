# 0003 — Local-first data in a public repo

- Status: accepted
- Date: 2026-07-23

## Context

The repo `KyleKing/tlr` is public. The tool reads a private company's Linear: ticket titles,
descriptions, the roadmap. The planning fixture and the future snapshot store both hold that data.
Committing either would leak an internal roadmap.

## Decision

Real data never enters the repo. The live fixture (`web/data/cpu.json`) and any SQLite snapshot
files are gitignored. The web app loads the real fixture when present and falls back to a synthetic
`web/data-sample.json` that is safe to publish, so the public demo still runs. The snapshot store,
when built, lives on the machine (gitignored, or outside the working tree).

## Consequences

- Anyone cloning the repo sees the synthetic sample, not real tickets
- Screenshots shared outside need a judgment call, since they show real titles
- The snapshot store is per-user and local. Each lead runs their own copy against their own projects,
  which sidesteps hosting a database. Sharing captures between people, or a hosted store, is deferred
  to the `SnapshotStore` port in [0007](0007-productization-and-domains.md)
