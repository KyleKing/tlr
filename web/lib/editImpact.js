// The edit modal's right-hand column: the consequence of the edit in progress. This is the mount
// point and the contract only — a later pass fills it with the ticket's snapshot diff on Review, the
// capacity and forecast shift as estimate, cycle, or assignee move, the ticket's blockers, and a live
// slop scan of the description. Until then it renders a quiet placeholder so the split layout is real
// and the call sites are already in place.
//
// renderImpact(el, ctx) is called once when the modal opens and again on every form change. It owns
// `el` outright and must stay pure of its own state: the same ctx has to produce the same pane.
//
// ctx:
//   issue     the ticket being edited, exactly as the page loaded it from the snapshot
//   values    every editable field's current form value, changed or not, already normalized
//             (assignee, cycle, description, estimate, milestone, priority, status, title)
//   edit      the pending edit as a field → new value map, holding only fields that differ from
//             the issue; empty when nothing has been touched
//   changed   the same edit written for a reader: [{ field, label, from, to, fromValue, toValue }]
//   ops       the /api/edit ops `changed` would send, so the pane can reason about the real write
//   snapshot  the whole project snapshot behind the page (project, asOf, cycles, milestones,
//             issues, capacity), the same object the board and Review pages render from
//   options   fieldOptions(issue, snapshot) — every allowed value for each field
//   valid     false while any field fails validation, in which case `ops` will not be sent
//   errors    field → one-sentence reason, for the fields that fail validation
//   source    "board" or "review", where the modal was opened from
//   dataFile  the snapshot's data file, the same one the write path posts
//   phase     "open" before anything is touched, "editing" once a field changes, "previewed" after a
//             successful dry run, "applied" after a write lands

export function renderImpact(el, ctx) {
  const n = ctx.changed.length
  const summary = n === 0
    ? "No changes yet."
    : `${n} field${n === 1 ? "" : "s"} pending: ${ctx.changed.map((c) => c.label.toLowerCase()).join(", ")}.`
  el.innerHTML = `<h3 class="eimpact-h">Impact</h3>` +
    `<p class="eimpact-line">${summary}</p>` +
    `<p class="eimpact-note">Capacity, forecast, blockers, and the slop scan land here next.</p>`
}
