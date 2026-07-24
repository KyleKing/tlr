// Settings page: appearance, capacity, roster, integrations, and secrets. This is the config that used to open
// as a dialog on the board, moved to its own routed page. Appearance writes the theme to localStorage
// so every page picks it up; the rest saves the capacity block back to the project's data file (POST
// /api/config) or re-runs the Linear/Incident.io/Calendar fetches (POST /api/refresh), the same
// handlers the board's refresh used. On-call/out-days overrides are edited on the Board itself now
// (click a 📟/🧳 badge, or right-click a cycle cell), not here — that's where the data already shows,
// so a separate per-person/per-cycle grid of inputs for the same thing was one editor too many. The
// Secrets pane sets and clears the Linear key and the Incident.io token through POST /api/secrets; it
// only ever learns whether a key is set and where it came from, never the value.

import { ACCENTS, FLAVORS, themeVars } from "./lib/theme.js"
import { applyTheme, loadTheme } from "./lib/appearance.js"
import { updateCapacityConfig, updateRosterEmail } from "./lib/config.js"
import { resolveProject } from "./lib/page.js"
import { showError } from "./lib/errorBanner.js"

const project = await resolveProject()
const theme = loadTheme()

// The Secrets pane builds its own markup in the browser instead of shipping in the server-rendered
// template, so no credential state is ever baked into the HTML the server sends.
const SECRETS_PANE = `
  <div class="cfg-section">
    <h3>Credentials</h3>
    <p class="cfg-hint">Keys go to the macOS keychain through the same path the CLI reads. They are
      write-only here: this page can see whether a key is set, never what it is. An environment
      variable wins over the keychain, so a key supplied that way is read-only below.</p>
    <div id="cfg-secrets" class="cfg-secrets"></div>
  </div>
  <div class="cfg-section">
    <h3>Google Calendar</h3>
    <p class="cfg-hint" id="cfg-google"></p>
  </div>`

const flavorPicker = document.getElementById("flavor-picker")
const accentPicker = document.getElementById("accent-picker")
const workdaysInput = document.getElementById("cfg-workdays")
const oncallPenaltyInput = document.getElementById("cfg-oncall-penalty")
const defaultVelocityInput = document.getElementById("cfg-default-velocity")
const rosterEl = document.getElementById("cfg-roster")
const cfgStatus = document.getElementById("cfg-status")
const cfgNav = document.getElementById("cfg-nav")
const cfgRefreshLog = document.getElementById("cfg-refresh-log")

let data = { capacity: {} }

function paintTheme() {
  applyTheme(theme)
  for (const btn of flavorPicker.querySelectorAll(".flavor-btn")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.flavor === theme.flavor))
  }
  for (const sw of accentPicker.querySelectorAll(".swatch")) {
    sw.style.background = themeVars(theme.flavor, sw.dataset.accent)["--accent"]
    sw.setAttribute("aria-pressed", String(sw.dataset.accent === theme.accent))
  }
}

flavorPicker.innerHTML = FLAVORS
  .map((f) => `<button class="flavor-btn" data-flavor="${f}">${f[0].toUpperCase()}${f.slice(1)}</button>`)
  .join("")
flavorPicker.addEventListener("click", (e) => {
  const btn = e.target.closest(".flavor-btn")
  if (!btn) return
  theme.flavor = btn.dataset.flavor
  paintTheme()
})

accentPicker.innerHTML = ACCENTS.map((a) => `<button class="swatch" data-accent="${a}" title="${a}"></button>`).join("")
accentPicker.addEventListener("click", (e) => {
  const sw = e.target.closest(".swatch")
  if (!sw) return
  theme.accent = sw.dataset.accent
  paintTheme()
})

cfgNav.addEventListener("click", (e) => {
  const btn = e.target.closest(".cfg-nav-item")
  if (!btn) return
  for (const b of cfgNav.querySelectorAll(".cfg-nav-item")) b.setAttribute("aria-current", String(b === btn))
  for (const pane of document.querySelectorAll(".cfg-pane")) pane.hidden = pane.dataset.pane !== btn.dataset.pane
})

function mountSecretsPane() {
  const navItem = document.createElement("button")
  navItem.className = "cfg-nav-item"
  navItem.dataset.pane = "secrets"
  navItem.textContent = "Secrets"
  navItem.setAttribute("aria-current", "false")
  cfgNav.append(navItem)

  const pane = document.createElement("div")
  pane.className = "cfg-pane"
  pane.dataset.pane = "secrets"
  pane.hidden = true
  pane.innerHTML = SECRETS_PANE
  document.querySelector(".cfg-panes").append(pane)
  pane.addEventListener("click", onSecretAction)
}

function secretState(secret) {
  if (secret.source === "env") return { label: "Set · environment", cls: "is-env" }
  if (secret.source === "keychain") return { label: "Set · keychain", cls: "is-set" }
  return { label: "Not set", cls: "is-unset" }
}

function secretRow(secret) {
  const state = secretState(secret)
  const mask = secret.source === "unset" ? "" : `<span class="cfg-secret-mask" aria-hidden="true">••••••••</span>`
  return `<div class="cfg-secret" data-name="${secret.name}">` +
    `<div class="cfg-secret-head"><span class="name">${secret.label}</span>` +
    `<span class="cfg-secret-state ${state.cls}">${state.label}</span></div>` +
    `<p class="cfg-secret-note">${secret.note}</p>` +
    `<div class="cfg-secret-actions">${mask}` +
    `<input type="password" autocomplete="off" spellcheck="false" aria-label="New ${secret.label}"` +
    ` placeholder="Paste a new value"${secret.editable ? "" : " disabled"} />` +
    `<button class="pill" data-act="set"${secret.editable ? "" : " disabled"}>Save</button>` +
    `<button class="pill" data-act="clear"${secret.editable && secret.source === "keychain" ? "" : " disabled"}>` +
    `Clear</button></div></div>`
}

function renderSecrets(payload) {
  document.getElementById("cfg-secrets").innerHTML = payload.secrets.map(secretRow).join("")
  const google = payload.google
  const state = google.connected ? "Connected" : google.client ? "Client saved, not yet authorized" : "Not connected"
  document.getElementById("cfg-google").innerHTML = `${state}. Consent happens in a browser against a ` +
    `Desktop OAuth client, so it runs from the terminal: <code>${google.command}</code>. ` +
    `The client JSON lives in <code>web/data/gcal-client.json</code> and the cached refresh token in ` +
    `<code>web/data/gcal-token.json</code>.`
}

function replaceSecretRow(secret) {
  const row = document.querySelector(`.cfg-secret[data-name="${secret.name}"]`)
  if (row) row.outerHTML = secretRow(secret)
}

async function onSecretAction(e) {
  const btn = e.target.closest("button[data-act]")
  if (!btn) return
  const row = btn.closest(".cfg-secret")
  const input = row.querySelector("input")
  const action = btn.dataset.act
  if (action === "set" && !input.value.trim()) {
    cfgStatus.textContent = "Paste a value first"
    return
  }

  cfgStatus.textContent = action === "set" ? "Saving…" : "Clearing…"
  try {
    const res = await fetch("/api/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: row.dataset.name, action, value: action === "set" ? input.value : undefined }),
    })
    const body = await res.json()
    input.value = ""
    if (!res.ok || !body.ok) throw new Error(body.error ?? `secret update failed: ${res.status}`)
    replaceSecretRow(body.secret)
    cfgStatus.textContent = action === "set" ? "Saved" : "Cleared"
  } catch (err) {
    cfgStatus.textContent = err instanceof Error ? err.message : "Secret update failed"
    showError(err, "Secret update failed")
  }
}

async function loadSecrets() {
  try {
    const res = await fetch("/api/secrets", { cache: "no-store" })
    if (!res.ok) throw new Error(`secrets unavailable: ${res.status}`)
    renderSecrets(await res.json())
  } catch (err) {
    document.getElementById("cfg-secrets").textContent = "Could not read credential status."
    showError(err, "Secrets load failed")
  }
}

function renderConfigForm() {
  const cap = data.capacity ?? {}
  workdaysInput.value = cap.config?.workdaysPerCycle ?? 5
  oncallPenaltyInput.value = cap.config?.oncallPenalty ?? 0.45
  defaultVelocityInput.value = cap.defaultVelocity ?? 20
  rosterEl.innerHTML = Object.entries(cap.roster ?? {}).map(([name, info]) =>
    `<div class="cfg-roster-row"><span class="name">${name}</span>` +
    `<input type="email" data-name="${name}" value="${info.email ?? ""}" /></div>`
  ).join("")
  cfgStatus.textContent = ""
  cfgRefreshLog.hidden = true
}

document.getElementById("cfg-save").addEventListener("click", async () => {
  let capacity = updateCapacityConfig(data.capacity ?? {}, {
    config: { workdaysPerCycle: Number(workdaysInput.value), oncallPenalty: Number(oncallPenaltyInput.value) },
    defaultVelocity: Number(defaultVelocityInput.value),
  })
  for (const input of rosterEl.querySelectorAll("input")) {
    capacity = updateRosterEmail(capacity, input.dataset.name, input.value.trim())
  }

  cfgStatus.textContent = "Saving…"
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataFile: project.dataFile, capacity }),
    })
    if (!res.ok) throw new Error(`save failed: ${res.status}`)
    data.capacity = capacity
    cfgStatus.textContent = "Saved"
  } catch (err) {
    cfgStatus.textContent = err instanceof Error ? err.message : "Save failed"
    showError(err, "Settings save failed")
  }
})

document.getElementById("cfg-refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget
  btn.disabled = true
  btn.textContent = "Refreshing…"
  cfgRefreshLog.hidden = false
  cfgRefreshLog.textContent = ""
  try {
    const res = await fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataFile: project.dataFile }),
    })
    const body = await res.json()
    cfgRefreshLog.textContent = (body.log ?? []).join("\n") || "(no output)"
    if (!res.ok || !body.ok) {
      cfgRefreshLog.textContent += `\n\nerror: ${body.error ?? res.status}`
    } else {
      await loadData()
      renderConfigForm()
    }
  } catch (err) {
    cfgRefreshLog.textContent = err instanceof Error ? err.message : "Refresh failed"
    showError(err, "Settings refresh failed")
  } finally {
    btn.disabled = false
    btn.textContent = "Refresh all"
  }
})

async function loadData() {
  const r = await fetch(`/data/${project.dataFile}`, { cache: "no-store" })
  data = r.ok ? await r.json() : { capacity: {} }
}

// Entry point last, so the top-level await runs after every const/function above is initialized.
paintTheme()
mountSecretsPane()
if (!project) {
  cfgStatus.textContent = "No project configured yet."
} else {
  document.getElementById("title").textContent = `Settings · ${project.name}`
  await loadData()
  renderConfigForm()
}
await loadSecrets()
