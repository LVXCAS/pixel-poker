# 00 — Brief: PIXEL HOLD'EM visual redesign

**What:** Browser-based single-player No-Limit Texas Hold'em *trainer* — retro pixel art. Hero vs 1–8 bots (rated 1★ Fish … 5★ Shark). Screens: Title, Setup, Table (with live Coach panel: equity, pot odds, outs, made hand, recommendation + reasons; action log), Hand Review modal (grades + every bot's revealed hand + reasoning), Drills, Stats, upcoming Tutorial.

**Who:** One specific player — a 16-year-old self-taught builder who loves Balatro, plays on a MacBook (1440×900, min 1024 wide), wants to actually get better at reading hands and making +EV decisions. Impatient with fluff, notices "AI-looking" design instantly.

**Single emotion:** **Tense.** The table should feel like real money is on it — a back-room game at 2am — while the coach is the calm voice in your ear.

**Medium constraints:** Plain HTML/CSS/JS + `<canvas>`, no build step, must run from file://. DOM UI over a canvas background. Numbers (stack, pot, to-call, equity vs needed) must be readable at a glance — this is a teaching tool, legibility of the decision is the product. 60fps on a laptop; honor prefers-reduced-motion.

**Anti-goals (must NOT resemble):**
1. Generic AI/shadcn dashboard — slate rounded panels, tiny tracked-caps labels (the current build).
2. Zynga Poker / WSOP mobile — gold-gradient casino glitz, slot-machine chrome.
3. A literal Balatro clone — Balatro is the bar for *craft*, not a template to trace.

**Where it lives:** /Users/lvxcas/pixel-poker. Visual layer only: css/style.css + rendering code in js/ui.js (+ canvas background). Game logic/contract is fixed (see CONTRACT.md). Current screenshots: /Users/lvxcas/pixel-poker/screenshots/*.png.

**Diagnosed tells in current build:** generic rounded slate dashboard panels everywhere; too much tiny tracked-uppercase pixel text with no hierarchy; flat CSS oval felt with no material/lighting; noisy red/teal swirl background fighting the table; no hand-made feel; coach panel reads like a SaaS sidebar.
