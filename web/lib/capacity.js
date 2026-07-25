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
  const d = new Date(`${startISO}T00:00:00Z`)
  const end = new Date(`${endISO}T00:00:00Z`)
  while (d < end) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

function _isWeekday(iso) {
  const wd = new Date(`${iso}T00:00:00Z`).getUTCDay()
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
    if (info?.email) byEmail[info.email.toLowerCase()] = name
  }
  return (email, name) => {
    if (email && byEmail[email.toLowerCase()]) return byEmail[email.toLowerCase()]
    if (name && byName[name.toLowerCase()]) return byName[name.toLowerCase()]
    return name || email || null
  }
}

// Who Incident.io reports on call in these cycles that the roster does not track. oncallByCycle drops
// them, and a dropped person's on-call week never deflates their capacity, so the board quietly plans
// as though they were free. Reporting the names turns that into a one-line fix (add them under
// Settings → Roster) instead of a number nobody can explain.
export function unrosteredOncall(entries, cycles, roster) {
  const known = new Set(Object.keys(roster || {}))
  if (!known.size) return []
  const resolve = _resolver(roster)
  const missing = new Set()
  for (const e of entries) {
    if (!cycles.some((c) => _overlapsDays(e.startDate, e.endDate, c.start, c.end))) continue
    const name = resolve(e.email, e.name)
    if (!name || !known.has(name)) missing.add(name || e.email || "unknown")
  }
  return [...missing].sort()
}

// Incident.io final schedule entries → { displayName: { cycleN: true } }. An entry marks on-call for
// any cycle whose window it touches. Entries for people outside the roster are dropped; call
// unrosteredOncall to find out who.
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
export function outDaysByCycle(events, cycles, roster, workdaysPerCycle = 10) {
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

// Split a [startISO, endISO) datetime interval into per-UTC-day busy milliseconds.
function _splitByDay(startISO, endISO) {
  const out = []
  let cur = new Date(startISO)
  const end = new Date(endISO)
  while (cur < end) {
    const dayStart = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate()))
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000)
    const segEnd = end < dayEnd ? end : dayEnd
    out.push([dayStart.toISOString().slice(0, 10), segEnd - cur])
    cur = dayEnd
  }
  return out
}

// Google freeBusy calendars ({ email: { busy: [{ start, end }] } }, ISO datetimes) → out-days by
// cycle. Free/busy carries no event type, so a day counts as reduced-capacity once its total busy
// time reaches thresholdHours — an all-day block clears this on its own, and several meetings can add
// up to the same signal. Weekend busy time is ignored since it never eats into workdays.
export function outDaysFromFreeBusy(calendars, cycles, roster, workdaysPerCycle = 10, thresholdHours = 5) {
  const resolve = _resolver(roster)
  const out = {}
  for (const [email, cal] of Object.entries(calendars || {})) {
    const name = resolve(email, null)
    if (!name) continue
    const hoursByDay = {}
    for (const b of cal.busy || []) {
      for (const [day, ms] of _splitByDay(b.start, b.end)) {
        hoursByDay[day] = (hoursByDay[day] || 0) + ms / 3600000
      }
    }
    const busyDays = Object.keys(hoursByDay).filter((d) => hoursByDay[d] >= thresholdHours && _isWeekday(d)).sort()
    for (const c of cycles) {
      const days = busyDays.filter((d) => d >= c.start && d < c.end).length
      if (days <= 0) continue
      const slot = (out[name] ||= {})[c.n] ||= { outDays: 0, reason: "busy" }
      slot.outDays = Math.min(workdaysPerCycle, slot.outDays + days)
    }
  }
  return out
}

// Completed issues in past cycles → { displayName: { velocity, cycles } }, a full-week rate and the
// number of cycles it rests on. Only cycles strictly before currentCycle count as history, and a
// person with no measurable cycle is omitted so the caller's default velocity applies instead of a
// false zero.
//
// A cycle counts only when the person worked it and delivered something. Two exclusions: a cycle they
// were out for every workday, and a cycle they completed nothing in. Averaging over every past cycle
// instead read leave as throughput of zero, so someone back from months away measured near-nothing and
// dragged every forecast and chain estimate they touched down with them.
//
// A partly-out cycle scales back up to a full week: 3 points delivered across 3 of 5 workdays reads as
// 5. `velocity` is the undeflated base that personCycleCapacity deflates again per cycle, so measuring
// it has to undo the same deflation. On-call is deliberately not inverted. The 45% penalty is a
// planning assumption rather than an observation, and dividing real throughput by it turns a
// productive on-call week into a clear-week rate nobody has ever hit.
//
// Skipping zero-delivery cycles biases the number up for anyone who moves in and out of the project.
// That is the intended reading: a zero cycle almost always means the person was working elsewhere,
// not that they worked here and shipped nothing. `cycles` is returned so a caller can say how thin the
// sample is, because a velocity drawn from one cycle deserves less trust than one drawn from eight.
//
// Archived tickets count here, unlike everywhere else that reads the issue list. This measures work
// already delivered, and a team that tidies its board by archiving finished tickets would otherwise
// watch its own recorded throughput fall as a result.
export function velocityByPerson(issues, cycles, currentCycle, capacity, workdaysPerCycle = 10) {
  const past = cycles.filter((c) => c.n < currentCycle)
  if (!past.length) return {}
  const delivered = {}
  for (const i of issues) {
    if (i.statusType !== "completed") continue
    if (!i.assignee || i.assignee === "Unassigned") continue
    if (!past.some((c) => c.n === i.cycle)) continue
    const byCycle = (delivered[i.assignee] ||= {})
    byCycle[i.cycle] = (byCycle[i.cycle] || 0) + (i.estimate || 0)
  }
  const out = {}
  for (const [name, byCycle] of Object.entries(delivered)) {
    const rates = []
    for (const c of past) {
      const points = byCycle[c.n] || 0
      if (points <= 0) continue
      const outDays = capacity?.people?.[name]?.cycles?.[String(c.n)]?.outDays || 0
      const worked = Math.max(0, workdaysPerCycle - outDays) / workdaysPerCycle
      if (worked <= 0) continue
      rates.push(points / worked)
    }
    if (!rates.length) continue
    out[name] = {
      velocity: Math.round(rates.reduce((sum, r) => sum + r, 0) / rates.length),
      cycles: rates.length,
    }
  }
  return out
}

// Merge computed base velocities into the capacity block. Velocity is a per-person value, not a
// per-cycle event, so it gets its own small merge instead of going through mergeCapacity. A hand-typed
// value (no velocitySrc marker) is protected by default; history only refreshes a value it wrote
// itself on an earlier run, or fills a person with no velocity at all. `locked: true` is an explicit
// escape hatch that blocks history even from refreshing its own prior write, for the rare case a
// person's throughput is hand-confirmed and should stop drifting.
export function mergeVelocity(capacity, velocityByName) {
  const cap = structuredClone(capacity || {})
  cap.people ||= {}

  for (const [name, person] of Object.entries(cap.people)) {
    if (person.locked) continue
    if (person.velocitySrc === "history" && velocityByName[name] == null) {
      delete person.velocity
      delete person.velocitySrc
      delete person.velocityCycles
    }
  }

  for (const [name, v] of Object.entries(velocityByName)) {
    const person = (cap.people[name] ||= { cycles: {} })
    if (person.locked) continue
    if (person.velocity != null && person.velocitySrc !== "history") continue // hand-typed, protected by default
    person.velocity = v.velocity
    person.velocitySrc = "history"
    // How many cycles the figure averages, so a one-cycle reading is visibly thin rather than silent.
    person.velocityCycles = v.cycles
  }

  for (const [name, person] of Object.entries(cap.people)) {
    if (Object.keys(person.cycles || {}).length === 0 && person.velocity == null) delete cap.people[name]
  }

  return cap
}

function _isEmptyEvent(ev) {
  return Object.keys(ev).filter((k) => k !== "oncallSrc" && k !== "outSrc" && k !== "locked").length === 0
}

// Merge freshly fetched data into the capacity block for one source. The source owns a fixed set of
// fields (on-call, or out-days+reason) and never touches fields owned by the other source. A hand-typed
// value in its own fields (no source marker) is protected by default; the source only refreshes a
// person+cycle it wrote itself on an earlier run, or fills one that had nothing at all. It still clears
// its own stale entries where it no longer reports. `locked: true` on an entry blocks this source even
// from refreshing its own prior write or clearing it, for a hand-confirmed value that should stop
// drifting (e.g. a known onsite the automated heuristic can't detect). Returns a new capacity object;
// the input is not mutated.
export function mergeCapacity(capacity, incoming, source) {
  const owned = OWNED[source]
  if (!owned) throw new Error(`unknown capacity source: ${source}`)
  const cap = structuredClone(capacity || {})
  cap.people ||= {}

  // Clear entries this source wrote on a prior run but no longer reports.
  for (const [name, person] of Object.entries(cap.people)) {
    for (const [cn, ev] of Object.entries(person.cycles || {})) {
      if (ev.locked) continue
      const stillReported = incoming[name]?.[cn]
      if (ev[owned.marker] === source && !stillReported) {
        for (const f of owned.fields) delete ev[f]
        delete ev[owned.marker]
      }
    }
  }

  // Apply incoming data, tagging it with the source marker. A hand-typed value (no marker for this
  // source) is left alone; only an empty slot or one this source already owns gets written.
  for (const [name, byCycle] of Object.entries(incoming)) {
    const person = (cap.people[name] ||= { cycles: {} })
    person.cycles ||= {}
    for (const [cn, val] of Object.entries(byCycle)) {
      const ev = (person.cycles[cn] ||= {})
      if (ev.locked) continue
      const handTyped = owned.fields.some((f) => ev[f] != null) && ev[owned.marker] !== source
      if (handTyped) continue
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
