// The edit modal's right-hand column: the consequence of the edit in progress. A read-only view. It
// never writes, never calls /api/edit, and never mutates the snapshot — every number comes from
// web/lib/impact.js, which simulates the pending change in memory.
//
// renderImpact(el, ctx) is called once when the modal opens and again on every form change. It owns
// `el` outright: the same ctx produces the same pane. The heavy half (load, forecast, dependencies)
// is memoized on impactKey(), so typing in the description re-runs a slop scan and nothing else, and
// editForm debounces the keystroke path on top of that.
//
// A failure in here must not take the form down with it, so the whole render is contained: the pane
// says it could not be drawn and the error goes to the page banner.
//
// ctx:
//   issue        the ticket being edited, exactly as the page loaded it from the snapshot
//   values       every editable field's current form value, changed or not, already normalized
//                (assignee, cycle, description, estimate, milestone, priority, status, title)
//   edit         the pending edit as a field → new value map, holding only fields that differ from
//                the issue; empty when nothing has been touched
//   changed      the same edit written for a reader: [{ field, label, from, to, fromValue, toValue }]
//   ops          the /api/edit ops `changed` would send, so the pane can reason about the real write
//   snapshot     the whole project snapshot behind the page (project, asOf, cycles, milestones,
//                issues, capacity), the same object the board and Review pages render from
//   options      fieldOptions(issue, snapshot) — every allowed value for each field
//   valid        false while any field fails validation, in which case `ops` will not be sent
//   errors       field → one-sentence reason, for the fields that fail validation
//   source       "board" or "review", where the modal was opened from
//   reviewItems  on Review, that ticket's rows in the open review window; the page already holds the
//                payload, so the pane is handed it rather than fetching it back
//   dataFile     the snapshot's data file, the same one the write path posts
//   phase        "open" before anything is touched, "editing" once a field changes, "previewed" after
//                a successful dry run, "applied" after a write lands

import { escapeHtml } from "./page.js"
import { showError } from "./errorBanner.js"
import { impactKey, impactOf, scopeImpact } from "./impact.js"

const STATUS_SHORT = {
  backlog: "Backlog",
  canceled: "Canceled",
  completed: "Done",
  started: "In progress",
  triage: "Triage",
  unstarted: "Todo",
}

let cache = null

function cachedScope(ctx) {
  const key = impactKey(ctx)
  if (cache && cache.snapshot === ctx.snapshot && cache.key === key) return cache.scope
  const scope = scopeImpact(ctx)
  cache = { key, scope, snapshot: ctx.snapshot }
  return scope
}

function section(title, body) {
  if (!body) return ""
  return `<section class="eimpact-sec"><h4 class="eimpact-sec-h">${title}</h4>${body}</section>`
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n)
}

function deltaHTML(before, after) {
  if (after === before) return `<span class="eimpact-num">${before}</span>`
  const dir = after > before ? "up" : "down"
  return `<span class="eimpact-num">${before}</span> → <span class="eimpact-num ${dir}">${after}</span>`
}

function summaryHTML(changed) {
  if (!changed.length) return `<p class="eimpact-line">No changes yet.</p>`
  const fields = changed.map((c) => c.label.toLowerCase()).join(", ")
  return `<p class="eimpact-line">${changed.length} field${changed.length === 1 ? "" : "s"} pending: ${
    escapeHtml(fields)
  }.</p>`
}

function loadHTML(cells) {
  if (!cells.length) return ""
  const rows = cells.map((cell) => {
    const cap = cell.capacity == null ? "" : ` of ${cell.capacity}`
    return `<li${cell.over ? ' class="warn"' : ""}>${escapeHtml(cell.person)}, cycle ${cell.cycle}: ` +
      `${deltaHTML(cell.before, cell.after)}${cap} points${cell.over ? " — over capacity" : ""}</li>`
  })
  return section("Load", `<ul class="eimpact-list">${rows.join("")}</ul>`)
}

function forecastHTML(milestones) {
  if (!milestones.length) return ""
  const rows = milestones.map((m) =>
    `<li${m.shiftDays > 0 ? ' class="warn"' : ""}>${escapeHtml(m.name)}: ${m.baselineLanding} → ` +
    `<span class="eimpact-num ${m.shiftDays > 0 ? "up" : "down"}">${m.landing}</span> ` +
    `(${signed(m.shiftDays)}d)</li>`
  )
  return section(
    "Forecast",
    `<ul class="eimpact-list">${rows.join("")}</ul>` +
      `<p class="eimpact-note">Forecast landings, not real dates.</p>`,
  )
}

function depRow(row, verb) {
  const status = STATUS_SHORT[row.statusType] ?? row.statusType ?? "unknown"
  return `<li${row.risk ? ' class="warn"' : ""}>${verb} <b>${escapeHtml(row.id)}</b> ` +
    `<span class="eimpact-dim">${escapeHtml(status)}, lands ${escapeHtml(row.lands)}</span></li>`
}

// The chain line. A chain runs one ticket at a time, so it is sized against the people on it: whether
// the sequential work fits before the milestone target is the question, not whether the team is busy.
function chainHTML({ chain, chainWas }) {
  if (!chain) return ""
  const who = chain.owners
    .map((o) => `${escapeHtml(o.person)} ${o.points}pt at ${o.perCycle}/cycle`)
    .join(", ")
  const spans = []
  if (chain.spans.milestones > 1) spans.push(`${chain.spans.milestones} milestones`)
  if (chain.spans.cycles > 1) spans.push(`${chain.spans.cycles} cycles`)
  const span = spans.length ? ` spanning ${spans.join(" and ")}` : ""
  const head = `<p class="eimpact-note">In a ${chain.size}-ticket chain${span}, ` +
    `${chain.points} points on the critical path: ${who}.</p>`

  if (chain.stalled) {
    return `${head}<p class="eimpact-warn">An owner on this chain has no capacity, so it never finishes.</p>`
  }
  if (chain.cyclesAvailable == null) {
    return head +
      `<p class="eimpact-note">Needs ${chain.cyclesNeeded} cycles. No milestone target to measure against.</p>`
  }
  const verdict = chain.atRisk
    ? `<p class="eimpact-warn">Needs ${chain.cyclesNeeded} cycles with ${chain.cyclesAvailable} left before ` +
      `${escapeHtml(chain.target)}: ${chain.shortfall} short.${
        chainWas && !chainWas.atRisk ? " This edit is what pushed it over." : ""
      }</p>`
    : `<p class="eimpact-good">Needs ${chain.cyclesNeeded} cycles with ${chain.cyclesAvailable} left before ` +
      `${escapeHtml(chain.target)}.${chainWas?.atRisk ? " This edit brought it back inside." : ""}</p>`
  return head + verdict
}

function dependenciesHTML(deps) {
  const rows = [
    ...deps.blockedBy.map((r) => depRow(r, "waits on")),
    ...deps.blocks.map((r) => depRow(r, "blocks")),
  ]
  if (!rows.length) return ""
  return section("Dependencies", `<ul class="eimpact-list">${rows.join("")}</ul>${chainHTML(deps)}`)
}

function slopHTML(text) {
  if (!text) return ""
  const flags = text.now.flags.length ? escapeHtml(text.now.flags.join(", ")) : "nothing flagged"
  const cls = text.verdict === "worse" ? "eimpact-warn" : text.verdict === "cleaner" ? "eimpact-good" : "eimpact-note"
  return section(
    "Description",
    `<p class="${cls}">Slop score ${deltaHTML(text.was.score, text.now.score)} — ${escapeHtml(text.verdict)}.</p>` +
      `<p class="eimpact-note">${flags}</p>`,
  )
}

function reviewHTML(items) {
  if (!items.length) return ""
  const rows = items.map((item) => {
    const move = item.from == null && item.to == null
      ? ""
      : ` <span class="eimpact-dim">${escapeHtml(String(item.from ?? "none"))} → ${
        escapeHtml(String(item.to ?? "none"))
      }</span>`
    return `<li><span class="eimpact-kind">${escapeHtml(item.kind)}</span> ${escapeHtml(item.summary)}${move}</li>`
  })
  return section("In this review window", `<ul class="eimpact-list">${rows.join("")}</ul>`)
}

function warningsHTML(warnings) {
  if (!warnings.length) return ""
  const rows = warnings.map((w) => `<li>${escapeHtml(w)}</li>`)
  return `<ul class="eimpact-list eimpact-alert">${rows.join("")}</ul>`
}

function paneHTML(ctx) {
  const impact = impactOf(ctx, cachedScope(ctx))
  const { scope } = impact
  return `<h3 class="eimpact-h">Impact</h3>` +
    summaryHTML(ctx.changed ?? []) +
    warningsHTML(impact.warnings) +
    loadHTML(scope.cells) +
    forecastHTML(scope.forecast) +
    dependenciesHTML(scope.dependencies) +
    slopHTML(impact.text) +
    reviewHTML(impact.review)
}

export function renderImpact(el, ctx) {
  try {
    el.innerHTML = paneHTML(ctx)
  } catch (err) {
    cache = null
    el.innerHTML = `<h3 class="eimpact-h">Impact</h3>` +
      `<p class="eimpact-warn">The impact pane could not be drawn. The form still works.</p>`
    showError(err, "Impact pane")
  }
}
