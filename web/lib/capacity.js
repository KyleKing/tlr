// Pure transforms that turn Incident.io on-call shifts and calendar out-of-office blocks into the
// capacity block the board reads. No network or file I/O lives here so the logic stays unit-testable;
// scripts/capacity.ts does the fetching, keychain access, and cpu.json writes.
//
// Dates are handled as UTC YYYY-MM-DD strings at day granularity. Event and cycle windows are
// half-open [start, end): the end day is not counted. The caller normalises timed and all-day
// events to that shape before calling in.

const OWNED = {
  "incident.io": { fields: ["oncall"], marker: "oncallSrc" },
  gcal: { fields: ["outDays", "reason"], marker: "outSrc" },
}

// Days from startISO (inclusive) up to endISO (exclusive), as YYYY-MM-DD strings.
export function eachDay(startISO, endISO) {
  const out = []
  const d = new Date(startISO + "T00:00:00Z")
  const end = new Date(endISO + "T00:00:00Z")
  while (d < end) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

function _isWeekday(iso) {
  const wd = new Date(iso + "T00:00:00Z").getUTCDay()
  return wd >= 1 && wd <= 5
}

// Count Mon–Fri days shared by [start, end) and [winStart, winEnd).
export function workdaysInWindow(start, end, winStart, winEnd) {
  const s = start > winStart ? start : winStart
  const e = end < winEnd ? end : winEnd
  if (e <= s) return 0
  return eachDay(s, e).filter(_isWeekday).length
}

// Does [start, end) share any day with [winStart, winEnd)? Weekends included, since on-call covers them.
function _overlapsDays(start, end, winStart, winEnd) {
  return start < winEnd && winStart < end
}

// Build a reverse lookup from a roster ({ "Display Name": { email } }) so an Incident.io or calendar
// identity (email, falling back to name) resolves to the display name the board keys people by.
function _resolver(roster) {
  const byEmail = {}
  const byName = {}
  for (const [name, info] of Object.entries(roster || {})) {
    byName[name.toLowerCase()] = name
    if (info && info.email) byEmail[info.email.toLowerCase()] = name
  }
  return (email, name) => {
    if (email && byEmail[email.toLowerCase()]) return byEmail[email.toLowerCase()]
    if (name && byName[name.toLowerCase()]) return byName[name.toLowerCase()]
    return name || email || null
  }
}

// Incident.io final schedule entries → { displayName: { cycleN: true } }. An entry marks on-call for
// any cycle whose window it touches. Entries for people outside the roster are dropped.
export function oncallByCycle(entries, cycles, roster) {
  const resolve = _resolver(roster)
  const known = new Set(Object.keys(roster || {}))
  const out = {}
  for (const e of entries) {
    const name = resolve(e.email, e.name)
    if (!name || (known.size && !known.has(name))) continue
    for (const c of cycles) {
      if (_overlapsDays(e.startDate, e.endDate, c.start, c.end)) {
        ;(out[name] ||= {})[c.n] = true
      }
    }
  }
  return out
}

// Calendar out-of-office / busy blocks → { displayName: { cycleN: { outDays, reason } } }. Per cycle,
// out-days sum across a person's events and cap at workdaysPerCycle; the first event's title is the
// reason. Events keyed by email or by display name both resolve through the roster.
export function outDaysByCycle(events, cycles, roster, workdaysPerCycle = 5) {
  const resolve = _resolver(roster)
  const out = {}
  for (const ev of events) {
    const name = resolve(ev.email, ev.name)
    if (!name) continue
    for (const c of cycles) {
      const days = workdaysInWindow(ev.startDate, ev.endDate, c.start, c.end)
      if (days <= 0) continue
      const slot = (out[name] ||= {})[c.n] ||= { outDays: 0, reason: ev.title || "out" }
      slot.outDays = Math.min(workdaysPerCycle, slot.outDays + days)
    }
  }
  return out
}

function _isEmptyEvent(ev) {
  return Object.keys(ev).filter((k) => k !== "oncallSrc" && k !== "outSrc").length === 0
}

// Merge freshly fetched data into the capacity block for one source. The source owns a fixed set of
// fields (on-call, or out-days+reason): it overwrites those where it has data, clears its own stale
// entries where it no longer does, and never touches fields owned by the other source or hand-entered
// values (which carry no source marker). Returns a new capacity object; the input is not mutated.
export function mergeCapacity(capacity, incoming, source) {
  const owned = OWNED[source]
  if (!owned) throw new Error(`unknown capacity source: ${source}`)
  const cap = structuredClone(capacity || {})
  cap.people ||= {}

  // Clear entries this source wrote on a prior run but no longer reports.
  for (const [name, person] of Object.entries(cap.people)) {
    for (const [cn, ev] of Object.entries(person.cycles || {})) {
      const stillReported = incoming[name] && incoming[name][cn]
      if (ev[owned.marker] === source && !stillReported) {
        for (const f of owned.fields) delete ev[f]
        delete ev[owned.marker]
      }
    }
  }

  // Apply incoming data, tagging it with the source marker.
  for (const [name, byCycle] of Object.entries(incoming)) {
    const person = (cap.people[name] ||= { cycles: {} })
    person.cycles ||= {}
    for (const [cn, val] of Object.entries(byCycle)) {
      const ev = (person.cycles[cn] ||= {})
      if (source === "incident.io") {
        ev.oncall = true
      } else {
        ev.outDays = val.outDays
        if (val.reason) ev.reason = val.reason
      }
      ev[owned.marker] = source
    }
  }

  // Drop events and people left empty after clearing.
  for (const [name, person] of Object.entries(cap.people)) {
    for (const [cn, ev] of Object.entries(person.cycles || {})) {
      if (_isEmptyEvent(ev)) delete person.cycles[cn]
    }
    if (Object.keys(person.cycles || {}).length === 0 && person.velocity == null) delete cap.people[name]
  }

  return cap
}
