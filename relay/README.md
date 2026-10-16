# PIXEL HOLD'EM relay

WebSocket fallback for networks that block peer-to-peer (school Wi-Fi). Needs Node 18+ and `brew install cloudflared`.

1. `cd relay && npm ci` (once)
2. `./start.sh` — starts the relay + a Cloudflare tunnel, writes `../relay.json` with the new `wss://…trycloudflare.com` URL, and commits/pushes it if it changed (`PUSH=0 ./start.sh` to skip git). Keep it running while people play.
3. On an always-on Mac: `./install-macos.sh` installs a login LaunchAgent (`com.pixelpoker.relay`) that keeps `start.sh` running.

Protocol, limits and close codes are documented at the top of `server.js`. Tests: `node tests/relay-server.js` from the repo root.
