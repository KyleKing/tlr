// The ticket editor: one large modal, opened from the Review page and from the Board's hover card,
// over a dimmed page. The fixed fields sit in a grid across the top, the description fills the rest of
// the height, and the right-hand column carries the impact of the edit in progress (web/lib/editImpact.js).
//
// It is a native <dialog>, so focus containment, the top layer, and Escape come from the platform
// rather than from a hand-rolled trap. Escape and the backdrop route through the unsaved-changes guard
// instead of closing outright, and focus returns to whatever opened the modal.
//
// Every rule the modal enforces is decided elsewhere and only rendered here: the allowed values in
// web/lib/fieldOptions.js, validation and the changed-field diff in web/lib/editRules.js, the
// description preview in web/lib/markdown.js. The write path is unchanged — Preview is a dry run
// through POST /api/edit, Apply is the same call with confirm, and nothing writes without it.

import { escapeHtml } from "./page.js"
import { showError } from "./errorBanner.js"
import { fieldOptions } from "./fieldOptions.js"
import {
  changedFields,
  issueValues,
  normalizeValues,
  opsForChanges,
  pendingEdit,
  TITLE_MAX,
  validateEdit,
} from "./editRules.js"
import { renderImpact } from "./editImpact.js"
import { renderMarkdown } from "./markdown.js"

const DIALOG_ID = "edit-modal"
const IMPACT_DEBOUNCE_MS = 150
const FIELD_NAMES = ["assignee", "cycle", "description", "estimate", "milestone", "priority", "status", "title"]

function optionTags(options, selected) {
  const want = selected == null ? "" : String(selected)
  return options.map((o) => {
    const value = o.value == null ? "" : String(o.value)
    return `<option value="${escapeHtml(value)}"${value === want ? " selected" : ""}>${escapeHtml(o.label)}</option>`
  }).join("")
}

function fieldHTML(name, label, control, hint) {
  return `<div class="efield" data-field="${name}">` +
    `<label for="ef-${name}">${label}</label>${control}` +
    (hint ? `<p class="efield-hint">${escapeHtml(hint)}</p>` : "") +
    `<p class="efield-err" id="ef-${name}-err" hidden></p>` +
    `</div>`
}

function selectHTML(name, options, selected) {
  return `<select id="ef-${name}" name="${name}" aria-describedby="ef-${name}-err">${
    optionTags(options, selected)
  }</select>`
}

function estimateHTML(options, current) {
  const scale = options.map((o) => o.value)
  const list = scale.map((v) => `<option value="${v}"></option>`).join("")
  return `<input id="ef-estimate" name="estimate" type="number" inputmode="numeric" step="1" min="0" ` +
    `list="ef-estimate-scale" value="${current ?? ""}" aria-describedby="ef-estimate-err" />` +
    `<datalist id="ef-estimate-scale">${list}</datalist>`
}

function fieldsHTML(issue, options) {
  const cur = issueValues(issue)
  const scale = options.estimates.map((o) => o.value).join(", ")
  return `<div class="emodal-fields">` +
    fieldHTML(
      "title",
      "Title",
      `<input id="ef-title" name="title" type="text" autofocus value="${escapeHtml(cur.title)}" ` +
        `aria-describedby="ef-title-err" />`,
      `Up to ${TITLE_MAX} characters.`,
    ) +
    fieldHTML("status", "Status", selectHTML("status", options.statuses, cur.status)) +
    fieldHTML("assignee", "Assignee", selectHTML("assignee", options.assignees, cur.assignee)) +
    fieldHTML("cycle", "Cycle", selectHTML("cycle", options.cycles, cur.cycle)) +
    fieldHTML("milestone", "Milestone", selectHTML("milestone", options.milestones, cur.milestone)) +
    fieldHTML(
      "estimate",
      "Estimate",
      estimateHTML(options.estimates, cur.estimate),
      `Allowed: ${scale}. Blank keeps the current estimate.`,
    ) +
    fieldHTML("priority", "Priority", selectHTML("priority", options.priorities, cur.priority)) +
    `</div>`
}

function descriptionHTML(issue) {
  return `<div class="emodal-desc">` +
    `<div class="emodal-desc-h">` +
    `<label for="ef-description">Description</label>` +
    `<div class="emodal-desc-tabs" role="group" aria-label="Description view">` +
    `<button type="button" class="chip mini" data-desc="write" aria-pressed="true">Edit</button>` +
    `<button type="button" class="chip mini" data-desc="preview" aria-pressed="false">Preview</button>` +
    `</div></div>` +
    `<textarea id="ef-description" name="description" class="emodal-ta" spellcheck="true">${
      escapeHtml(issue.description ?? "")
    }</textarea>` +
    `<div class="emodal-md md" hidden></div>` +
    `</div>`
}

function modalHTML(issue, options, mode) {
  const applyLabel = mode?.demo ? "Apply to demo workspace" : "Apply to live workspace"
  return `<div class="emodal-inner">` +
    `<header class="emodal-head">` +
    `<h2 id="emodal-title">Edit ${escapeHtml(issue.id)}</h2>` +
    `<button type="button" class="emodal-x" data-act="close" aria-label="Close the editor">✕</button>` +
    `</header>` +
    `<div class="emodal-body">` +
    `<form class="editf emodal-form" data-id="${escapeHtml(issue.id)}"${issue.linearId ? "" : ' data-nouuid="1"'}>` +
    fieldsHTML(issue, options) + descriptionHTML(issue) +
    `</form>` +
    `<aside class="emodal-impact" id="edit-impact" aria-label="Impact of this edit"></aside>` +
    `</div>` +
    `<footer class="emodal-foot">` +
    (issue.linearId
      ? ""
      : `<p class="editf-warn">No Linear link for this ticket — refresh from Linear before editing.</p>`) +
    `<div class="emodal-guard" role="alert" hidden>` +
    `<span>Unsaved changes. Closing now drops them.</span>` +
    `<button type="button" class="chip mini" data-act="keep">Keep editing</button>` +
    `<button type="button" class="chip mini danger" data-act="discard">Discard changes</button>` +
    `</div>` +
    `<div class="emodal-out" hidden></div>` +
    `<div class="editf-actions">` +
    `<button type="button" class="chip" data-act="preview" disabled>Preview</button>` +
    `<button type="button" class="chip ${mode?.demo ? "" : "danger"}" data-act="apply" disabled>${
      escapeHtml(applyLabel)
    }</button>` +
    `<button type="button" class="chip ghost" data-act="cancel">Cancel</button>` +
    `</div></footer></div>`
}

async function postEdit(dataFile, ops, confirm) {
  const r = await fetch("/api/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataFile, ops, confirm }),
  })
  return await r.json()
}

// One row per field the form actually changed, old value to new — never the whole ticket. A change the
// server would drop is called out on its own row, with the reason it gave.
function changeListHTML(id, changed, skipped) {
  const reasons = new Map((skipped ?? []).map((s) => [s.op.kind, s.reason]))
  const rows = changed.map((c) => {
    const kind = opsForChanges(id, [c])[0].kind
    const reason = reasons.get(kind)
    return `<li${reason ? ' class="dropped"' : ""}><b>${escapeHtml(c.label)}</b> ` +
      `<span class="efrom">${escapeHtml(c.from)}</span> → <span class="eto">${escapeHtml(c.to)}</span>` +
      (reason ? ` <span class="ereason">skipped — ${escapeHtml(reason)}</span>` : "") +
      `</li>`
  })
  return `<p class="emodal-out-h">Dry run — nothing has been written.</p><ul class="echanges">${rows.join("")}</ul>`
}

function resultsHTML(results) {
  const rows = (results ?? []).map((r) =>
    `<li class="${r.ok ? "ok" : "dropped"}">${escapeHtml(r.id)} — ${
      r.ok ? "updated" : escapeHtml(r.error ?? "failed")
    }</li>`
  )
  return `<p class="emodal-out-h">Applied.</p><ul class="echanges">${rows.join("")}</ul>`
}

function autogrow(el) {
  el.style.height = "auto"
  el.style.height = `${el.scrollHeight + 2}px`
}

// A fresh element per open, so every listener from the previous edit goes away with the old node
// instead of having to be unwired by hand.
function freshDialog() {
  document.getElementById(DIALOG_ID)?.remove()
  const el = document.createElement("dialog")
  el.id = DIALOG_ID
  el.className = "emodal"
  el.setAttribute("aria-labelledby", "emodal-title")
  document.body.appendChild(el)
  return el
}

/**
 * Open the editor for one ticket. `returnFocus` is an element or a function returning one, focused
 * again when the modal closes — the Board re-renders on apply, so it passes a lookup rather than a
 * node. `onApplied(results)` fires once a write lands; the caller decides what to refresh.
 */
export function openEditModal(
  { dataFile, issue, mode = {}, onApplied, returnFocus, reviewItems, snapshot, source },
) {
  const options = fieldOptions(issue, snapshot)
  const dialog = freshDialog()
  dialog.innerHTML = modalHTML(issue, options, mode)

  const form = dialog.querySelector("form.editf")
  const control = (name) => form.elements.namedItem(name)
  const impactEl = dialog.querySelector(".emodal-impact")
  const outEl = dialog.querySelector(".emodal-out")
  const guardEl = dialog.querySelector(".emodal-guard")
  const textarea = control("description")
  const previewPane = dialog.querySelector(".emodal-md")
  const previewBtn = dialog.querySelector('[data-act="preview"]')
  const applyBtn = dialog.querySelector('[data-act="apply"]')
  const cancelBtn = dialog.querySelector('[data-act="cancel"]')
  const noUuid = !issue.linearId

  let previewed = false
  let dirty = false
  let phase = "open"
  let willApplyCount = 0

  const readValues = () => normalizeValues(Object.fromEntries(FIELD_NAMES.map((name) => [name, control(name).value])))

  function showErrors(errors) {
    for (const name of FIELD_NAMES) {
      const wrap = form.querySelector(`.efield[data-field="${name}"]`)
      if (!wrap) continue
      const err = wrap.querySelector(".efield-err")
      const message = errors[name]
      err.hidden = !message
      err.textContent = message ?? ""
      wrap.classList.toggle("invalid", Boolean(message))
      control(name).setAttribute("aria-invalid", String(Boolean(message)))
    }
  }

  function showOut(html) {
    outEl.hidden = false
    outEl.innerHTML = html
  }

  // Validation and the buttons follow the keystroke; the impact pane trails it. Every character typed
  // into the description would otherwise re-simulate the whole plan, which is the one recompute here
  // big enough to be felt in a textarea.
  let impactTimer = null
  function drawImpact(ctx, defer) {
    clearTimeout(impactTimer)
    if (!defer) return renderImpact(impactEl, ctx)
    impactTimer = setTimeout(() => renderImpact(impactEl, ctx), IMPACT_DEBOUNCE_MS)
  }

  function sync(defer = false) {
    const values = readValues()
    const { ok, errors } = validateEdit(values, options)
    const changed = changedFields(issue, values, options)
    const ops = opsForChanges(issue.id, changed)
    dirty = changed.length > 0
    showErrors(errors)
    previewBtn.disabled = !ok || changed.length === 0
    applyBtn.disabled = noUuid || !previewed || !ok || changed.length === 0 || willApplyCount === 0
    drawImpact({
      changed,
      dataFile,
      edit: pendingEdit(changed),
      errors,
      issue,
      ops,
      options,
      phase,
      reviewItems,
      snapshot,
      source,
      valid: ok,
      values,
    }, defer)
    return { changed, ok, ops }
  }

  function setDescriptionView(view) {
    const showPreview = view === "preview"
    textarea.hidden = showPreview
    previewPane.hidden = !showPreview
    if (showPreview) previewPane.innerHTML = renderMarkdown(textarea.value)
    for (const btn of dialog.querySelectorAll("[data-desc]")) {
      btn.setAttribute("aria-pressed", String((btn.dataset.desc === "preview") === showPreview))
    }
  }

  const onBeforeUnload = (e) => {
    if (!dirty) return
    e.preventDefault()
    e.returnValue = ""
  }

  function close() {
    globalThis.removeEventListener("beforeunload", onBeforeUnload)
    dialog.close()
  }

  function requestClose() {
    if (!dirty) return close()
    guardEl.hidden = false
    guardEl.querySelector('[data-act="keep"]').focus()
  }

  function reopenEditing() {
    previewed = false
    outEl.hidden = true
    phase = "editing"
    applyBtn.textContent = mode?.demo ? "Apply to demo workspace" : "Apply to live workspace"
  }

  form.addEventListener("input", () => {
    reopenEditing()
    autogrow(textarea)
    sync(true)
  })
  form.addEventListener("change", () => {
    reopenEditing()
    sync()
  })
  form.addEventListener("submit", (e) => e.preventDefault())

  for (const btn of dialog.querySelectorAll("[data-desc]")) {
    btn.onclick = () => setDescriptionView(btn.dataset.desc)
  }

  previewBtn.onclick = async () => {
    const { changed, ok, ops } = sync()
    if (!ok || !ops.length) return
    previewBtn.disabled = true
    try {
      const res = await postEdit(dataFile, ops, false)
      if (res.error) {
        showOut(`<p class="emodal-out-h">Error: ${escapeHtml(res.details ?? res.error)}</p>`)
        return
      }
      previewed = true
      willApplyCount = (res.willApply ?? []).length
      phase = "previewed"
      showOut(changeListHTML(issue.id, changed, res.skipped))
    } catch (err) {
      showError(err, "Previewing the edit failed")
    } finally {
      sync()
    }
  }

  applyBtn.onclick = async () => {
    const { ok, ops } = sync()
    if (!previewed || !ok || !ops.length) return
    applyBtn.disabled = true
    applyBtn.textContent = "Applying…"
    try {
      const res = await postEdit(dataFile, ops, true)
      if (res.error) {
        showOut(`<p class="emodal-out-h">Error: ${escapeHtml(res.details ?? res.error)}</p>`)
        applyBtn.textContent = mode?.demo ? "Apply to demo workspace" : "Apply to live workspace"
        applyBtn.disabled = false
        return
      }
      showOut(resultsHTML(res.results))
      const allOk = (res.results ?? []).length > 0 && res.results.every((r) => r.ok)
      applyBtn.textContent = allOk ? "Applied" : "Apply failed"
      if (!allOk) return
      // The applied values are the ticket's state now, so a further edit is measured against them and
      // can be previewed and applied again. Latching on `applied` would leave the fields editable with
      // no way to send them.
      Object.assign(issue, readValues())
      previewed = false
      dirty = false
      phase = "applied"
      cancelBtn.textContent = "Close"
      await onApplied?.(res.results)
      sync()
    } catch (err) {
      applyBtn.textContent = mode?.demo ? "Apply to demo workspace" : "Apply to live workspace"
      applyBtn.disabled = false
      showError(err, "Applying the edit failed")
    }
  }

  cancelBtn.onclick = requestClose
  dialog.querySelector('[data-act="close"]').onclick = requestClose
  guardEl.querySelector('[data-act="keep"]').onclick = () => {
    guardEl.hidden = true
    control("title").focus()
  }
  guardEl.querySelector('[data-act="discard"]').onclick = close
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault()
    requestClose()
  })
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) requestClose()
  })
  dialog.addEventListener("close", () => {
    const el = typeof returnFocus === "function" ? returnFocus() : returnFocus
    el?.focus?.()
  })

  globalThis.addEventListener("beforeunload", onBeforeUnload)
  dialog.showModal()
  autogrow(textarea)
  sync()
  return dialog
}
