// Changes page: renders the weekly-update narrative (shipped / moved / at risk) from the server's
// /api/report. Defaults to a project's two most recent snapshots; ‹/› step to an earlier or later "to"
// snapshot and a Range picks how far back "from" should land (closest snapshot to that many days
// earlier), so browsing snapshot history is "pick a date and a window" rather than picking two exact
// snapshots out of a pair of dropdowns — a dropdown-of-timestamps doesn't give any sense of how far
// apart two entries are, and two independent dropdowns make invalid pairs (from after to) easy to hit.

import { escapeHtml, resolveProject } from "./lib/page.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"

applyTheme(loadTheme())

const project = await resolveProject()
const pageEl = document.getElementById("page")
const captureBtn = document.getElementById("capture")
const compareEl = document.getElementById("snap-compare")
const prevBtn = document.getElementById("snap-prev")
const nextBtn = document.getElementById("snap-next")
const windowEl = document.getElementById("snap-window")
const rangeSelect = document.getElementById("snap-range")
const snapHint = document.getElementById("snap-hint")

// Chronological (oldest first) once loaded; toIndex is where "to" points into it.
let snapshots = []
let toIndex = -1

if (!project) {
  document.getElementById("meta").textContent = "No project configured yet."
  captureBtn.hidden = true
} else {
  document.getElementById("title").textContent = `Changes · ${project.name}`
  captureBtn.onclick = async () => {
    captureBtn.disabled = true
    captureBtn.textContent = "Capturing…"
    try {
      await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataFile: project.dataFile, label: "manual" }),
      })
      await loadSnapshots()
      await load()
    } finally {
      captureBtn.disabled = false
      captureBtn.textContent = "Capture snapshot"
    }
  }
  await loadSnapshots()
  await load()
}

function slipPhrase(days) {
  if (!days) return ""
  return days > 0 ? ` (target slipped ${days}d)` : ` (target pulled in ${-days}d)`
}
function signed(n) {
  return n > 0 ? `+${n}` : String(n)
}

function moveLine(m) {
  const parts = []
  if (m.in.length) parts.push(`+${m.in.length} in`)
  if (m.out.length) parts.push(`-${m.out.length} out`)
  if (m.pointsDelta) parts.push(`${signed(m.pointsDelta)} pts`)
  const detail = parts.length ? ` — ${parts.join(", ")}` : ""
  return `<li>${escapeHtml(m.name)}${slipPhrase(m.targetSlipDays)}${detail}</li>`
}

function section(title, body) {
  return `<section class="rsec"><h2>${title}</h2>${body}</section>`
}

function renderReport(report) {
  const shipped = report.shipped.length
    ? `<ul>${
      report.shipped.map((s) => `<li>${escapeHtml(s.id)} <span class="dim">(${escapeHtml(s.milestone)})</span></li>`)
        .join("")
    }</ul>`
    : `<p class="empty">Nothing marked complete this window.</p>`

  const moved = report.moved.length
    ? `<ul>${report.moved.map(moveLine).join("")}</ul>`
    : `<p class="empty">No milestone scope or target changed.</p>`

  const atRisk = report.atRisk.length
    ? `<ul>${
      report.atRisk.map((m) => {
        const why = (m.targetSlipDays ?? 0) > 0
          ? `target slipped ${m.targetSlipDays}d`
          : `scope grew ${signed(m.pointsDelta)} pts`
        return `<li class="risk">${escapeHtml(m.name)} — ${why}</li>`
      }).join("")
    }</ul>`
    : `<p class="empty">No milestone is trending late from this diff.</p>`

  const net = []
  if (report.added.length) net.push(`${report.added.length} added`)
  if (report.removed.length) net.push(`${report.removed.length} removed`)
  net.push(`${signed(report.totals.pointsDelta)} pts net`)

  return `<div class="window">${report.window.from} → ${report.window.to}</div>` +
    section("Shipped", shipped) +
    section("Moved", moved) +
    section("At risk", atRisk) +
    `<div class="scope">Scope: ${net.join(", ")}</div>`
}

function snapshotLabel(row) {
  const when = new Date(row.capturedAt).toISOString().slice(0, 16).replace("T", " ")
  return `${when}${row.label ? ` (${row.label})` : ""}`
}

// Fetches every stored snapshot for this project, oldest first, and points "to" at the latest one.
async function loadSnapshots() {
  const r = await fetch(`/api/snapshots?project=${encodeURIComponent(project.name)}`, { cache: "no-store" })
  const rows = r.ok ? await r.json() : []
  snapshots = [...rows].reverse() // API returns newest-first
  toIndex = snapshots.length - 1
  compareEl.hidden = snapshots.length < 2
  syncStepButtons()
}

// The "from" snapshot for a given "to": among snapshots strictly older than `to`, the one whose
// capturedAt is closest to (to's time - rangeDays). rangeDays 0 ("since last capture") always means
// the one snapshot immediately before `to`. Falls back to the oldest available when the target predates
// every snapshot, so a range longer than the project's whole history still resolves to something.
function resolveFrom(to, rangeDays) {
  const older = snapshots.filter((s) => s.capturedAt < to.capturedAt)
  if (!older.length) return null
  if (rangeDays === 0) return older[older.length - 1]
  const targetMs = to.capturedAt - rangeDays * 86400000
  return older.reduce((best, s) => Math.abs(s.capturedAt - targetMs) < Math.abs(best.capturedAt - targetMs) ? s : best)
}

function syncStepButtons() {
  prevBtn.disabled = toIndex <= 0
  nextBtn.disabled = toIndex >= snapshots.length - 1
}

prevBtn.onclick = () => {
  if (toIndex > 0) toIndex--
  syncStepButtons()
  load()
}
nextBtn.onclick = () => {
  if (toIndex < snapshots.length - 1) toIndex++
  syncStepButtons()
  load()
}
rangeSelect.onchange = load

async function load() {
  pageEl.innerHTML = `<p class="empty">Loading…</p>`
  snapHint.textContent = ""

  if (!snapshots.length) {
    pageEl.innerHTML = `<p class="empty">Need at least two snapshots to compare. ` +
      `Capture one now, refresh the board later, and a diff will show here.</p>`
    return
  }

  const params = new URLSearchParams({ project: project.name })
  if (!compareEl.hidden) {
    const to = snapshots[toIndex]
    const from = resolveFrom(to, Number(rangeSelect.value))
    if (!from) {
      windowEl.textContent = snapshotLabel(to)
      snapHint.textContent = "No earlier snapshot to compare against."
      pageEl.innerHTML = `<p class="empty">Only one snapshot exists at or before this point.</p>`
      return
    }
    windowEl.textContent = `${snapshotLabel(from)} → ${snapshotLabel(to)}`
    params.set("from", from.id)
    params.set("to", to.id)
  }

  const r = await fetch(`/api/report?${params}`, { cache: "no-store" })
  const body = await r.json()
  if (!body.report) {
    pageEl.innerHTML = `<p class="empty">Need at least two snapshots to compare. ` +
      `Capture one now, refresh the board later, and a diff will show here.</p>`
    return
  }
  pageEl.innerHTML = renderReport(body.report)
}
