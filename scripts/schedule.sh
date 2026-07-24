#!/usr/bin/env bash
# Install, inspect, or remove the launchd LaunchAgent that runs `deno task snapshot` once a day.
#
#   ./scripts/schedule.sh install            # daily at 09:00
#   ./scripts/schedule.sh install --at 07:30
#   ./scripts/schedule.sh install --dry-run  # print the plist and the commands, change nothing
#   ./scripts/schedule.sh status
#   ./scripts/schedule.sh uninstall
#
# A LaunchAgent inherits no shell PATH, so every path in the generated plist is absolute and resolved
# here, at install time, rather than committed. Re-running install is safe: it re-renders the plist and
# bootstraps the label again after booting out whatever was loaded.

set -euo pipefail

LABEL="me.kyleking.tlr.snapshot"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${REPO}/scripts/launchagent.plist.template"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOGFILE="${REPO}/web/data/snapshot-launchd.log"
AGENT_PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

die() {
  echo "schedule: $*" >&2
  exit 1
}

render() {
  local deno hour minute
  deno="$(command -v deno)" || die "deno is not on PATH"
  hour="$1"
  minute="$2"
  sed \
    -e "s|__LABEL__|${LABEL}|g" \
    -e "s|__DENO__|${deno}|g" \
    -e "s|__REPO__|${REPO}|g" \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__PATH__|$(dirname "${deno}"):${AGENT_PATH}|g" \
    -e "s|__HOUR__|${hour}|g" \
    -e "s|__MINUTE__|${minute}|g" \
    -e "s|__LOGFILE__|${LOGFILE}|g" \
    "${TEMPLATE}"
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
  echo "schedule: installed ${LABEL}, daily at ${at}"
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
    exit 2
    ;;
esac
