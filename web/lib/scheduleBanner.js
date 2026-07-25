// A sibling of errorBanner.js for a failure nobody is watching: the scheduled snapshot run happens with no
// terminal open, so a Linear key that expired overnight would otherwise show up only as a board that
// quietly stopped gaining history. Every page loads this module (the shared layout pulls it in), asks
// the server how the schedule is doing, and shows one dismissible line when the last run failed or
// nothing has been captured for too long.
//
// The server decides what to say (src/schedule.ts); this only paints it. No schedule installed is the
// ordinary state and carries no message, so nothing renders unless someone opted in and it broke.

const DISMISS_KEY = "tlr.scheduleNoticeDismissed"

function bannerElement() {
  let el = document.getElementById("schedule-notice")
  if (el) return el
  el = document.createElement("div")
  el.id = "schedule-notice"
  el.className = "schedule-notice"
  el.setAttribute("role", "status")
  document.body.prepend(el)
  return el
}

// Dismissal is keyed to the run being complained about, so acknowledging tonight's failure does not
// also hide tomorrow's.
function noticeKey(health) {
  return `${health.state}:${health.lastRun?.finishedAt ?? ""}`
}

export function renderScheduleNotice(health) {
  if (!health?.message) return null
  const key = noticeKey(health)
  if (localStorage.getItem(DISMISS_KEY) === key) return null

  const el = bannerElement()
  el.textContent = ""
  const text = document.createElement("span")
  text.textContent = `⚠ ${health.message}`
  const dismiss = document.createElement("button")
  dismiss.type = "button"
  dismiss.className = "schedule-notice-dismiss"
  dismiss.setAttribute("aria-label", "Dismiss")
  dismiss.textContent = "✕"
  dismiss.onclick = () => {
    localStorage.setItem(DISMISS_KEY, key)
    el.remove()
  }
  el.append(text, dismiss)
  return el
}

export async function loadScheduleNotice() {
  const health = await fetch("/api/schedule/health", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return renderScheduleNotice(health)
}

await loadScheduleNotice()
