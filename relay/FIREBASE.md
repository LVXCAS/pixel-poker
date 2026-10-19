# Firebase relay setup (10 minutes, free, nothing to keep running)

This replaces the "leave a computer on + Cloudflare tunnel" relay. Once it's set up, the
**relay** connection option works on school Wi-Fi with no server of yours running.

You need a Google account. Everything below is on the free **Spark** plan; don't add a card.

1. Go to https://console.firebase.google.com and click **Create a project** (or **Add project**).
   Name it something like `pixel-holdem`. Google Analytics: turn it **off**. Click **Create**.
2. In the left menu: **Build -> Authentication -> Get started**. Open the **Sign-in method** tab,
   click **Anonymous**, switch it **on**, **Save**.
3. Left menu: **Build -> Realtime Database -> Create Database**. Location: **United States**.
   Pick **Start in locked mode**. Click **Enable**.
   (Make sure it's *Realtime Database*, not *Firestore*.)
4. Still in Realtime Database, open the **Rules** tab. Delete everything in the box, paste the
   whole contents of `database.rules.json` (repo root), click **Publish**.
5. Click the gear next to **Project Overview -> Project settings**. Under **Your apps**, click the
   **web** icon (`</>`). Nickname: `pixel-holdem`. Leave "Firebase Hosting" unchecked.
   Click **Register app**.
6. It shows a `firebaseConfig = { ... }` block. Copy it and send it to Claude. It looks like:

   ```js
   apiKey: "AIza...",
   authDomain: "pixel-holdem-xxxx.firebaseapp.com",
   databaseURL: "https://pixel-holdem-xxxx-default-rtdb.firebaseio.com",
   projectId: "pixel-holdem-xxxx",
   storageBucket: "...",          // not needed
   messagingSenderId: "...",      // not needed
   appId: "1:1234567890:web:abc123"
   ```

   If `databaseURL` is missing, copy the URL shown at the top of the Realtime Database **Data** tab
   (it ends in `firebaseio.com` or `firebasedatabase.app`) and send that too.

That's it. This config is **not a secret**: it ships to every browser that opens the game. What
keeps the game safe is the rules from step 4 (each player can only read their own cards).

Optional, recommended: **Authentication -> Settings -> Authorized domains** — make sure
`lvxcas.github.io` is listed (add it if not), so sign-in works from the live site.

If you ever change `database.rules.json`, repeat step 4.
