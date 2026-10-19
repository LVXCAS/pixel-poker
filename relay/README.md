# PIXEL HOLD'EM relay

WebSocket fallback for networks that block peer-to-peer (school Wi-Fi). Node 18+ and `cloudflared`.

## Mac mini: one command

Run this ON the mini (it installs git/node/cloudflared/gh, clones the repo, starts the relay at login):

```
bash <(curl -fsSL https://raw.githubusercontent.com/LVXCAS/pixel-poker/main/relay/setup-mini.sh)
```

If it says you are not logged in, run `gh auth login`, then run the command again (safe to repeat).

## Windows laptop: one command

Open PowerShell and run (installs Git, Node, cloudflared, gh with winget; clones to `~\pixel-poker`; starts the relay now and at every logon):

```
irm https://raw.githubusercontent.com/LVXCAS/pixel-poker/main/relay/setup-windows.ps1 | iex
```

If it says GitHub is not logged in, run `gh auth login`, then run the command again. A "PIXEL HOLD'EM relay" window stays open while it runs; closing it stops the relay. The laptop must stay awake (Settings → System → Power → never sleep when plugged in). Remove the logon task: `Unregister-ScheduledTask PixelPokerRelay`. Manual start: double-click `relay\start-windows.cmd`.

## Only run ONE relay at a time

Laptop OR mini, never both. Both would fight over `relay.json`. Stop the other one first.

## What it does

`start.sh` runs `server.js` + a Cloudflare quick tunnel, writes the `wss://…trycloudflare.com` URL to `../relay.json`, and commits/pushes it (GitHub Pages serves it to the game). A watchdog checks every 30s:

- tunnel `/health` fails 3 times in a row (or cloudflared died) -> new tunnel, new URL, push
- local server fails -> node restarted
- no internet -> backs off (up to 5 min), no push spam (max one push per 2 min); failed pushes retry on the next loop

Options (env): `PUSH=0` (don't touch git), `CLEAR_ON_EXIT=1` (on Ctrl-C/stop publish `{"url":null}` so clients skip the relay), `PORT=8787`, `RELAY_JSON=/path` (write somewhere else), `CHECK_INTERVAL=30`.

Manual run (e.g. on the laptop): `cd relay && npm ci && ./start.sh`.

## Status, logs, stop

```
launchctl list | grep pixelpoker          # running? (PID in first column)
tail -f ~/Library/Logs/pixelpoker-relay.log
curl http://localhost:8787/health         # "ok"
cat ~/pixel-poker/relay.json              # published URL
./uninstall-macos.sh                      # stop + remove from login
```

Restart: `launchctl kickstart -k gui/$(id -u)/com.pixelpoker.relay`.

Protocol, limits and close codes are documented at the top of `server.js`. Tests: `node tests/relay-server.js` from the repo root.
