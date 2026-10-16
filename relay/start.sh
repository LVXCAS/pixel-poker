#!/usr/bin/env bash
# Start the PIXEL HOLD'EM relay + a Cloudflare quick tunnel, publish the tunnel URL to relay.json
# (repo root, served by GitHub Pages), and commit/push it when it changes. Ctrl-C stops everything.
set -euo pipefail

PORT="${PORT:-8787}"
RELAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$RELAY_DIR/.." && pwd)"
RELAY_JSON="$REPO_DIR/relay.json"
LOG_DIR="${TMPDIR:-/tmp}/pixel-poker-relay"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"
URL_WAIT_SECONDS=60
PUSH="${PUSH:-1}"   # PUSH=0 to only write relay.json

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # LaunchAgents start with a bare PATH
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }
[ -d "$RELAY_DIR/node_modules/ws" ] || (cd "$RELAY_DIR" && npm ci --omit=dev --no-audit --no-fund)

mkdir -p "$LOG_DIR"
: > "$TUNNEL_LOG"
SERVER_PID=""
TUNNEL_PID=""

cleanup() {
  trap - EXIT INT TERM
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

PORT="$PORT" node "$RELAY_DIR/server.js" &
SERVER_PID=$!

cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

HTTPS_URL=""
for _ in $(seq 1 "$URL_WAIT_SECONDS"); do
  HTTPS_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | grep -v '^https://api\.' | head -n1 || true)"
  [ -n "$HTTPS_URL" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { echo "cloudflared exited:" >&2; cat "$TUNNEL_LOG" >&2; exit 1; }
  sleep 1
done
[ -n "$HTTPS_URL" ] || { echo "no trycloudflare URL after ${URL_WAIT_SECONDS}s" >&2; exit 1; }

WSS_URL="wss://${HTTPS_URL#https://}"
echo "relay: $WSS_URL (local :$PORT)"

OLD_URL="$(sed -nE 's/.*"url" *: *"([^"]*)".*/\1/p' "$RELAY_JSON" 2>/dev/null || true)"
if [ "$OLD_URL" != "$WSS_URL" ]; then
  printf '{"url":"%s","updated":"%s"}\n' "$WSS_URL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RELAY_JSON"
  if [ "$PUSH" = "1" ]; then
    (
      cd "$REPO_DIR"
      git add relay.json
      git commit -m "chore: relay url" -- relay.json
      git push
    ) || echo "warning: could not commit/push relay.json (relay still running)" >&2
  fi
fi

# Exit (and let launchd restart us) if either child dies.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$TUNNEL_PID" 2>/dev/null; do
  sleep 5
done
echo "relay or tunnel stopped" >&2
exit 1
