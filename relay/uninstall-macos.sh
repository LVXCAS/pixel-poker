#!/usr/bin/env bash
# Stop and remove the PIXEL HOLD'EM relay LaunchAgent. Safe to run twice.
set -uo pipefail
LABEL="com.pixelpoker.relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "removed $LABEL. Relay stopped, will not start at login."
echo "(relay.json still points at the old URL; run start.sh with CLEAR_ON_EXIT=1 or edit it if needed.)"
