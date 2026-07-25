// Balance page: turns `tlr balance`'s proposal into something reviewable and applicable. The plan
// itself is computed server-side (GET /api/balance over src/commands/balance.ts), because the assigner
// is TypeScript running under Deno and this file runs in a browser. Nothing here re-derives it.
//
// Every proposed move is a checkbox over the ops balance already emits, so the write goes through
// POST /api/edit — the one path tlr has to Linear — rather than a second one. Preview is a dry run.
// Unticking a row drops both of its ops (owner and cycle move together; a cycle with no owner is not a
// decision anyone made).

import { escapeHtml, resolveProject } from "./lib/page.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"
import { showError } from "./lib/errorBanner.js"

applyTheme(loadTheme())

const project = await resolveProject()
const pageEl = document.getElementById("page")
const outEl = document.getElementById("out")
const metaEl = document.getElementById("meta")
const previewBtn = document.getElementById("preview")
const applyBtn = document.getElementById("apply")
const controls = document.getElementById("controls")

let plan = null
let mode = { demo: false, workspace: "live" }
const dropped = new Set()

const VERDICT = { "on-track": "ok", "at-risk": "warn", deferred: "warn" }

function controlValues() {
  const read = (id) => {
    const v = document.getElementById(id).value.trim()
    return v === "" ? null : v
  }
  return { start: read("bal-start"), end: read("bal-end"), weekly: read("bal-weekly"), lead: read("bal-lead") }
}

async function loadPlan() {
  pageEl.innerHTML = `<p class="empty">Computing…</p>`
  outEl.hidden = true
  const params = new URLSearchParams({ dataFile: project.dataFile })
  for (const [k, v] of Object.entries(controlValues())) if (v != null) params.set(k, v)
  const r = await fetch(`/api/balance?${params}`, { cache: "no-store" })
  const body = await r.json()
  if (!r.ok) throw new Error(body.error ?? `balance → ${r.status}`)
  plan = body
  dropped.clear()
  render()
}

// A row's ops are the ones naming its ticket. Balance emits set_assignee and set_cycle per assignment,
// so dropping a row has to drop both: applying an owner move without its cycle move would leave the
// ticket owned by someone with no room booked for it.
function opsFor(id) {
  return plan.ops.filter((op) => op.id === id)
}

function selectedOps() {
  return plan.assignments.filter((a) => !dropped.has(a.id)).flatMap((a) => opsFor(a.id))
}

function syncButtons() {
  const n = selectedOps().length
  previewBtn.disabled = n === 0
  applyBtn.disabled = true
  previewBtn.textContent = n ? `Preview ${n} change${n === 1 ? "" : "s"}` : "Preview"
  applyBtn.textContent = mode.demo ? "Apply to demo workspace" : "Apply to live workspace"
}

function assignmentRow(a) {
  const checked = dropped.has(a.id) ? "" : " checked"
  const cycle = a.cycle == null ? `<span class="bal-dim">no room in window</span>` : `cycle ${a.cycle}`
  return `<tr${dropped.has(a.id) ? ' class="bal-off"' : ""}>` +
    `<td><input type="checkbox" data-id="${escapeHtml(a.id)}"${checked} aria-label="Include ${
      escapeHtml(a.id)
    }" /></td>` +
    `<td><b>${escapeHtml(a.id)}</b><div class="bal-dim">${escapeHtml(a.title)}</div></td>` +
    `<td>${escapeHtml(a.person)}</td><td>${cycle}</td><td>${a.estimate || "—"}</td>` +
    `<td>${escapeHtml(a.milestone ?? "—")}</td><td class="bal-dim">${escapeHtml(a.reason)}</td></tr>`
}

function table(title, rows, head) {
  if (!rows.length) return ""
  return `<section class="bal-sec"><h2>${title}</h2><table class="bal-table"><thead><tr>${
    head.map((h) => `<th>${h}</th>`).join("")
  }</tr></thead><tbody>${rows.join("")}</tbody></table></section>`
}

function capacityHTML() {
  if (!plan.perCycle.length) return ""
  const people = plan.options.people
  const head = ["Cycle", ...people.map(escapeHtml)]
  const rows = plan.perCycle.map((c) => {
    const cells = people.map((p) => {
      // byPerson is everything booked in that cycle, committed work plus what this plan just placed.
      // It goes against the ceiling, not against `capacity.free`, which is the running remainder the
      // assigner drains as it places and so reads as near-zero for anyone it filled up.
      const row = plan.capacity.find((x) => x.person === p && x.cycle === c.cycle)
      const booked = c.byPerson[p] ?? 0
      if (!row) return `<td>${booked}</td>`
      const over = booked > row.capacity
      return `<td${over ? ' class="bal-over"' : ""}>${booked} of ${row.capacity}</td>`
    })
    return `<tr><td>cycle ${c.cycle}<div class="bal-dim">ends ${escapeHtml(c.end)}</div></td>${cells.join("")}</tr>`
  })
  return table("Where the points land", rows, head)
}

function milestoneHTML() {
  const rows = plan.milestoneRisk.map((m) =>
    `<tr><td><b>${escapeHtml(m.key)}</b></td><td>${escapeHtml(m.target)}</td>` +
    `<td>${escapeHtml(m.latestScheduledEnd ?? "—")}</td><td>${m.unscheduledPoints || "—"}</td>` +
    `<td class="bal-${VERDICT[m.verdict] ?? "dim"}">${escapeHtml(m.verdict)}</td></tr>`
  )
  return table("Milestones under this plan", rows, ["Milestone", "Target", "Last work lands", "Unplaced", ""])
}

function render() {
  const n = plan.assignments.length
  metaEl.textContent = n
    ? `${n} ticket${n === 1 ? "" : "s"} to place across cycles ${plan.options.start}–${plan.options.end}`
    : "Nothing unscheduled to place"

  const warnings = plan.warnings.length
    ? `<div class="bal-warnings">${plan.warnings.map((w) => `<p>${escapeHtml(w)}</p>`).join("")}</div>`
    : ""
  const atRisk = plan.atRisk.length
    ? table(
      "Flagged by the assigner",
      plan.atRisk.map((r) =>
        `<tr><td><b>${escapeHtml(r.id)}</b><div class="bal-dim">${escapeHtml(r.title)}</div></td>` +
        `<td>${escapeHtml(r.milestone ?? "—")}</td><td>${escapeHtml(r.reason)}</td></tr>`
      ),
      ["Ticket", "Milestone", "Why"],
    )
    : ""

  const head = ["", "Ticket", "Owner", "Cycle", "Points", "Milestone", "Why"]
  pageEl.innerHTML = warnings +
    table("Proposed moves", plan.assignments.map(assignmentRow), head) +
    table("Owned, but no room in the window", plan.unscheduled.map(assignmentRow), head) +
    capacityHTML() + milestoneHTML() + atRisk +
    (n ? "" : `<p class="empty">Every open ticket already has a cycle.</p>`)
  syncButtons()
}

pageEl.addEventListener("change", (e) => {
  const box = e.target.closest("input[type=checkbox][data-id]")
  if (!box) return
  box.checked ? dropped.delete(box.dataset.id) : dropped.add(box.dataset.id)
  render()
})

controls.addEventListener("submit", (e) => {
  e.preventDefault()
  loadPlan().catch(showError)
})

async function postEdit(ops, confirm) {
  const r = await fetch("/api/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataFile: project.dataFile, ops, confirm }),
  })
  return await r.json()
}

function resultHTML(title, rows, extra = "") {
  return `<h3>${title}</h3>${
    rows.length ? `<ul class="bal-list">${rows.join("")}</ul>` : `<p class="bal-dim">Nothing.</p>`
  }${extra}`
}

previewBtn.addEventListener("click", async () => {
  previewBtn.disabled = true
  try {
    const res = await postEdit(selectedOps(), false)
    if (res.error) throw new Error(res.error)
    const willApply = (res.willApply ?? []).map((op) =>
      `<li><b>${escapeHtml(op.id)}</b> ${escapeHtml(op.kind.replace("set_", ""))} → ${
        escapeHtml(String(op.assignee ?? op.cycle ?? ""))
      }</li>`
    )
    const skipped = (res.skipped ?? []).map((s) =>
      `<li class="bal-warn"><b>${escapeHtml(s.op.id ?? "?")}</b> ${escapeHtml(s.reason)}</li>`
    )
    outEl.hidden = false
    outEl.innerHTML = resultHTML(`Dry run against the ${escapeHtml(res.mode)} workspace`, willApply) +
      (skipped.length ? resultHTML("Skipped", skipped) : "")
    applyBtn.disabled = willApply.length === 0
  } catch (err) {
    showError(err)
  } finally {
    previewBtn.disabled = selectedOps().length === 0
  }
})

applyBtn.addEventListener("click", async () => {
  applyBtn.disabled = true
  applyBtn.textContent = "Applying…"
  try {
    const res = await postEdit(selectedOps(), true)
    if (res.error) throw new Error(res.error)
    const rows = (res.results ?? []).map((r) =>
      `<li class="${r.ok ? "bal-ok" : "bal-warn"}"><b>${escapeHtml(r.id ?? "?")}</b> ${
        escapeHtml(r.ok ? "written" : (r.error ?? "failed"))
      }</li>`
    )
    outEl.hidden = false
    outEl.innerHTML = resultHTML("Applied", rows)
    // The plan is stale the moment a write lands, so recompute rather than leave rows offering moves
    // that already happened.
    await loadPlan()
  } catch (err) {
    showError(err)
  } finally {
    syncButtons()
  }
})

mode = await fetch("/api/mode").then((r) => r.json()).catch(() => mode)
await loadPlan().catch(showError)
