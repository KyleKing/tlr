// Changes page: renders the weekly-update narrative (shipped / moved / at risk) from the server's
// /api/report. Defaults to a project's two most recent snapshots; ‹‹/›› jump a day and ‹/› step one
// capture to an earlier or later "to", and a Range picks how far back "from" should land (closest
// snapshot to that many days earlier), so browsing snapshot history is "pick a date and a window"
// rather than picking two exact snapshots out of a pair of dropdowns — a dropdown-of-timestamps
// doesn't give any sense of how far apart two entries are, and two independent dropdowns make invalid
// pairs (from after to) easy to hit. Captures land every few hours, so a per-capture step alone would
// take a click per three hours to walk a week; the day jump is the coarse control over the same list.
//
// Every timestamp on this page is local, not the capture's UTC instant or the snapshot's `asOf` date:
// several captures a day share one date, so a date pair cannot tell two windows apart.

import { escapeHtml, resolveProject } from "./lib/page.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"

applyTheme(loadTheme())

const DAY_MS = 86400000

const project = await resolveProject()
const pageEl = document.getElementById("page")
const captureBtn = document.getElementById("capture")
const compareEl = document.getElementById("snap-compare")
const prevDayBtn = document.getElementById("snap-prev-day")
const prevBtn = document.getElementById("snap-prev")
const nextBtn = document.getElementById("snap-next")
const nextDayBtn = document.getElementById("snap-next-day")
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

function renderReport(report, windowText) {
  const shipped = report.shipped.length
    ? `<ul>${
      report.shipped.map((s) =>
        `<li>${escapeHtml(s.id)} <span class="rsec-dim">(${escapeHtml(s.milestone)})</span></li>`
      )
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

  const heading = windowText ?? `${report.window.from} → ${report.window.to}`
  return `<div class="window">${escapeHtml(heading)}</div>` +
    section("Shipped", shipped) +
    section("Moved", moved) +
    section("At risk", atRisk) +
    `<div class="scope">Scope: ${net.join(", ")}</div>`
}

// The year is written only when it isn't the current one, so the common case stays short without
// making a capture from a previous year ambiguous.
function localDay(ms) {
  const d = new Date(ms)
  const withYear = d.getFullYear() !== new Date().getFullYear()
  return d.toLocaleDateString([], { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) })
}
function localClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

// Local time, with the date written once when both ends fall on the same day — most windows are
// intra-day now, and "Jul 24 → Jul 24" says nothing about which two captures are being compared.
function windowLabel(fromMs, toMs) {
  if (localDay(fromMs) === localDay(toMs)) return `${localDay(fromMs)} ${localClock(fromMs)} → ${localClock(toMs)}`
  return `${localDay(fromMs)} ${localClock(fromMs)} → ${localDay(toMs)} ${localClock(toMs)}`
}

function snapshotLabel(row) {
  return `${localDay(row.capturedAt)} ${localClock(row.capturedAt)}${row.label ? ` (${row.label})` : ""}`
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

// The newest capture at least a day older than the current "to", and its mirror going forward. Falls
// back to a single step when nothing sits a full day away, so the button never becomes a no-op while
// history remains in that direction.
function indexADayBack() {
  const target = snapshots[toIndex].capturedAt - DAY_MS
  for (let i = toIndex - 1; i >= 0; i--) {
    if (snapshots[i].capturedAt <= target) return i
  }
  return toIndex - 1
}
function indexADayForward() {
  const target = snapshots[toIndex].capturedAt + DAY_MS
  for (let i = toIndex + 1; i < snapshots.length; i++) {
    if (snapshots[i].capturedAt >= target) return i
  }
  return toIndex + 1
}

function syncStepButtons() {
  prevDayBtn.disabled = toIndex <= 0
  prevBtn.disabled = toIndex <= 0
  nextBtn.disabled = toIndex >= snapshots.length - 1
  nextDayBtn.disabled = toIndex >= snapshots.length - 1
}

function stepTo(index) {
  toIndex = Math.min(snapshots.length - 1, Math.max(0, index))
  syncStepButtons()
  load()
}

prevDayBtn.onclick = () => stepTo(indexADayBack())
prevBtn.onclick = () => stepTo(toIndex - 1)
nextBtn.onclick = () => stepTo(toIndex + 1)
nextDayBtn.onclick = () => stepTo(indexADayForward())
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
  let windowText = null
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
    windowText = windowLabel(from.capturedAt, to.capturedAt)
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
  pageEl.innerHTML = renderReport(body.report, windowText)
}
