#!/usr/bin/env bash
# Install a per-user LaunchAgent (com.pixelpoker.relay) that runs relay/start.sh at login and
# restarts it if it exits. Logs: ~/Library/Logs/pixelpoker-relay.log
# Uninstall: launchctl bootout gui/$(id -u)/com.pixelpoker.relay && rm ~/Library/LaunchAgents/com.pixelpoker.relay.plist
set -euo pipefail

LABEL="com.pixelpoker.relay"
RELAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/pixelpoker-relay.log"
PORT="${PORT:-8787}"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
chmod +x "$RELAY_DIR/start.sh"
(cd "$RELAY_DIR" && npm ci --omit=dev --no-audit --no-fund)

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$RELAY_DIR/start.sh</string></array>
  <key>WorkingDirectory</key><string>$RELAY_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL -> $PLIST (log: $LOG)"
