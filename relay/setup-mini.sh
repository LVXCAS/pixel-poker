#!/usr/bin/env bash
# One-command PIXEL HOLD'EM relay setup for the Mac mini. Safe to re-run.
#   bash <(curl -fsSL https://raw.githubusercontent.com/LVXCAS/pixel-poker/main/relay/setup-mini.sh)
set -uo pipefail

REPO_SLUG="LVXCAS/pixel-poker"
DEST="$HOME/pixel-poker"
PORT="${PORT:-8787}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

step() { echo; echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

step "Checking Homebrew"
command -v brew >/dev/null || die "Homebrew missing. Install from https://brew.sh then re-run."
eval "$(brew shellenv)"

step "Checking tools (git, node, cloudflared, gh)"
for pair in git:git node:node cloudflared:cloudflared gh:gh; do
  cmd="${pair%%:*}"; pkg="${pair##*:}"
  if command -v "$cmd" >/dev/null; then echo "ok: $cmd"
  else echo "installing $pkg..."; brew install "$pkg" || die "brew install $pkg failed"; fi
done

step "Checking GitHub login"
if ! gh auth status >/dev/null 2>&1; then
  echo "Not logged in to GitHub."
  echo "Run:  gh auth login"
  echo "(pick GitHub.com, HTTPS, 'Login with a web browser'). Then re-run this script."
  exit 1
fi
gh auth setup-git >/dev/null 2>&1 || true
echo "ok: logged in"

step "Getting the code"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --rebase --autostash -q || die "git pull failed in $DEST"
  echo "updated $DEST"
else
  [ -e "$DEST" ] && die "$DEST exists but is not a git repo. Move it and re-run."
  gh repo clone "$REPO_SLUG" "$DEST" || die "clone failed"
  echo "cloned to $DEST"
fi

step "Installing relay deps"
(cd "$DEST/relay" && npm ci --omit=dev --no-audit --no-fund) || die "npm ci failed"

step "Installing the background service"
PORT="$PORT" bash "$DEST/relay/install-macos.sh" || die "install-macos.sh failed"

step "Waiting for the relay URL (up to 60s)"
URL=""
for _ in $(seq 1 60); do
  URL="$(sed -nE 's/.*"url" *: *"(wss:[^"]*)".*/\1/p' "$DEST/relay.json" 2>/dev/null | head -n1)"
  if [ -n "$URL" ]; then
    H="https://${URL#wss://}"
    [ "$(curl -fsS -m 5 "$H/health" 2>/dev/null)" = "ok" ] && break
  fi
  sleep 1
done

echo
if [ -n "$URL" ] && [ "$(curl -fsS -m 5 "https://${URL#wss://}/health" 2>/dev/null)" = "ok" ]; then
  echo "RELAY IS LIVE: $URL"
  echo "health: ok"
else
  echo "Not live yet. URL in relay.json: ${URL:-none}"
  echo "Check the log:  tail -f ~/Library/Logs/pixelpoker-relay.log"
fi
echo "Local check: curl http://localhost:$PORT/health"
echo "Reminder: only ONE relay at a time. Stop the laptop one."
