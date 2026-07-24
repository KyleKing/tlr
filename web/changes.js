// Changes page: renders the weekly-update narrative (shipped / moved / at risk) from the server's
// /api/report. Defaults to a project's two most recent snapshots; the From/To pickers (populated from
// /api/snapshots) let you diff any two captures instead, so snapshot history is browsable here rather
// than only ever showing "since last time."

import { escapeHtml, resolveProject } from "./lib/page.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"

applyTheme(loadTheme())

const project = await resolveProject()
const pageEl = document.getElementById("page")
const captureBtn = document.getElementById("capture")
const compareEl = document.getElementById("snap-compare")
const fromSelect = document.getElementById("snap-from")
const toSelect = document.getElementById("snap-to")
const snapHint = document.getElementById("snap-hint")

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

// Populates the From/To pickers with every stored snapshot for this project (newest last, so "To"
// defaults to the latest), oldest→newest so the list reads chronologically top to bottom.
async function loadSnapshots() {
  const r = await fetch(`/api/snapshots?project=${encodeURIComponent(project.name)}`, { cache: "no-store" })
  const rows = r.ok ? await r.json() : []
  if (rows.length < 2) {
    compareEl.hidden = true
    return
  }
  const ordered = [...rows].reverse() // API returns newest-first; the pickers read oldest-first
  const options = ordered.map((row) => `<option value="${row.id}">${escapeHtml(snapshotLabel(row))}</option>`).join(
    "",
  )
  fromSelect.innerHTML = options
  toSelect.innerHTML = options
  fromSelect.value = ordered[ordered.length - 2].id
  toSelect.value = ordered[ordered.length - 1].id
  compareEl.hidden = false
  fromSelect.onchange = load
  toSelect.onchange = load
}

async function load() {
  pageEl.innerHTML = `<p class="empty">Loading…</p>`
  const params = new URLSearchParams({ project: project.name })
  const usingPicker = !compareEl.hidden
  if (usingPicker) {
    params.set("from", fromSelect.value)
    params.set("to", toSelect.value)
  }
  snapHint.textContent = ""
  if (usingPicker && fromSelect.value === toSelect.value) {
    snapHint.textContent = "Pick two different snapshots."
    pageEl.innerHTML = `<p class="empty">From and To are the same snapshot — nothing to diff.</p>`
    return
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
