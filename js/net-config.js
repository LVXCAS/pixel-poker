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
    // Firebase relay (js/net-firebase.js). When set, it REPLACES the WebSocket relay above: nothing
    // to keep running. Paste the web-app config from the Firebase console (relay/FIREBASE.md):
    //   firebase: {
    //     apiKey: 'AIza...',
    //     authDomain: 'YOUR-PROJECT.firebaseapp.com',
    //     databaseURL: 'https://YOUR-PROJECT-default-rtdb.firebaseio.com',
    //     projectId: 'YOUR-PROJECT',
    //     appId: '1:1234567890:web:abc123',
    //   },
    // This config is public by design (it ships to every browser); database.rules.json is the lock.
    firebase: {
      apiKey: 'AIzaSyAzmENN-fbSMOIawIHPFLP3geTaijRcuM0',
      authDomain: 'pixel-holdem.firebaseapp.com',
      databaseURL: 'https://pixel-holdem-default-rtdb.firebaseio.com',
      projectId: 'pixel-holdem',
      appId: '1:1014570229813:web:ece601196b493a3258517c',
    },
  });
})();
