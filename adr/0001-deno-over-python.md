# 0001 — Deno and TypeScript over Python

- Status: accepted
- Date: 2026-07-23

## Context

The first version was a Python CLI (`src/tlr/`) that read Linear over GraphQL and rendered a markdown
report. The new scope adds an interactive web view and in-flow editing, which need real client-side
JavaScript regardless of the backend language. Keeping Python for the core and adding a JS front-end
splits the project across two runtimes and duplicates the Linear models.

## Decision

Rewrite the whole thing in Deno and TypeScript. The Linear layer ports cleanly: the API is a GraphQL
POST with an `Authorization` header, so the existing query strings move over almost unchanged. Keep
the raw `fetch` approach rather than `@linear/sdk`, because the snapshot and batch-mutation queries
are custom and the SDK's opinions would get in the way.

The prior Python code stays in the tree as reference until the Deno fetch layer replaces it, then it
is deleted. Working on `main` in conventional-commit checkpoints.

## Consequences

- One language and one runtime for core, CLI, and web
- Pure logic lives in framework-free ES modules that both the browser and Deno tests import, so no
  build step is needed to test
- Keychain access shells out to the macOS `security` CLI instead of using a Python keyring library
- The project-issues filter needs `ID!` where the old script used `String!`, a schema drift to carry
  into the port
