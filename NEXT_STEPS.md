# Next steps

Running list of what to build next and what needs a decision. Higher-level phases live in
[ROADMAP.md](ROADMAP.md); this file tracks the near-term work and the questions blocking it.

## Done

- Dependency-ordered timeline view. A "Timeline" toggle lays issues out by dependency depth
  (topological waves) instead of by assigned cycle. Each card shows its scheduled bucket, so a card
  scheduled ahead of its blocker stands out. Hover keeps the blocker highlight and full detail card.
  Logic is `dependencyWaves` in `web/lib/planning.js`, with tests.
- Capacity fetcher. `deno task capacity` refreshes the `capacity` block from real sources instead of
  hand-seeding it. On-call comes from the Incident.io REST API; out-days come from a Google Calendar
  handoff file. Pure transforms in `web/lib/capacity.js` (tested), thin I/O in `scripts/capacity.ts`,
  provenance-aware merge that preserves hand-entered values. See ADR 0005's update.
- Roster resolver. `deno task roster` (`scripts/roster.ts`) resolves each assignee display name to an
  email against the Linear GraphQL API, so the roster is no longer hand-typed. Both current assignees
  resolve; Marissa's email is filled.
- Google free/busy spike. `deno task gcal:freebusy` (`scripts/gcal-freebusy.ts`) reads teammates'
  free/busy from a personal Desktop OAuth client, no MCP. Verified against real data: Workspace free/busy
  sharing is on, so a peer's busy blocks come back and no service account is needed. The client JSON
  comes from 1Password and the refresh token is cached for silent re-runs.
- Timeline toggle fix. Switching to the dependency view and back left the timeline rendered under the
  board (a CSS `display` rule beat the `hidden` attribute). Guarded with `[hidden] { display: none }`.
- Slop-scan tuning. Real data showed 15 of 43 flagged tickets tripping on a single weak signal alone
  (length, one dash, one semicolon, or bullets with no stock-phrase hit). `isSlop` now requires
  `score >= 2`, dropping the flagged count from 43 to 28 of 66 issues (33 to 19 of the 48 shown by
  default). The hover card's "mark not slop" affordance now gates on the same threshold instead of
  raw flag count, so it no longer appears for tickets that aren't actually flagged.
- Compact-tick titles. Decided to keep ticket-number-only chips; the hover card already gives the
  full title and detail instantly, and chips are too narrow/dense (several per cell) to fit a useful
  title snippet without bloating the grid.
- Docs. `SETUP.md` is the day-zero credentials guide. New ADRs: 0006 (normalized issue schema across
  Linear and GitHub) and 0007 (productizing the spikes into domains and ports). `AGENTS.md` records the
  spike-then-productionize rule.
- `GoogleCalendarSource` adapter. `deno task capacity --source gcal` now fetches live free/busy through
  the same OAuth client as the spike and runs it through `outDaysFromFreeBusy`: a weekday counts as
  reduced-capacity once its busy time reaches 5 hours, or it's an all-day block (free/busy carries no
  event type, so title-based detection isn't available). `--calendar-file` still works for named events
  when a real reason is known. Pure logic in `web/lib/capacity.js` (tested); still a local OAuth client,
  not a hosted per-user credential, which stays the gap before a shared runner can use it (ADR 0007).
  Running it for real against `cpu.json` surfaced a real regression: the onsite week doesn't show as
  calendar-busy time at all (an onsite doesn't fill a calendar with meetings, and an all-day block set to
  Free/transparent is invisible to free/busy regardless of duration), so an automation-always-wins merge
  silently replaced Marissa's known 3-day onsite with a coincidental, far-less-accurate "1 busy day"
  reading. Fixed by making hand-typed values (no source marker) protected by default in both
  `mergeCapacity` and `mergeVelocity`: a source only ever refreshes what it wrote itself on an earlier
  run. Added `locked: true` as an explicit escape hatch for the reverse case, freezing a value a source
  previously wrote once it's hand-confirmed. Marissa's onsite entry in `cpu.json` is now `locked: true`.
- Per-person base velocity. `deno task capacity --source history` computes each person's velocity from
  completed points in past cycles, no external fetch needed since it reads the same data file. Applied
  to the real `cpu.json`: Marissa's velocity is now 20 from cycle 47 throughput; Kyle has no completed
  points in a past cycle yet, so he still falls back to the default.
- Deflation knobs: on-call penalty raised from a flat 35% to 45% (`CAPACITY_DEFAULTS.oncallPenalty` in
  `web/lib/planning.js`, ADR 0005, and the real `cpu.json`'s own `config.oncallPenalty`, which had been
  overriding the code default). Time off stays a straight day-fraction cut, confirmed as right for now.
- Dependency timeline and capacity board stay two separate views (current toggle), not merged.

## Setup to finish the capacity feed

See `SETUP.md` for the full guide. The one blocker for the live on-call feed is the Incident.io key
(store it, then `deno task capacity --source incident --dry-run`). Google Calendar out-days and
per-person velocity both run without extra setup beyond what SETUP.md already covers.

## Next up

Ordered roughly by dependency and payoff; production deployment is last on purpose.

1. **Visual redesign: Linear's structure, a personal skin.** Goal is to read as Linear-caliber without
   being a reskin of Linear. Research so far:
   - Linear's actual discipline (not vibes): a strict 4px grid for padding/icon/text sizes, a muted
     grey-heavy base with full-saturation color reserved for status/priority/interactive elements only,
     progressive disclosure (hover reveals actions, click expands, detail view shows everything),
     skeleton loading states instead of spinners, optimistic UI (edits appear before the API confirms),
     and a keyboard-first model: Cmd+K command palette for any action, single letters for common actions,
     a fixed sidebar with animated (not reloaded) view transitions. That structural discipline is what's
     worth copying, not the literal purple-on-dark-grey palette.
   - `yak-shears` already has a distinct personal visual language worth carrying over instead: monospace
     type throughout (including headings), a warm cream/paper background rather than stark white or dark
     grey, one confident accent color (mustard yellow) instead of Linear's purple, pill-shaped chips with
     crisp black borders, and a small playful touch like the circular initials badge in the header.
     Screenshots pulled from the repo confirm this reads as considered, not cheesy.
   - Proposed direction: keep tlr's current muted/functional palette approach and Linear's density and
     keyboard-first interactions, but swap in a warm paper background, monospace type, and a single
     non-purple accent so it's recognizably "the same designer" as yak-shears rather than a Linear clone.
     Worth a small throwaway mockup (a static HTML comp, not wired to real data) before touching
     `web/style.css` for real, since this is a taste call that's easy to get wrong in code first.
2. **Project switcher.** Today the web app only ever reads one static `/data/cpu.json`, and the Python
   ingest script takes a single project name/slug per run — there's no concept of "list the projects I'm
   a member of" anywhere. Needs: a Linear GraphQL query for the viewer's member projects (similar shape
   to `_find_project` in `_tlr-linear_progress.py`, but listing rather than searching), a per-project data
   file convention (e.g. `web/data/<slug>.json`) so switching is instant client-side, and a picker in the
   header (a natural fit for the command palette from item 1, if that lands first — "switch to project"
   as one of its actions). This is also the first real motivation to move the ingest step off the
   single-project Python script and toward the Ingest domain ADR 0007 already describes.
3. **Data-freshness UX.** `loadData()` silently falls back to `data-sample.json` if `cpu.json` is missing,
   and there's no visible signal when the shown data is stale (a snapshot taken hours or days ago) versus
   the fallback sample. A visible banner or header state for "showing sample data" / "data as of
   `<age>`" would prevent misreading stale or demo data as current.
4. **Keyboard navigation on the board itself.** If item 1 adopts a keyboard-first posture, the grid needs
   to earn it: arrow-key movement between ticks/cards, a focus ring distinct from the hover state, and
   ARIA roles so the hover card's content is reachable without a mouse. Currently everything (search,
   filters, hover card) is mouse-only.
5. **Narrow-viewport handling.** The board is a wide table; `.wrap` scrolls horizontally but the header,
   filter bar, and legend haven't been checked below ~900px. Decide whether to explicitly scope tlr as
   desktop-only (reasonable for a planning tool used at a desk) or invest in a real narrow layout, rather
   than leaving it undefined.
6. **Web UI test coverage.** All current tests are pure-function unit tests (`web/lib/*.js`);
   `web/app.js`'s DOM rendering and interaction code (filters, hover card, timeline toggle) has zero
   automated coverage. At minimum, a manual QA checklist to run before any deploy; ideally a lightweight
   DOM smoke test.
7. **Secrets story for more than one local user.** Every credential today is a macOS keychain entry or a
   gitignored local file (Incident.io token, Google OAuth client/token, Linear API key). ADR 0007's
   `SecretStore` port (`KeychainSecrets` vs `HostedSecrets`) is designed but not built. Needed before
   tlr can run for anyone other than the current single local user, including on the deployment below.
8. **Production deployment — last.** Likely target: nested into the existing `yak-shears` Hetzner Cloud
   VPS rather than a new server, for cost — same Caddy reverse proxy (new subdomain or path route), a
   new systemd service alongside the existing ones, reusing the cloud-init/DNS/Let's Encrypt pattern
   already proven there. Blocked on at least item 7 (no keychain access on a shared server) and probably
   item 2 (a single hardcoded project stops making sense once this isn't just a local spike).

## Later (unchanged from roadmap)

- Port the reader to Deno, then the SQLite snapshot store with `tlr diff` and `tlr review`.
- Write layer: `tlr plan "<guidance>"` into validated ops, `tlr apply` to run the approved subset.
- SVG export of a view for weekly-update artifacts.
