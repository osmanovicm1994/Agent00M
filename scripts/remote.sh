#!/usr/bin/env bash
# Remote access helper for the agent dashboard (Tailscale Serve). See docs/REMOTE.md.
#   npm run remote:on       publish the local dashboard to YOUR tailnet only (HTTPS, private)
#   npm run remote:status   show Tailscale and Serve status
#   npm run remote:off      remove all Tailscale Serve mappings on this machine
# Never uses Tailscale Funnel: Funnel would publish the dashboard to the whole internet.
set -euo pipefail

WEB_PORT="${AGENT_UI_WEB_PORT:-5173}"

find_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return 0
  fi
  local candidate="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  if [ -x "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  return 1
}

TS="$(find_tailscale)" || {
  echo "Tailscale CLI not found. Install Tailscale (https://tailscale.com/download), sign in, then try again." >&2
  exit 1
}

case "${1:-}" in
  on)
    "$TS" serve --bg "http://127.0.0.1:${WEB_PORT}"
    echo
    "$TS" serve status
    echo
    echo "Start the agent with: npm run chat:ui:remote   (it prints the https://...ts.net/?token=... URL)"
    ;;
  off)
    "$TS" serve reset
    echo "Tailscale Serve mappings removed. The dashboard is no longer reachable through your tailnet."
    ;;
  status)
    "$TS" status || true
    echo
    "$TS" serve status || true
    ;;
  *)
    echo "Usage: bash scripts/remote.sh on|off|status" >&2
    exit 1
    ;;
esac
