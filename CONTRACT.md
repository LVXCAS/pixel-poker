# PIXEL HOLD'EM — Module Contract (source of truth for all agents)

Retro pixel-art No-Limit Texas Hold'em trainer. Hero vs 1–8 bots with selectable skill rating.
Visual reference: **Balatro** (chunky pixel font, swirling animated felt-green/teal background,
CRT scanlines + vignette, bold drop-shadowed pixel UI, red/blue/orange chunky buttons, cards that wobble on hover).
Purpose: help the user get better at poker — reading hands, equity, pot odds, decisions.

## Hard constraints
- **No build step.** Plain HTML/CSS/JS. Must work by double-clicking `index.html` (file://) AND via a static server.
  → Use **classic `<script>` tags, NOT ES modules**. Every JS file is an IIFE that attaches to a global namespace:
  ```js
  (function () {
    const PP = (globalThis.PP = globalThis.PP || {});
    // ... PP.Cards = {...}
  })();
  ```
- Logic modules (cards, evaluator, equity, engine, bots, coach) must be **pure / DOM-free** so they run in Node tests via `vm`.
- Immutability preferred for public return values; engine may mutate its own internal state.
- Load order in index.html: `cards.js, evaluator.js, equity.js, engine.js, bots.js, coach.js, ui.js, main.js`.
- Only external resource allowed: Google Fonts (pixel fonts, e.g. "Pixelify Sans", "Press Start 2P", "VT323", "Silkscreen") with monospace fallback. Everything else inline/local.

## File layout (`/Users/lvxcas/pixel-poker/`)
```
index.html
css/style.css
js/cards.js  js/evaluator.js  js/equity.js  js/engine.js  js/bots.js  js/coach.js  js/ui.js  js/main.js
tests/run.js            # node tests/run.js — loads js/*.js into a vm context, runs tests/*.test.js
tests/<module>.test.js  # each registers via TESTS.push({name, fn}) ; harness provides assert
```
`tests/run.js` (owned by the core agent): creates a vm context, loads the logic modules in order
(skipping any that don't exist yet), then each `tests/*.test.js`; tests register `TESTS.push({name, fn})`;
`fn` may be async; `assert` = node:assert/strict is exposed on the context. Supports `node tests/run.js <filter>`
to run only test files whose name contains the filter. Prints pass/fail, exits non-zero on failure.

## Card representation
`{ r: 2..14, s: 's'|'h'|'d'|'c' }` (11=J,12=Q,13=K,14=A). Cards are plain frozen objects; compare by r+s.

## PP.Cards  (js/cards.js)
- `RANKS = '23456789TJQKA'`, `SUITS = ['s','h','d','c']`, `SUIT_SYMBOL = {s:'♠',h:'♥',d:'♦',c:'♣'}`
- `makeDeck() -> Card[52]`
- `shuffle(cards, rng = PP.Cards.rng) -> Card[]` (new array, Fisher–Yates)
- `rng() -> float [0,1)` crypto-backed when available, else Math.random
- `seededRng(seed:number) -> () => float` (mulberry32; for tests)
- `str(card) -> 'As' | 'Td'`, `parse('As') -> Card`, `parseMany('As Kd') -> Card[]`
- `rankName(r) -> 'Ace'`, `rankNamePlural(r) -> 'Aces'` (Sixes etc.), `isRed(card)`
- `same(a,b) -> bool`

## PP.Eval  (js/evaluator.js)
- `evaluate(cards: Card[5..7]) -> { cat: 0..8, catName, score: number, best: Card[5], desc }`
  - cat: 0 High Card, 1 Pair, 2 Two Pair, 3 Three of a Kind, 4 Straight, 5 Flush, 6 Full House, 7 Four of a Kind, 8 Straight Flush
  - `catName` uses 'Royal Flush' for A-high straight flush. Wheel A-2-3-4-5 is a 5-high straight.
  - `score`: single comparable number; higher wins; equal = exact tie (kickers included).
  - `desc`: human text e.g. "Two Pair, Kings and Sevens", "Flush, Ace high", "Full House, Threes full of Nines".
- `compare(a, b) -> number` (sign of a.score - b.score)
- Must be fast: ≥ 200k 7-card evals/sec in Node (Monte Carlo depends on it). May expose a faster internal `scoreOnly(cards)`.

## PP.Equity  (js/equity.js)
- `monteCarlo({ hero: Card[2], board: Card[0..5], opponents: n>=1, iterations = 2000, dead = [], rng }) -> { win, tie, lose, equity }` fractions; equity = win + tie share.
- `handLabel(hole) -> 'AKs' | 'QJo' | '77'`
- `preflopScore(hole) -> 0..1` (Chen formula normalized), `preflopTier(hole) -> 'Premium'|'Strong'|'Playable'|'Marginal'|'Trash'`
- `outs(hole, board) -> { count, cards: Card[], draws: string[] }` (flop/turn only; draws like 'Flush draw', 'Open-ended straight draw', 'Gutshot', 'Overcards'; count de-duplicated; empty on preflop/river)
- `potOdds(toCall, pot) -> number` required equity = toCall / (pot + toCall); 0 if toCall==0
- `boardTexture(board) -> { paired, monotone, twoTone, rainbow, connected, wet: bool, desc: string }`
- `ruleOf2and4(outs, street) -> approx equity %`

## PP.Engine  (js/engine.js)  — pure NLHE state machine, no DOM
```js
const eng = new PP.Engine({ players: [{ id, name, stack, isHuman }], smallBlind, bigBlind, ante = 0, rng });
eng.actionProvider = async (player, view, legal) => action;   // REQUIRED; UI resolves for human, bots compute
eng.on(eventName, async fn(payload))  // listeners may return promises; engine AWAITS them (UI animation pacing)
await eng.playHand();   // plays exactly one full hand, resolves with handRecord
eng.isGameOver()       // true when hero busted or only one player has chips
eng.players            // seat-ordered player state
eng.addChips(playerId, amount) // rebuy between hands
```
Player state: `{ id, name, seat, stack, hole: Card[], bet /*this street*/, totalBet /*this hand*/, folded, allIn, isHuman, out /*busted*/, lastAction }`
Action: `{ type: 'fold'|'check'|'call'|'bet'|'raise'|'allin', amount? }` — for bet/raise `amount` = **total "raise to"** for this street. Engine must validate & clamp illegal actions (treat invalid as check if possible else fold) and never deadlock.
`getLegal(playerId) -> { canFold, canCheck, canCall, callAmount, canBet, canRaise, minRaiseTo, maxRaiseTo, toCall }`
`publicView(forPlayerId) -> { handNumber, street: 'preflop'|'flop'|'turn'|'river'|'showdown', board, pot /*total incl. bets*/, pots: [{amount, eligible:[ids]}], currentBet, minRaiseTo, bigBlind, smallBlind, dealerSeat, sbSeat, bbSeat, toActId, players: [{id,name,seat,stack,bet,totalBet,folded,allIn,out,isHuman,lastAction, hole /* only own, or revealed at showdown, else null */}], history: [{street, playerId, type, amount, potAfter}] }`
Events (all awaited): `handStart {handNumber, dealerSeat, sbSeat, bbSeat}`, `blinds {posts:[{playerId, amount, kind}]}`, `deal {}` (hole dealt; UI reads view), `turn {playerId, legal}`, `action {playerId, type, amount, stack, pot}`, `street {street, board}`, `showdown {reveals:[{playerId, hole, hand /*PP.Eval result*/}]}`, `potAwarded {awards:[{playerId, amount, potIndex, hand|null}]}`, `handEnd {record}`, `gameOver {winnerId}`.
Rules required: dealer button rotation skipping busted players; heads-up rule (button = SB, acts first preflop, last postflop); short-stack blind all-ins; min-raise = last full raise size; incomplete all-in raise does not reopen betting; side pots; split pots with odd chip to first seat left of button; uncalled bet returned; win by folds (no showdown reveal required); all-in run-out (deal remaining streets with events); BB option preflop.
`handRecord`: `{ handNumber, dealerSeat, players:[{id,name,seat,startStack,endStack,hole}], board, actions:[{street,playerId,type,amount,potAfter}], showdown: bool, awards:[...], reveals:[...] }` — includes ALL hole cards (for the post-hand coach review).

## PP.Bots  (js/bots.js)
- `RATINGS`: 1..5 → `{ rating, title, blurb }`: 1 'Fish' (loose-passive, calls too much), 2 'Rookie', 3 'Regular' (solid TAG), 4 'Grinder' (aggressive, positional), 5 'Shark' (equity + pot-odds driven, balanced bluffs/semi-bluffs, sizing tells minimal).
- `create({ rating, id, name? }) -> bot` with `bot.decide(view, legal, me) -> action` (synchronous, ≤ ~40ms; Monte Carlo iterations scale with rating) and `bot.lastReasoning: string` (plain-English why, shown in post-hand review) and `bot.style` (e.g. 'Tight-Aggressive').
- Bots see ONLY `view` (own hole + public info). No peeking. Some randomness so they aren't robotic. Must ALWAYS return a legal action.
- `randomName(usedNames)` — fun retro arcade names.

## PP.Coach  (js/coach.js)
- `advise(view, legal, heroId) -> { street, holeLabel, preflopTier, made /*Eval desc or null preflop*/, equity, potOdds, outs, texture, position: 'Early'|'Middle'|'Late'|'Blinds'|'Button', recommendation: {type, amount?}, confidence: 'low'|'med'|'high', reasons: string[] }` — reasons are short teaching sentences ("You need 25% equity to call; you have ~38%. Call is +EV.").
- `grade(advice, actionTaken) -> { grade: 'GREAT'|'GOOD'|'OK'|'MISTAKE'|'BLUNDER', note }`
- `reviewHand(handRecord, heroId, decisions /*[{advice, action}]*/ , botReasonings /*{playerId: [strings]}*/) -> { headline, heroDecisions:[{street, action, grade, note}], reveals:[{name, holeLabel, handDesc, reasoning}], lesson: string }`
- `Drills`: `makeQuestion(kind, rng) -> { kind, prompt, cards?: {board, hands:[{label, hole}]}, choices: string[], answer: index, explanation }` for kinds: `'winner'` (which hand wins on this board), `'nameHand'` (what's the best 5-card hand), `'potOdds'` (call or fold given pot/bet/equity), `'outs'` (how many outs). Stats persisted by the UI (localStorage, try/catch).

## UI  (index.html, css/style.css, js/ui.js, js/main.js)
Screens: Title → Setup (bot count 1–8, per-seat rating 1–5 with pixel stars + title, starting stack, blinds, coach mode on/off, speed) → Table → Hand Review modal → Drills screen → Stats.
Table: pixel oval felt, seats around it (hero bottom center), CSS-drawn pixel cards (no image assets needed), chip stacks/bets, pot, dealer/SB/BB buttons, turn highlight + timer bar, action bar (FOLD / CHECK·CALL $x / BET·RAISE with slider + presets ½, ¾, POT, ALL-IN), keyboard shortcuts (F fold, C check/call, R raise, A all-in, space = next hand), action log, coach side panel (equity bar, pot odds, outs, made hand, recommendation + reasons; "Guess first" mode hides equity until hero types a guess), post-hand review modal with grades and every bot's revealed hand + reasoning. Rebuy / new game on bust. Responsive down to ~1024px wide; usable on laptop.
`main.js` wires: setup config → create Engine + bots → `actionProvider` (human → UI promise; bot → small think delay then `bot.decide`) → event listeners animate → coach advice captured on each hero turn → review after each hand.
