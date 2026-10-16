/* Relay settings (TURN and the WebSocket relay) for strict networks such as school Wi-Fi.
 * Direct peer-to-peer is tried first; the relay is only used when it fails.
 * turnUrl: a Metered.ca credentials endpoint, e.g.
 *   https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_KEY
 * Metered's API key is designed to live in front-end code: it can only mint
 * short-lived relay credentials, and usage is capped by the plan. */
(function () {
  'use strict';
  const PP = globalThis.PP;
  if (!PP || !PP.Net) return;
  PP.Net.config = Object.freeze({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    turnUrl: null,
    // WebSocket relay (relay/server.js) used when WebRTC is blocked. relay/start.sh keeps
    // relay.json at the site root pointing at the current tunnel URL.
    relayJsonUrl: 'relay.json',
    relayUrl: null,
  });
})();
