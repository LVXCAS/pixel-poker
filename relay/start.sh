#!/usr/bin/env bash
# PIXEL HOLD'EM relay launcher: node relay + Cloudflare quick tunnel + watchdog.
# Publishes the tunnel URL to relay.json (repo root, served by GitHub Pages) and commits/pushes it.
#
# Env: PORT=8787  PUSH=1 (0 = only write the file)  CLEAR_ON_EXIT=0 (1 = publish {"url":null} on SIGINT/SIGTERM)
#      RELAY_JSON=<path> (override output file)  CHECK_INTERVAL=30  FAIL_LIMIT=3  MIN_PUSH_GAP=120
# Run only ONE relay at a time (laptop OR mini): two would fight over relay.json.
set -uo pipefail

PORT="${PORT:-8787}"
RELAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$RELAY_DIR/.." && pwd)"
RELAY_JSON="${RELAY_JSON:-$REPO_DIR/relay.json}"
LOG_DIR="${TMPDIR:-/tmp}/pixel-poker-relay-$PORT"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"
PUSH="${PUSH:-1}"
CLEAR_ON_EXIT="${CLEAR_ON_EXIT:-0}"
CHECK_INTERVAL="${CHECK_INTERVAL:-30}"
FAIL_LIMIT="${FAIL_LIMIT:-3}"
MIN_PUSH_GAP="${MIN_PUSH_GAP:-120}"
URL_WAIT_SECONDS=60
HEALTH_WAIT_SECONDS=45
MAX_BACKOFF=300
INTERNET_PROBE="https://www.cloudflare.com/cdn-cgi/trace"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # LaunchAgents start with a bare PATH
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl not found" >&2; exit 1; }
[ -d "$RELAY_DIR/node_modules/ws" ] || (cd "$RELAY_DIR" && npm ci --omit=dev --no-audit --no-fund) || exit 1

mkdir -p "$LOG_DIR"
SERVER_PID=""
TUNNEL_PID=""
HTTPS_URL=""
WSS_URL=""
PUBLISHED_URL=""     # last url successfully pushed (or written, when PUSH=0)
LAST_PUSH_TRY=0
SLEEP_PID=""

log() { echo "[$(date '+%H:%M:%S')] $*"; }
now() { date +%s; }

kill_hard() {  # kill_hard PID  (SIGKILL also works on a SIGSTOPped process)
  [ -n "${1:-}" ] || return 0
  kill "$1" 2>/dev/null || true
  sleep 0.3
  kill -9 "$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
}

json_url() { sed -nE 's/.*"url" *: *"([^"]*)".*/\1/p' "$RELAY_JSON" 2>/dev/null | head -n1; }

write_json() {  # write_json URL_OR_EMPTY
  local tmp="$RELAY_JSON.tmp.$$" ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -n "$1" ]; then printf '{"url":"%s","updated":"%s"}\n' "$1" "$ts" > "$tmp"
  else printf '{"url":null,"updated":"%s"}\n' "$ts" > "$tmp"; fi
  mv "$tmp" "$RELAY_JSON"
}

# Publish URL ("" = clear). Returns 0 when relay.json is in the desired state and pushed.
publish() {
  local want="$1"
  if [ "$PUSH" != "1" ]; then
    [ "$(json_url)" = "$want" ] || write_json "$want"
    return 0
  fi
  (
    cd "$REPO_DIR" || exit 1
    rel="$(git ls-files --full-name -- "$RELAY_JSON" 2>/dev/null | head -n1)"; rel="${rel:-relay.json}"
    git checkout -- "$rel" 2>/dev/null || true                 # drop stale local edit so the pull can't conflict
    if ! git pull --rebase --autostash -q >/dev/null 2>&1; then
      git rebase --abort >/dev/null 2>&1 || true
      echo "pull failed (offline?)" >&2; exit 1
    fi
    [ "$(json_url)" = "$want" ] || write_json "$want"
    git add -- "$rel"
    if ! git diff --cached --quiet -- "$rel"; then
      git commit -q -m "chore: relay url" -- "$rel" || exit 1
    fi
    git push -q
  )
}

# Try to publish now if allowed by the 2-minute gap. Sets PUBLISHED_URL on success.
maybe_publish() {
  local want="$1" t
  [ "$want" != "$PUBLISHED_URL" ] || [ "$PENDING" = "1" ] || return 0
  t="$(now)"
  if [ "$PUSH" = "1" ] && [ $((t - LAST_PUSH_TRY)) -lt "$MIN_PUSH_GAP" ]; then return 0; fi
  LAST_PUSH_TRY="$t"
  if publish "$want"; then
    PUBLISHED_URL="$want"; PENDING=0; log "published relay.json: ${want:-null}"
  else
    PENDING=1; log "warning: could not publish relay.json, will retry (relay still running)"
  fi
}
PENDING=0

start_server() {
  [ -n "$SERVER_PID" ] && kill_hard "$SERVER_PID"
  PORT="$PORT" node "$RELAY_DIR/server.js" &
  SERVER_PID=$!
}

local_ok() { [ "$(curl -fsS -m 5 "http://localhost:$PORT/health" 2>/dev/null)" = "ok" ]; }
# Falls back to DNS-over-HTTPS because some local resolvers (VPN/MagicDNS) can't resolve fresh trycloudflare names.
tunnel_ok() {
  [ "$(curl -fsS -m 10 "$HTTPS_URL/health" 2>/dev/null)" = "ok" ] && return 0
  [ "$(curl -fsS -m 10 --doh-url https://cloudflare-dns.com/dns-query "$HTTPS_URL/health" 2>/dev/null)" = "ok" ]
}
internet_ok() { curl -fsS -m 5 -o /dev/null "$INTERNET_PROBE" 2>/dev/null; }

# Start a fresh quick tunnel; sets HTTPS_URL/WSS_URL. Returns 1 on failure (tunnel killed).
start_tunnel() {
  [ -n "$TUNNEL_PID" ] && kill_hard "$TUNNEL_PID"
  TUNNEL_PID=""; HTTPS_URL=""
  : > "$TUNNEL_LOG"
  cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  local i url=""
  for i in $(seq 1 "$URL_WAIT_SECONDS"); do
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | grep -v '^https://api\.' | head -n1 || true)"
    [ -n "$url" ] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || { log "cloudflared exited early"; TUNNEL_PID=""; return 1; }
    sleep 1
  done
  if [ -z "$url" ]; then log "no trycloudflare URL after ${URL_WAIT_SECONDS}s"; kill_hard "$TUNNEL_PID"; TUNNEL_PID=""; return 1; fi
  HTTPS_URL="$url"
  for i in $(seq 1 $((HEALTH_WAIT_SECONDS / 2))); do   # new hostnames take a few seconds to resolve
    tunnel_ok && { WSS_URL="wss://${HTTPS_URL#https://}"; log "tunnel up: $WSS_URL (local :$PORT)"; return 0; }
    sleep 2
  done
  log "new tunnel $HTTPS_URL never answered /health"
  kill_hard "$TUNNEL_PID"; TUNNEL_PID=""; HTTPS_URL=""
  return 1
}

cleanup() {
  trap - EXIT INT TERM
  [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
  if [ "$CLEAR_ON_EXIT" = "1" ]; then
    log "clearing relay.json (CLEAR_ON_EXIT=1)"
    publish "" || log "warning: could not clear relay.json"
  fi
  [ -n "$TUNNEL_PID" ] && kill_hard "$TUNNEL_PID"
  [ -n "$SERVER_PID" ] && kill_hard "$SERVER_PID"
  exit 0
}
trap cleanup EXIT INT TERM

nap() { sleep "$1" & SLEEP_PID=$!; wait "$SLEEP_PID" 2>/dev/null; SLEEP_PID=""; }

start_server
sleep 1

FAILS=0
BACKOFF="$CHECK_INTERVAL"
while true; do
  # 1. Local server: restart node if it died or stopped answering.
  if ! kill -0 "$SERVER_PID" 2>/dev/null || ! local_ok; then
    log "local server unhealthy, restarting node"
    start_server; sleep 1
  fi

  # 2. Tunnel: need one, and it must answer.
  need_tunnel=0
  if [ -z "$TUNNEL_PID" ] || ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    [ -n "$TUNNEL_PID" ] && log "cloudflared died"
    TUNNEL_PID=""; need_tunnel=1
  elif tunnel_ok; then
    FAILS=0; BACKOFF="$CHECK_INTERVAL"
  elif ! internet_ok; then
    BACKOFF=$((BACKOFF * 2)); [ "$BACKOFF" -gt "$MAX_BACKOFF" ] && BACKOFF="$MAX_BACKOFF"
    log "no internet, waiting (${BACKOFF}s)"
  else
    FAILS=$((FAILS + 1)); log "tunnel health failed ($FAILS/$FAIL_LIMIT)"
    [ "$FAILS" -ge "$FAIL_LIMIT" ] && need_tunnel=1
  fi

  if [ "$need_tunnel" = "1" ]; then
    if ! internet_ok; then
      BACKOFF=$((BACKOFF * 2)); [ "$BACKOFF" -gt "$MAX_BACKOFF" ] && BACKOFF="$MAX_BACKOFF"
      log "tunnel needs restart but no internet (${BACKOFF}s)"
    elif start_tunnel; then
      FAILS=0; BACKOFF="$CHECK_INTERVAL"
    else
      BACKOFF=$((BACKOFF * 2)); [ "$BACKOFF" -gt "$MAX_BACKOFF" ] && BACKOFF="$MAX_BACKOFF"
      log "tunnel start failed, retrying in ${BACKOFF}s"
    fi
  fi

  # 3. Publish when the live URL differs from the published one, or a push is pending.
  [ -n "$HTTPS_URL" ] && maybe_publish "$WSS_URL"

  nap "$BACKOFF"
done
