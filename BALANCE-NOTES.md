# Balance feature — handoff notes

Considerations for the "balance" feature (schedule milestones across employees), written from what this
session built so a separate session can pick it up without re-discovering the seams. A first pass already
exists as `src/commands/balance.ts` (a pure, deterministic greedy assigner that emits `set_assignee` and
`set_cycle` ops) plus a `balance` CLI command. These notes are about making its output accurate and
actionable, not about the allocation algorithm itself.

## What already exists to build on

Reuse these rather than re-deriving them. Everything analytic is pure and unit-tested, matching the
project's "pure logic in `web/lib/*.js`, no I/O" rule.

- **Per-person capacity**, the real ceiling. `web/lib/capacity.js` and `web/lib/planning.js`
  (`personCycleCapacity`) deflate a person's base velocity for on-call weeks (flat penalty) and days out
  of office (day fraction). `src/commands/capacity.ts` (`projectCapacity`) already reports load vs
  capacity per person per cycle. Prefer this over a flat `weeklyPerPerson` number so a person's on-call
  or PTO cycle correctly holds less. On-call and OOO come from the capacity refresh (Incident.io, Google
  Calendar), which is now working end to end.
- **Forecast**, to show the effect. `web/lib/planning.js` `milestoneForecast` (typed wrapper
  `src/forecast.ts`) lands milestones sequentially by target date from remaining points and team weekly
  throughput. After balancing, re-run it to show the new landing dates. Consider a per-person variant so
  a milestone's date reflects the slowest assigned owner, not just the team sum.
- **The op model and the write path**. `src/ops.ts` defines `set_assignee`, `set_cycle`, `set_milestone`
  (all validated against live state). `src/linear_write.ts` applies them to Linear, resolving the
  assignee name, cycle number, and milestone key to Linear ids at write time. This is the crucial reuse:
  balance's output is already `Op[]`, so it plugs straight into the existing preview-then-apply path (see
  next section).
- **Dependency order**. `web/lib/planning.js` `dependencyWaves` and `orderingRisks` order the blocking
  graph and flag a blocker scheduled after its dependent. Balance must not schedule a blocked issue into
  a cycle earlier than its blocker; `orderingRisks` is the check to run on a proposed plan.
- **The board's capacity heat**. The board already renders per-person-per-cycle load with an "over" badge
  when committed points exceed capacity. A before/after balance view can reuse that rendering rather than
  inventing a new one.
- **Data shapes**. `src/seed.ts` defines `Snapshot`/`Issue`. An issue carries `estimate`, `assignee`
  (display name), `milestone` (key), `cycle` (number), `blocks`/`blockedBy`, `priorityValue`. Capacity
  carries per-person `velocity` and per-cycle `oncall`/`outDays`. Balance operates on these shapes, the
  same ones the ops and write layer speak.

## The highest-value next step: make balance actionable, not just a plan

Balance emits `Op[]`. The write path built this session takes `Op[]`, previews the change as a dry run,
and applies it to Linear on confirm (`POST /api/edit`, from the Review page). So the natural next step is
to route a balance proposal through that same path:

1. Balance produces a proposed `Op[]` (reassign + reschedule).
2. Show it as a diff/preview, the way the Review page previews an edit (`applyOps` in memory, no network).
3. On confirm, apply through `applyIssueEdits` — the same code that already round-trips to real Linear.

That gives balance a real "apply this plan" button with no new write code, and it inherits the demo/live
mode guard and the dry-run-first safety. A dedicated Balance page (or a mode on the board) that shows the
before/after heat and the proposed ops, then hands them to `/api/edit`, is the shape to aim for.

## Constraints and gotchas learned this session

- **`set_cycle` needs cycles to exist in the Linear team.** The demo team had cycles disabled, so a
  cycle assignment has nowhere to land. Balance can propose cycles, but applying them requires the team
  to run cycles. Guard for an empty cycle list.
- **Off-roster people are dropped.** Capacity (and on-call) only tracks people in `capacity.roster`.
  Balance should only assign to rostered people, or flag an off-roster assignee, or the load math will be
  wrong. This is the same gap that hides on-call for unrostered folks.
- **Null estimates exist.** `missingData` flags issues with no estimate; some real issues have none.
  Balance needs a point value per issue, so decide a default (or refuse to schedule un-estimated work and
  surface it), rather than treating null as zero.
- **The snapshot is thin.** It carries names/keys/numbers, not Linear UUIDs. That is fine: balance works
  in those terms and `src/linear_write.ts` resolves them to ids at write time. Keep balance in snapshot
  terms; don't reach for ids.
- **Determinism.** The codebase is deterministic on purpose (seeded PRNG, stable exports, pinned clock in
  screenshots). Keep balance's tie-breaks deterministic (stable sort, fixed order) so a re-run proposes
  the same plan and tests stay stable. The existing stub already commits to this.
- **Writes are UI-only.** The `balance` CLI command should stay read-and-preview (emit the plan as JSON).
  Applying a balance plan belongs in the UI, through `/api/edit`, per the project's no-CLI-writes rule.

## Adjacent backlog items this connects to

- **What-if planning** (ROADMAP backlog): toggle a person's PTO or move scope and watch the forecast
  shift. Balance is the solver; what-if is the interactive exploration around it. They share the capacity
  and forecast inputs, so build them to reuse the same recompute path.
- **Per-person forecast**: today `milestoneForecast` uses team-aggregate throughput. Balance produces a
  per-person allocation, which makes a per-person landing-date forecast possible and more honest.

## Open design questions to settle

- **Objective.** Minimize overload, hit milestone target dates, or spread evenly? These conflict; pick a
  primary and make the rest tie-breaks. The greedy stub optimizes best-fit-then-earliest-cycle; confirm
  that matches intent.
- **How much to move.** Rebalance only unassigned/unscheduled work (least disruptive, what the stub
  does), or also reassign already-owned issues? Reassigning churns ownership and should probably be
  opt-in.
- **Respect locked/started work.** An in-progress issue probably shouldn't be reassigned. Decide whether
  `statusType === "started"` (or a lock flag) freezes an assignment.
- **Affinity vs load.** The stub steers by keyword affinity. Decide when load-balancing overrides a weak
  affinity signal, and keep affinities in config (Settings) rather than hardcoded.
