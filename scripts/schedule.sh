#!/usr/bin/env bash
# Install, inspect, or remove the launchd LaunchAgent that runs `deno task snapshot` every three hours.
#
#   ./scripts/schedule.sh install            # 00:00, 03:00, 06:00 … 21:00
#   ./scripts/schedule.sh install --at 07:30 # same eight-a-day cadence, phased to 07:30
#   ./scripts/schedule.sh install --dry-run  # print the plist and the commands, change nothing
#   ./scripts/schedule.sh status
#   ./scripts/schedule.sh uninstall
#
# --at names one run of the day and the other seven follow every three hours from it, which is why only
# the hour's remainder mod 3 changes the result: --at 07:30 and --at 22:30 both give 01:30, 04:30, …
# 22:30. Eight StartCalendarInterval dicts in an array, not a StartInterval, because launchd fires a
# missed calendar interval when the machine wakes and coalesces several missed ones into a single run
# (`man launchd.plist`); an interval timer has no such catch-up and this schedule is built on it.
#
# A LaunchAgent inherits no shell PATH, so every path in the generated plist is absolute and resolved
# here, at install time, rather than committed. Re-running install is safe: it re-renders the plist and
# bootstraps the label again after booting out whatever was loaded.

set -euo pipefail

LABEL="me.kyleking.tlr.snapshot"
HOURS_APART=3
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${REPO}/scripts/launchagent.plist.template"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOGFILE="${REPO}/web/data/snapshot-launchd.log"
AGENT_PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
BLOCK_FILE=""

trap '[ -z "${BLOCK_FILE}" ] || rm -f "${BLOCK_FILE}"' EXIT

die() {
  echo "schedule: $*" >&2
  exit 1
}

run_hours() {
  local h
  for ((h = $1 % HOURS_APART; h < 24; h += HOURS_APART)); do
    echo "${h}"
  done
}

run_times() {
  local h sep="" out=""
  for h in $(run_hours "$1"); do
    out+="${sep}$(printf '%02d:%02d' "${h}" "$2")"
    sep=", "
  done
  echo "${out}"
}

calendar_intervals() {
  local h
  for h in $(run_hours "$1"); do
    printf '    <dict>\n'
    printf '      <key>Hour</key>\n      <integer>%d</integer>\n' "${h}"
    printf '      <key>Minute</key>\n      <integer>%d</integer>\n' "$2"
    printf '    </dict>\n'
  done
}

# The intervals go through a temp file rather than an awk -v value: the block is multi-line, and the awk
# that ships with macOS rejects a newline inside a -v assignment.
render() {
  local deno hour minute
  deno="$(command -v deno)" || die "deno is not on PATH"
  hour="$1"
  minute="$2"
  BLOCK_FILE="$(mktemp)"
  calendar_intervals "${hour}" "${minute}" >"${BLOCK_FILE}"
  sed \
    -e "s|__LABEL__|${LABEL}|g" \
    -e "s|__DENO__|${deno}|g" \
    -e "s|__REPO__|${REPO}|g" \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__PATH__|$(dirname "${deno}"):${AGENT_PATH}|g" \
    -e "s|__LOGFILE__|${LOGFILE}|g" \
    "${TEMPLATE}" |
    awk -v block="${BLOCK_FILE}" \
      '$0 ~ /__CALENDAR_INTERVALS__/ { while ((getline line < block) > 0) print line; next } { print }'
}

install_agent() {
  local at="09:00" dry_run=0 hour minute
  while [ $# -gt 0 ]; do
    case "$1" in
      --at)
        at="${2:-}"
        shift 2
        ;;
      --dry-run)
        dry_run=1
        shift
        ;;
      *) die "unknown option: $1" ;;
    esac
  done

  [ -f "${TEMPLATE}" ] || die "missing ${TEMPLATE}"
  [[ "${at}" =~ ^([0-9]{1,2}):([0-9]{2})$ ]] || die "--at wants HH:MM, got '${at}'"
  hour="$((10#${BASH_REMATCH[1]}))"
  minute="$((10#${BASH_REMATCH[2]}))"
  { [ "${hour}" -lt 24 ] && [ "${minute}" -lt 60 ]; } || die "--at is out of range: ${at}"

  if [ "${dry_run}" -eq 1 ]; then
    echo "schedule: would run every ${HOURS_APART}h at $(run_times "${hour}" "${minute}")"
    echo "schedule: would write ${PLIST}"
    echo "schedule: would run launchctl bootout gui/$(id -u)/${LABEL} (ignoring failure)"
    echo "schedule: would run launchctl bootstrap gui/$(id -u) ${PLIST}"
    echo "---"
    render "${hour}" "${minute}"
    return 0
  fi

  mkdir -p "${HOME}/Library/LaunchAgents" "${REPO}/web/data"
  render "${hour}" "${minute}" >"${PLIST}"
  plutil -lint "${PLIST}" >/dev/null || die "generated plist is malformed"
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "${PLIST}"
  echo "schedule: installed ${LABEL}, every ${HOURS_APART}h at $(run_times "${hour}" "${minute}")"
  echo "schedule: logs in ${LOGFILE}; run history in web/data/snapshot-runs.jsonl"
}

uninstall_agent() {
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST}"
  echo "schedule: removed ${LABEL}"
}

status_agent() {
  if [ ! -f "${PLIST}" ]; then
    echo "schedule: not installed (no ${PLIST})"
    return 0
  fi
  echo "schedule: plist at ${PLIST}"
  launchctl list | grep "${LABEL}" || echo "schedule: plist present but not loaded — run install again"
}

case "${1:-}" in
  install)
    shift
    install_agent "$@"
    ;;
  status) status_agent ;;
  uninstall) uninstall_agent ;;
  *)
    echo "usage: $0 {install [--at HH:MM] [--dry-run]|status|uninstall}" >&2
    echo "       --at names one run; the other seven follow every ${HOURS_APART} hours" >&2
    exit 2
    ;;
esac
