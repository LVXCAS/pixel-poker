The price is printed on the back. The odds are on the face. You nick your read into the edge, and only then does the slip turn over.

# PIXEL HOLD'EM: visual design spec (FINAL, round 3)

**The constraint:** every decision is drawn on **one object**, a 36×108u paper slip lying under the one fixed bulb. Nothing else on the table reports the price or your equity. Everything is drawn at integer multiples of one unit `u`, inside a 480×300u frame.

**Proof (built to this spec):** `research/proof/table.html` · `research/proof/title.html` · `table.png` · `title.png` (1440×900, s=3). The table page loops through deal, bet, slip, read, flip and pour. Query options: `?state=before`, `?state=end`, `?frame=N`. Click the slip or type two digits to make your own read. Under `prefers-reduced-motion` the page shows the final frame; this was checked pixel-identical to `?state=end`.

---

## The thesis, in one object: the slip
The slip is a tall cream paper strip, **36×108u**. It is the only object on the table that is not shaped like a playing card, and its back is plain paper, not the card-back lattice.

- **Back (face up when the decision starts):** a 0–100 scale runs up the left edge, 1u per point. A 2u **price rule** in `--price-ink` is printed across it at NEED. A 3u tab of the rule stands proud of the right edge, and beside it the number is lit on the felt at 2× in `--bulb`: `33%`. This is the only place NEED is shown as a digit.
- **Your read:** one click on the slip (or two digits) cuts a **V nick 6u deep** into the left edge at your number. A cut goes through the paper, so it shows on both sides.
- **Face (after the flip):** the same scale, the same price rule (printed on both sides), and black ink **poured from the bottom up to HAVE** at a constant 2 points per frame. HAVE is printed at 2×, knocked out of the ink in paper colour.
  - If HAVE < NEED, the bare paper between the ink and the price rule is hatched in `--loss`.
  - If HAVE ≥ NEED, the ink covers the rule, and the rule shows through it in `--paper-shade`.
- **The three facts share one coordinate system on one object:**
  1. the nick (your read);
  2. the rule (the price);
  3. the ink level (the truth).

  The gap from the nick to the ink is your error. The gap from the ink to the rule is the decision.

**Why this and not a gauge (critic round 2, §4 and §1):** the card and the bar are now one object, so there is no duplicate digit, no bullet-graph track, no empty loading bar and no third face-down "hole card". What you remember is a tall paper slip under one bulb with one amber line on it.

## The three rules
1. **One bulb, fixed.** One light source, and it never moves. The pool is centred on the slip (201,162), not on the board. Light can do three things, all of them to the whole pool and all in steps: **brownout**, **warm** and **out**. Nothing has a glow, an emitted border, a chase or a second source.
2. **One unit, no exceptions.** Art pixels and type pixels are both `u`. Departure Mono is drawn at 11u × {1,2,4}. Its advance is **7u, measured from the font file** (`unitsPerEm` 550, advance 350 → 7px at 11px). Ascent is 11 and descent 3, so a 1× line is 14u.
3. **One material world: the card table.** The only objects are:
   - the room's dark and the bulb's light;
   - baize and the leather rail;
   - paper (cards and the slip);
   - clay chips and lammers;
   - the dealer button.

   A UI need that none of these objects can meet is met with plain type.

## Anti-goals
- **Balatro.** Every token is ≥ 10.2 ΔE2000 from the `G.C` values in 01-landscape, measured below. There are no paired fixed-colour number wells and no serialized score reveal.
- **Zynga / WSOP.** No gold, chrome, chase lights or glow.
- **shadcn / SaaS.** No rounded panels, label/value rows, KPI tiles, tracked caps or bar-graph widgets.
- **"Buckshot-like."** The dark room is the genre default and is not claimed as the signature. Only the slip is the signature.

---

## 0. Render model and scale
| Value | Setting |
|---|---|
| Safe frame | **480×300u**. All coordinates below are in this frame |
| Scale | `s = max(1, floor(min(innerWidth·dpr/480, innerHeight·dpr/300)))` device px per unit; `--u = s/dpr` CSS px |
| Worked cases | 1440×900 browser window (innerHeight ≈ 790–820) at DPR2 → s=5, u=2.5 CSS px. Headless 1440×900 at DPR1 → s=3 (the proof PNGs). 1024 wide at DPR1 → s=2 |
| Canvas | Backing store `ceil(innerWidth·dpr/s) × ceil(innerHeight·dpr/s)`, 1 canvas px = 1u, scaled by CSS with `image-rendering: pixelated`. The frame centres in it, and the room continues outward in `--room` |
| Type | `font-size: calc(11 * var(--u))` and ×2 and ×4. On canvas, glyphs are thresholded to alpha 0/255 (as in the proof's `glyphs()`), so type sits on the art grid |
| Positions | Every x/y is `Math.round` in units. A single `PP.LAYOUT` object (units) drives the felt, seats, bets, slip and bar |
| Background loop | None. The room repaints on resize and on the three light events only |

## 1. Typography
**Departure Mono** (Helena Zhang, departuremono.com, SIL OFL 1.1, v1.500). It is embedded as base64 woff2 (22 KB), which keeps it file://-safe and is permitted by the OFL. Fallback: `ui-monospace, Menlo`. It covers every glyph used here: `· ½ ¾ → ≈ × ♠♥♦♣ ↑↓`. `▸` is **missing**, so it is not used.

**Ratio 2 (the octave).** Only integer multiples stay crisp. ×3 would give a 9× step that doesn't fit 300u.

| Step | Em / line | Used for | Rule |
|---|---|---|---|
| **1×** | 11u / 14u | names, stacks, pot, log, coach sentences, operands, key hints, presets | — |
| **2×** | 22u / 24u | the lit price `33%` (2× digits + 1× `%`), `call 120`, `raise`, the coach verdict word, HAVE on the slip face, menu | `--bulb` 2× text only: the price and the to-call |
| **4×** | 44u / 44u | title wordmark, showdown hand name, Stats mean miss | **one per screen** |

- Tracking is 0 everywhere (a monospace bitmap's cells can't be tightened without resampling). Big type is controlled through the 1.0 line height.
- Names, labels and the UI voice are **lowercase**. Coach `reasons[]` and review `note`s are shown **verbatim, in their own sentence case**. That prose is the coach's voice and comes from frozen logic.
- CSS: `-webkit-font-smoothing:none; font-synthesis:none; font-kerning:none; font-variant-numeric:tabular-nums`. No `clamp/vw/rem`.

## 2. Colour (exact tokens)
2700K bulb over worn baize. Contrast is WCAG 2.x, computed. ΔE is CIEDE2000 against the Balatro `G.C` hexes in 01-landscape (`#009DFF #374244 #4BC292 #4F6367 #EAC058 #F3B958 #FDA200 #FE5F55`). The script's sanity check reproduces the round-2 value: `--bulb` vs `#F3B958` = 10.2.

```css
:root{
  --room:#0b0907; --room-2:#140e0b;
  --felt-hot:#2a5e40; --felt:#1f4532; --felt-rim:#10261b;
  --rail:#24150f; --rail-hi:#3d2519;
  --text:#ece2c9; --text-dim:#9a8f7b; --bulb:#ffb070;
  --coach:#11171d; --coach-edge:#1e2730; --coach-text:#cfd8de; --coach-dim:#7d8a94;
  --paper:#e6dcc4; --paper-2:#d2c8ae; --paper-shade:#c9bc9e;
  --ink:#1a1410; --red-ink:#8f2419; --blue-ink:#1f4f8c; --green-ink:#245a2e; --back-ink:#5a2620;
  --price-ink:#86560a; --loss:#9e2a1e;
  --clay-red:#8e3b2e; --clay-bone:#d8cbb0; --clay-edge:#3a1a14;
  --skin:#b9805c; --skin-shade:#7d5038;
}
```

| Token | One meaning | Computed |
|---|---|---|
| `--bulb` | **The price, as light on dark.** The lit `33%` beside the slip and the amount on CALL. Nothing else | felt-hot 4.22 (2× only), felt 5.98, rail 9.84 |
| `--price-ink` | **The price, as ink on paper.** The rule on the slip | paper 4.60. ΔE ≥ 29.7 |
| `--ink` | The equity pour, ♠, ranks | paper 13.37. `--paper` knocked out of the ink: 13.37; ticks in `--paper-shade` on the ink: 9.7 |
| `--loss` | **Shortfall and lost chips.** The hatch on the slip, negative amounts in the log | paper 5.49. ΔE 25.8 from `#FE5F55` |
| `--red-ink` / `--blue-ink` / `--green-ink` | ♥ / ♦ / ♣ (four-colour deck) | on `--paper-2`: 5.18 / 4.94 / 4.89 |
| `--paper` / `--paper-2` | Paper in the pool core / in the first falloff band. The light dims the paper; it is not a style | L = 0.72 / 0.58 |
| `--text` / `--text-dim` | Primary / secondary and folded seats | text on felt 8.33; dim on room 6.24, on rail 5.54 |
| `--coach-text` / `--coach-dim` | The coach's voice on the only cool surface | 12.48 / 5.10 |

**Rules**
- The price has **one hue and two media**: amber light (`--bulb`) on dark, amber ink (`--price-ink`) on paper. No other colour is in that hue family.
- `--price-ink` vs `--loss` is only 1.19:1 in luminance. They are separated by hue (37° vs 8°) and **always by shape**: the rule is a solid 2u line, the loss is a 1-in-3 diagonal hatch. The CVD pass (Open items) checks shape alone.
- Selected state is value inversion (`--text` fill, `--ink` glyphs). Never a hue.
- No CSS gradients. All light is stepped bands in canvas.

**Luminance hierarchy (measured, not asserted).** This is from `before.png`, summing relative luminance × area in u²:

| Object | Area-weighted luminance |
|---|---|
| Slip | 2,668 |
| Board (4 cards) | 1,269 |
| Hero cards | 733 |
| Coach sheet (whole) | 1,106 |

The claim is narrow: **the slip is the largest lit mass on the table**. The board sits one paper step down because it is in the falloff band. Individual glyphs (`--text`, L 0.76) are brighter per pixel than the slip's paper (0.72). That is accepted.

## 3. Space, frames, surfaces
- Spacing comes from the type cell: **1u** hairlines and drops, **2u** hero lift, **7u** cell, **14u** line, **28u** section. Nothing else.
- **Radius 0.** Paper has 1u notched corners. Lammers are drawn pixel circles.
- **Elevation, 3 levels:**
  - flat: the room, the felt and the coach sheet;
  - 1u `--room` drop: cards, chips and buttons;
  - 2u drop: the hero's cards and the slip.
- **Rail buttons:** `--rail` with a 1u `--rail-hi` top edge and a stitch row (1u `--rail-hi` dots every 3u, 2u inside the top and bottom edges). This is drawn, not 9-sliced, in the proof. Production may use one 24×24 `rail.png` (slice 6).
- **No box inside a box.** The coach sheet is the only container on the table screen.

## 4. Table layout (units, frame 480×300)
**Zones:** the table zone is x 0–336. The coach sheet is x 336–480, y 0–252. The action bar is y 258–294.

- **Felt:** ellipse centre (168,128), rx 148, ry 88 (x 20–316, y 40–216), inside an 8u rail. A 1u `--room` seam separates the rail from the felt.
- **Pool:** centre **(201,162)**, which is the slip. Aspect is 1.3 (wider than tall, because a bulb over a table throws an ellipse). Core is `--felt-hot` to r 58, then `--felt` to r 100, then `--felt-rim`.
- **Band edges:** each edge is a 6u **twill dither**, `(x+y)&3`, in 25% / 75% steps. This is the baize's diagonal weave used as the dither. The rail inside the pool steps up to `--rail-hi`.
- **Room:** `--room-2` → `--room` across 12u in the same twill. There is no radial-gradient vignette.
- **Wear:** one 20×8u patch, one step lighter, at the dealer push zone (158,104), with a twill-dithered edge. It is the only mark on the cloth.

**Objects:**
- **Board:** five M cards (22×30u, 4u gaps) at x 105/131/157/183/209, y 72–102, on `--paper-2`. Empty slots are a 1u `--felt-rim` outline pressed into the cloth.
- **Pot:** `pot 240` at 1× `--text`, **left-aligned at (105,55)**. It is never amber, because the pot is an operand.
- **Slip:** (184,108)–(220,216). The price label sits at x 225–260, y `ry−21`…`ry+3`, where `ry = 212 − NEED`. Because the pot always includes the bet, `NEED = call/(pot+call) ≤ 50`. That puts the label inside **y 141–215**, and the column **x 221–262, y 138–216 is reserved**: no seat, bet or label may enter it.
- **Hero:**
  - cards (128,174) and (152,174), M size, 2u lift;
  - `you 1,240` at (128,227);
  - bet tower base at (104,192), left of the cards.
- **Dealer button:** 10u `--clay-bone` disc with a 1× `d`, set on the felt in front of the button seat. In the proof it is at (86,64).

**Seats (8 bot anchors).** Each block is 100×28u:
- a 12×12u avatar at (x, y+1);
- the name at (x+16, y−1), 1×, column **84u = 12 cells**;
- the stack at (x+16, y+13);
- live bots' two S card backs at (x+56, y+14).

| Seat | Anchor | Bet tower base |
|---|---|---|
| top-left | (24,2) | (76,62) |
| top-centre | (130,2) | (200,62) |
| top-right | (236,2) | (262,64) |
| left-up | (0,62) | (60,100) |
| left-low | (0,136) | (60,150) |
| bottom-left | (0,214) | (70,196) |
| right-up | (236,62) | (250,122) |
| bottom-right | (236,222) | (270,176) |

The round-2 "right-low" seat (236,136) is **removed**, because it sat in the price label's column. Top-centre replaces it. With fewer bots, seats fill in `PP.LAYOUT.fillOrder` = right-up, left-up, top-left, top-right, left-low, bottom-left, bottom-right, top-centre.

**Names (critic round 2, §2).**
- The longest `BOT_NAMES` entries are `scanline sam` and `arcade annie`, at 12 cells, which fit 84u exactly.
- `randomName` appends ` 2`, ` 3` and so on only after all 40 names are used (bots.js:684–689), so at ≤ 8 bots this happens only with user-entered names. **Rule:** if a name is > 12 cells, keep any ` N` suffix and clip the base to `12 − len(suffix) − 1` cells, then add `.`. Example: `scanline sa. 2`.
- **Skill is not shown at the table.** This is a deliberate cut. It appears on Setup and in Review.

**Seat states** are carried by the people, not the light:
- **Acting:** the avatar's *lean* frame, 2u toward the felt, and a 1u linear timer under the name. This is the only loop in the game.
- **Folded:** `--text-dim` name and stack, the avatar's *back* frame (shown in the proof), and the cards muck.
- **All-in:** a 30u `--clay-bone` lammer reading `all in`.
- No CSS `filter`.

## 5. The slip (the product)
**Geometry (slip-local units):**
- **Paper:** 36×108, 1u notched corners, a 1u `--paper-shade` right column and bottom row, and a 2u `--room` drop.
- **Top edge:** a perforation row (1u `--paper-shade` dot every 3u at y+2), because the slip was torn off a pad.
- **Scale:** point `p` sits at `y + 104 − p`.
  - Ticks every 5 points are 1u tall, 5u long at the 10s and 3u at the 5s.
  - They are `--ink` on paper and `--paper-shade` where they cross the ink.
- **Price rule:** 2u `--price-ink` from x+6 to the right edge at `p = NEED`, printed on both sides. The tab is a 3u `--bulb` stub past the right edge. The label `33` is 2× + `%` 1× in `--bulb` at (x+41, ry−21).
- **Nick:** a V cleared through the paper at `p = READ`, 7 rows tall: `1,3,5,6,5,3,1` units deep.
- **Pour:** `--ink` from x+1 to x+34, from p=0 up to the current level.
- **HAVE label:** 2× `--paper`, knocked out 2u below the ink surface. When HAVE < 24 it is placed **above** the surface in `--ink` on a paper knock-out instead, because there is no room inside.
- **Loss:** `--loss` pixels where `(i + p) % 3 == 0`, from HAVE+1 to NEED−2.
- **Hollow rule** (see "Verdict ≠ price" below): two 1u lines with a 1u gap, in place of the solid 2u rule.

**Before a read (every hero decision with a bet to face):**
- The slip, the rule and the lit `33%` appear **together in one frame**, after the pot finishes counting. There is no build-up sequence.
- The coach shows the operands and `your read?`.
- **The CALL button's `120` is in `--bulb`.** It is the to-call operand, a different fact from NEED.

**Making a read: the easiest thing on the screen**
1. **Hover** the slip: a 1u `--text-dim` pencil guide follows the pointer's height. **One click** cuts the nick and commits. There is no confirm and no second step.
2. **Type two digits** (`3`,`0`). The second digit commits. Digit keys belong to the slip **only while it is waiting for a read and no `<input>` has focus**. When `R` opens `#raise-input`, the input owns all digits and Enter (ui.js:797). The slip's listener returns early on `e.target.tagName === 'INPUT'`, as in the proof.
3. **Act** (F/C/R/A or a button). Buttons are live from frame 0 and nothing blocks them. An act without a read still flips the slip and pours. **There is simply no nick.** This is the honest limit: a reading can't be forced on someone who won't give one (§13). What the visual layer *can* do is make the read a single click on the object your eye is already on, and keep a record: unread decisions show as nick-less slips in Review, and Stats reports how many decisions you read.

**After commit (the signature motion):**
- **Frame 0:** the nick is cut (1 frame).
- **Frames 2–9:** `FLIP`, scaleX `1, .66, .33, 0 | 0, .33, .66, 1`, 4+4 frames, centred on the slip. The lit tab and label hide while the slip is squashed.
- **Frame 11 onward:** `RUN`. The ink rises at a **constant 2 points per frame**, so 26% takes 13 frames (217ms). **Distance is duration.**
- **When the pour stops:**
  - the HAVE number is placed;
  - the loss hatch appears in 1 frame (if HAVE < NEED);
  - the coach verdict steps in over 3 frames.

**Data sources (all frozen):**

| Drawn | Source |
|---|---|
| NEED | `Math.round(advice.potOdds * 100)` (`advise()` returns `potOdds`, `toCall`, `pot`) |
| HAVE | `Math.round(advice.equity * 100)`, raw Monte Carlo vs all live opponents |
| READ | `coach.guess`, set through the existing `opts.onGuess(guess, actualPct)` (ui.js:905–922). The visual layer adds the slip as a second way to set it and removes the text form |

**Verdict ≠ price (critic round 2, §2: "no field for the disagreeing reason").** This is decided **numerically, not by matching coach prose**:
- `priceSays = advice.equity >= advice.potOdds`
- `coachSays = advice.recommendation.type ∈ {call, bet, raise, allin}`
- If `priceSays !== coachSays`, the rule renders **hollow** after the flip, and the coach's first line is a 1× `--coach-dim` tag from `advice.concept`:

| `advice.concept` | Tag |
|---|---|
| `impliedOdds` | `implied odds` |
| `semiBluff` | `semi-bluff` |
| `value` | `value` |
| `position` | `position` |
| `preflop` | `starting hand` |
| `nuts` | `nuts` |
| `freeFold` | `free card` |
| `potOdds` | (no tag) |

These are the 8 values in coach.js today. Any unknown value shows no tag.

**Other cases:**
- **Raise/bet recommended:** after the pour, one clay chip (12×4u) is set on the preset button nearest `recommendation.amount`, computed with ui.js `presetTo(frac)` for `0.5, 0.75, 1, max`.
- **Multiway:** the label line gains `· 3 left` at 1× `--text-dim` when there are ≥ 3 opponents. Equity is already computed against all of them.
- **No bet to face (check is free):** the slip lies face down with **no rule and no label**. It still takes a read and still flips after you act, so you get a calibration rep for free.
- **Preflop:** same as the other streets.
- **`guessMode` off:** the slip appears face up with the pour already run and no nick. Turning it off is an opt-out of the thesis. **Contract request:** `main.js:89` defaults `guess: false`. The thesis needs `true`. That one-line settings change is outside the visual layer, so it is flagged to the logic owner. Everything above renders correctly either way.

## 6. The coach (calm voice, cool sheet, out of the light)
**Sheet:** x 336–480, y 0–252, `--coach`, with 1u `--coach-edge` lines on the top and left. Inner text column: x 342, **19 cells (133u)**.

**Lines:**

| y | Content |
|---|---|
| 3 | `hand 14 · 10/20` in `--coach-dim`. This replaces the topbar. `tb-*` toggles move to the Esc sheet |
| 21 | operands: `call 120 · pot 240`. **Overflow:** if it exceeds 19 cells, it splits onto two lines (`call 120` / `pot 240`). Amounts ≥ 100,000 render as `124k`. The worst case, `call 99,999` / `pot 999k`, is 11 and 8 cells |
| 35 | before the read: `your read?` (dim). After: `you 30 · off 4`, in `--coach-dim` when the miss is ≤ 5 and `--coach-text` otherwise |
| 56 | verdict, 2× `--coach-text`: `fold` / `call` / `raise` / `check` / `all in`, from `recommendation.type` |
| 88 → 232 | **why** (detail below) |
| 236 | `2 more · tab` in `--coach-dim` |

**The why (fixes "every real sentence will truncate"):**
- `reasons[]` are shown **in order and verbatim**, word-wrapped at 19 cells. A word longer than 19 cells is hard-broken, though none exists in coach.js.
- Reasons stack with a 7u gap, up to **11 lines**.
- A reason that doesn't fit whole moves to the next page, so nothing is ever truncated. `Tab` pages.
- **Measured:** the pot-odds sentence `Pot odds: call $120 to win $240 → you need 33% equity; you have ~26%. Calling loses money long-term.` is 98 chars and wraps to 6 lines. The contract example (58 chars) wraps to 4.
- `MAX_REASONS` is 5. The longest template (outs plus a draw list) is about 110 chars, 7 lines. So one page always holds at least one whole reason.

**Before the read**, there is no why. Below a 1u `--coach-edge` rule at y 56, the **log** fills the space: 13 lines at 1×. Street breaks are a blank line, plus `flop K♥ 7♥ 2♣` in dim (suits as glyphs in coach colour, not card inks). Negative amounts are in `--loss`.

**Motion:** text swaps step opacity in 3 frames. The coach never translates, offsets or shakes.

## 7. Motion: per-frame tables (60fps), from the physics of the object
| Name | Physics | Position at frame n of N | CSS equivalent | Used for |
|---|---|---|---|---|
| `SLIDE` | Paper or clay on baize, constant friction (constant deceleration) | `1 − (1 − n/N)²` | `cubic-bezier(.333,.667,.667,1)` | Deal (N=9), chips to a tower (N=12, 3f stagger), sheets (N=12) |
| `SWEEP` | Pushed from rest (constant acceleration) | `(n/N)²` | `cubic-bezier(.333,0,.667,.333)` | Muck, dismiss (N=7) |
| `RUN` | Constant rate, so distance = time | 2 points per frame | `linear` | The slip's pour only |
| `TOSS` | x linear, y parabola, 12u apex | `y = 48·t·(1−t)` | JS | Pot award (N=24). No overshoot anywhere |
| `FLIP` | Turned by hand | scaleX `1,.66,.33,0 / 0,.33,.66,1` | `steps(4)` | Hole, board and slip |
| Light | Filament steps | 3 frames per step | `steps(3)` | Brownout, warm, out, title catch |

- **Counts follow chips.** The pot and stacks change only when a chip lands, by that chip's value. In the proof the pot goes 120→240 in six steps of 20. They are capped at 30 changes per second.
- **`knock(el, tier)`**, vertical offset tables:

  | Tier | Offsets | Frames | Used for |
  |---|---|---|---|
  | T1 | `[0,1,0]`u | 3 | landing |
  | T2 | `[0,2,1,0]`u | 4 | a raise's tower, as in the proof |
  | T3 | `[0,2,−1,1,0]`u on `#table-stage` | 5 | after hitstop; the only screen movement |

- **Reduced motion:** every table jumps to its last frame, the pour is placed whole, and hitstop and T3 are 0.

## 8. Feel table
| Event | Hitstop | Light | Motion | Audio (later) | Total |
|---|---|---|---|---|---|
| Deal (per card) | — | — | `SLIDE` N=9, 4f stagger, land T1 | card tick ±8% pitch | 150ms/card |
| Hero hole flip | 3f hold | — | `FLIP` | snap | 183ms |
| Flop | — | — | 3× `FLIP`, 5f apart | 3 ticks | ~300ms |
| Turn | 15f silence before | — | `SLIDE` + `FLIP` | tick | ~400ms |
| River | 15f + 5f hold | brownout 18f | `FLIP` + T1 | tick + thump | ~650ms |
| Bet / call | — | — | chips `SLIDE` N=12, 3f stagger; tower +2u per chip; pot counts per landing | clack per chip ≤ 30/s | 200–450ms |
| Raise | — | — | as a bet, then T2 on the tower | heavier clack | 250–500ms |
| Fold | — | — | `SWEEP` N=7; seat → dim + back frame | soft slide | 117ms |
| **Hero to act** | — | — | slip + rule + lit label in **1 frame** | — | 16ms |
| **Read** | 1f (nick) | — | nick, `FLIP`, `RUN` 2pt/f, loss hatch, verdict steps(3) | knife tick, flip snap, pour tick per 10 points | 11f + HAVE/2 f (≤ 61f at 100%) |
| All-in | 8f | brownout held | T3; `all in` lammer drops (T1) | push + duck | ~250ms |
| Showdown | 6f | — | bot hands `FLIP`, 7f apart; winning five lift 2u | ticks | ~300ms + 117ms/bot |
| Pot award | 4f | warm 36f | `TOSS` N=24, land T1; ≥ 50bb: T3 | cascade | 450–700ms |
| Bust | 8f | **out**: 3 steps × 8f + 18f black | sheet `SLIDE` | bulb tink | ~1000ms |
| Coach update | never | never | opacity steps(3) | — | 50ms |

**Input:** ≤ 1 frame from keypress to pressed state. Keys apply during animations. F/C/R/A, digits (slip, see §5), Tab (coach pages), Esc, Space.

## 9. Cards
- **Two drawn sizes, never scaled:** S 14×19u (bots, review) and M 22×30u (board, hero).
- **Index:** the rank in Departure Mono 1× in the suit ink at (2,−1). A rank is a glyph, so it shares the face. **M centre:** the 7×7 pip at 2× (14×14) at (7,14). **Courts (J/Q/K):** a 12×14u bust in suit ink + `--paper-shade` at (8,13), distinct headwear per rank (crown, cap, veil), with a 7×7 pip at (2,12). **S:** rank + one 7×7 pip at (4,10).
- **Four-colour deck on by default** (♠ ink, ♥ red, ♦ blue, ♣ green). Toggle in the Esc sheet.
- **Back:** a one-ink `--back-ink` diagonal lattice (period 4) with a 5u paper diamond medallion. **The slip never uses this back.**
- **Lighting:** paper in the pool core is `--paper`; in the first band it is `--paper-2`. The tone is chosen by the card's centre.
- No idle motion, no tilt. Hover: T1.

## 10. Screens
**Title** (`proof/title.html`):
- The table is shifted right and down: felt centre (300,206), rx 176, ry 96, pool at (298,190). It is cropped by the frame, and **one face-down slip** lies under the bulb with a rule at 25 and a lit `25%`.
- Wordmark `pixel hold'em`: 4× `--text` at (16,12), lowercase, 13 cells = 364u.
- Line under it: `a no-limit trainer. bring your own odds.` at 1× dim.
- Menu: `play / drills / stats` at 2×, (17,104) with 28u pitch. The selection is inverted.
- Footer: `↑↓ choose · enter sit down` at 1× dim, y 276.
- **The bulb starts off.** The felt is one step above `--room` and the text is dim. The first key or click **catches the bulb**: 1 frame on, 2 off, then 3 steps × 3 frames. Once per session; instant under reduced motion.
- No logo, no cards fanned, no chips.

**Setup:**
- On the table, bulb on, empty felt.
- Each `#setup-lineup` row sits at its seat anchor, showing `nina` and then `★★★★☆ grinder` at 1× dim. Skill lives here.
- Click a seat to cycle its rating.
- `#setup-options` are plain 1× rows in the coach sheet, with the selection inverted.
- `#setup-start` is a rail button.

**Table:**
- As §4–§6. Action bar left to right from x 22, y 260, buttons 32u tall:
  - `f fold` (1×, 56u)
  - `c call 120` (2×, with `120` in `--bulb`, 139u)
  - `r raise` (2×, 97u)
  - presets `½ ¾ pot max` at 1× as 20u rail tabs. These map 1:1 to `.preset[data-frac="0.5|0.75|1|max"]` (index.html:96–99). Round 2's `⅔` was wrong.
- Key letters are shown in `--text-dim` for the first 3 hands and while `?` is held.
- `#raise-slider` / `#raise-input` stay in the DOM and are revealed on `R`.
- The Esc sheet holds: four-colour, guess first, autodeal, speed, review.

**Hand Review** (`#modal-root`): the hand is laid back out on the same felt.
- Every player's hole cards are face up at their seat. Skill shows beside each name.
- Along the front rail is **one S-scale slip per hero decision** (12×36u, 3 points per u). Each is drawn from data the UI already holds: the `advice` objects ui.js was handed this hand (`equity`, `potOdds`) and the read made at that decision. Reads are kept in ui.js memory for the current hand only, not persisted. A decision with no read is a slip with no nick.
- **Grades use the contract ladder `GREAT | GOOD | OK | MISTAKE | BLUNDER` and chess annotation on lammers:**

  | Grade | Lammer |
  |---|---|
  | GREAT, GOOD | none (only mistakes get an object) |
  | OK | none; the `note` shows in `--coach-dim` |
  | MISTAKE | 24u `--clay-red` lammer printed `?` |
  | BLUNDER | 30u lammer printed `??`, landing with T2 |

  `.grade-*` classes keep these five names.
- **No EV-cost figure anywhere.** `heroDecisions` has `{street, action, grade, note}`, and there is no cost data. The slip's loss hatch is the cost picture.
- The coach sheet shows the selected decision: grade word, `action`, `note` verbatim (wrapped and paged as §6). ←/→ steps through decisions, ↑/↓ through seats (`holeLabel`, `handDesc`, `reasoning`). Selection defaults to the worst grade. `lesson` is at the top.

**Drills:**
- Dealt on the same table. The `prompt` is in the coach sheet and `choices` are rail buttons.
- **Right:** the winning five lift 2u.
- **Wrong:** a `?` lammer drops on your button and the right one inverts.
- **`potOdds` drills use the slip.**
- `#drill-score` is in the coach top line.

**Stats: the rack and the miss.** Built **only from what main.js already persists** (`stats.grades` counts, `stats.guesses.{count,totalError}`, main.js:57–66). No new schema.
- **The 4× number is your mean miss:** `±7`, from `totalError / count`. The read is the thesis, so its calibration is the headline stat. ui.js:889 already computes it as "EQUITY GUESS ERROR".
- Under it, 1× dim: `over 212 reads · 61% of decisions read`. Decisions = the sum of grade counts.
- **The rack:** one 100-slot clay rack (5×20 slots, chips edge-on 4×10u, 1u gaps, 100×54u total). It shows grades **per 100 decisions, sorted the way a real chip rack is sorted, by colour**:
  - `--clay-bone` chips for GREAT + GOOD;
  - empty `--room` slots for OK;
  - `--clay-red` chips for MISTAKE;
  - empty slots with a 1u `--loss` rim for BLUNDER.

  Counts are rounded with largest-remainder so they total 100. The rack does **not** claim recency.
- Everything else is 1× rows. `.stat-tile` markup stays and renders as rows.

**Tutorial (upcoming):** on the live table, one concept per hand. A 1u `--text` leader line runs from the coach sentence to the object it names. The last lesson is the slip.

## 11. Frozen API (must not break)
- **IDs:** all ids in index.html, in particular:
  - `#felt-wrap #table-stage #seats #bets #fx-layer`
  - `#board .board-slot`×5
  - `#pot #pot-amount #pot-side`
  - `#action-bar[data-mode] #btn-fold/call/raise #call-label #raise-label #raise-slider #raise-input .preset[data-frac]`
  - `#coach-body #log #modal-root #bg`
  - `tb-*` with `.btn-label`
  - setup, drills and stats ids
- **State classes restyled, not renamed:**
  - `.dealing/.flipping/.mucking`
  - `.seat.acting/.folded/.allin/.out/.winner/.hero`
  - `.seat-timer.run`
  - `.seat-bubble.act-*`
  - `.bet.show/.gather`
  - `.pot.show/.glow`: `.glow` becomes a no-op
  - `.ticking`
  - `.fly-chip .float-text .stamp`: `.stamp` renders as a lammer
  - `.table-main.shake`: plays the T3 table
  - `.grade-GREAT/GOOD/OK/MISTAKE/BLUNDER`
- **New DOM (additive):** `#slip` (a canvas or element in `#felt-wrap`) and `#price-tab`. Coach data still comes from `PP.Coach.advise`.
- **Guess flow:** `coach.guess` and `opts.onGuess` are unchanged. The slip click, the digits and the hero's action all resolve `coach.guess`; an action with no read leaves it `null` and does not call `onGuess`.
- **Credit (critic round 2, §2):** "Guess first" already exists. It is in CONTRACT.md:98, the ui.js:905 `guessForm`, and the main.js:315 `recordGuess`. This spec does **not** claim the mechanic as new. It claims the **drawing**: one object with the read cut into it.
- **Factories to rewrite:**
  - `paintSwirl/startBackground` → `paintRoom` (moods `calm | brownout | warm | out`; `danger` maps to `brownout`, `win` to `warm`)
  - `cardFace/cardBack/PIXEL_ART`
  - `buildSeat`
  - coach builders
  - `avatar` (idle, lean, back)
  - layout → `PP.LAYOUT`
- Remove `--chrome: 214px`.

## 12. Performance
- 0 per frame for the room.
- Animate `transform`/`opacity` in DOM. The slip is redrawn only on its own frames.
- No `filter` or `backdrop-filter`.
- Proof: one 480×300 canvas, with the room `ImageData` painted once.

## 13. Deliberately NOT doing
- **No gauge, bar, meter or track** anywhere. The slip replaces them. No equity bar in the coach.
- **No second copy of NEED or HAVE.** NEED is the lit label beside the slip. HAVE is printed on the slip face. The coach repeats them only inside the verbatim `reasons[]` prose, which we don't edit.
- **No forced read.** Acting is never blocked. We accept that an impatient player can skip every read, and we make that visible (nick-less slips, read %) instead of nagging.
- **No CRT, scanlines or vignette.** There is no television in this room. The current build's CRT toggle is cut.
- No glow, halo, neon, chase lights, or moving or second light.
- No shake system. One 5-frame T3 table with two triggers.
- No eased number tweens. Counts follow chips; the pour is linear.
- No print-shop ephemera: no silkscreen, misregistration, stamps, tickets-as-decoration or racing forms.
- No text off the unit grid, no tracked caps, no second typeface.
- No `border-radius` other than 0, no soft shadows, no CSS gradients, no boxes in boxes, no KPI tiles.
- **No EV-in-bb, no last-100 sequence, no ⅔ preset.** The contract doesn't provide them.
- **No skill rating at the table.**

## 14. The gate
1. **Remembered 24 hours later:** *a tall paper slip under one bulb, with one amber line printed across it. You nick it where you think you are, it turns over, and black ink rises to where you really are.* It's an image, not a sentence about a mechanic. **The price is on the back, the odds are on the face.**
2. **Given up:**
   - showing the answer before you commit (the expensive one for a trainer);
   - every bar or gauge, including the familiar equity bar poker apps use;
   - skill ratings at the table;
   - short coach text: the coach's full sentences are kept, paged, instead of cut;
   - brightness and ambient motion;
   - CRT and shake;
   - a forced read.
3. **What a competitor wouldn't copy:**
   - The mechanic is **not** ours. This build already ships "guess first", and GTO Wizard's trainer withholds the solution until you act. We claim the **drawing**: the decision as one physical object on which your guess, the price and the truth share one scale, and your guess is a cut you can't undo.
   - A competitor won't copy it, because it costs them the thing commercial tools sell: the live equity bar or HUD number on screen at all times.
   - Scope of the check: the itch.io pixel-art + poker tag, pazoff/poker, and the GTO Wizard and PokerSnowie docs in 03-references. This is not a market survey.
4. **Identifiable without logo:** the silhouette is a 1:3 cream strip under a stepped green light pool, with a single amber line and a lit 2-digit number. Playing-card proportions are 22:30 and no card back looks like that strip. Strip the wordmark from `title.png` and it is still that image.

## Open items to verify before build
- **Overlay test:** check at s=2, 4 and 5 with the 1u grid and `PP.LAYOUT` boxes, all 8 seats and the longest names, that nothing enters the price column (x 221–262, y 138–216) or the slip. Also check top-centre (130,2) against the top-left and top-right blocks: there is a 6u gap on each side.
- **CVD pass** (Chrome DevTools > Rendering > Emulate vision deficiencies) on the before and after states. Pass condition: in achromatopsia, the nick, rule, ink and hatch stay distinct by shape alone.
- **Data-URI font crispness** in Safari at DPR1 and DPR2. Chrome headless is verified in the proof.
- **Wear patch** reads as wear at s=2.
- **Contract request:** default `guess: true` in main.js:89 (logic owner).

## Sources
- Balatro `globals.lua` (github.com/idkhan/Balatro3DS): the ΔE targets.
- Card Shark (Nerial) and Buckshot Roulette (Mike Klubnika): a single fixed light; also why the room isn't the signature.
- Inscryption (Daniel Mullins): one diegetic instrument, text cut rather than shrunk.
- Slay the Spire: intent shown at the seat before you commit.
- GTO Wizard trainer docs (help.gtowizard.com/how-to-use-the-trainer): withhold-until-commit precedent.
- Chess annotation (`?`, `??`), used as the grade glyphs.
- pokernews pot-odds: `call ÷ (pot + call)`, matching `PP.Equity.potOdds`.
- Lospec Apollo (AdamCYounis): ramps.
- departuremono.com v1.500: face, licence, metrics.
- Jan Willem Nijman ("The art of screenshake") and Jonasson & Purho ("Juice it or lose it"): hitstop and permanence.

---

## Critique response (round 2 → final)
| Critic point | Resolution |
|---|---|
| One object is really three; duplicate digit | **Strongest change adopted.** Card, gauge and price line are folded into the slip (§5). NEED is shown once (lit label), HAVE once (slip face) |
| Bullet graph after commit / empty loading bar before | No track exists. A paper strip with a printed scale, a cut and an ink level (§5, §13) |
| Equity card reads as a third hole card | 36×108 at 1:3 proportion, plain paper back, never the lattice (§9) |
| "Notch is brightest" is false | Claim withdrawn. Replaced with a **measured** area-weighted figure: slip 2,668 vs board 1,269, with paper dimmed by band (§2) |
| Signature is a default flipped on an existing feature | Credited (§11). The claim is the drawing (§14.3). The default change is a flagged contract request |
| Invented coach example; 57-char cap | Coach text is verbatim, wrapped at 19 cells and paged, never truncated. Measured with the real template (§6) |
| No field for the disagreeing reason | Numeric `equity ≥ potOdds` vs `recommendation.type`, plus an `advice.concept` tag. No string matching (§5) |
| Names ≤ 12 wrong with suffixes | Suffix rule and clipping defined. Skill suffix removed from the table (§4) |
| Grade ladder not in contract | `GREAT/GOOD/OK/MISTAKE/BLUNDER`, with lammers on MISTAKE and BLUNDER only (§10) |
| No data for cost in bb | Removed. The loss hatch is the cost picture (§10, §13) |
| Presets `½ ⅔` | `½ ¾ pot max`, mapped to `data-frac` (§10) |
| Stats needs a last-100 sequence | The rack uses aggregate counts per 100, sorted by colour, with no recency claim. The headline is mean miss from existing `guesses` (§10) |
| Digits vs `#raise-input` | The input owns digits when focused. The slip owns them only while waiting and nothing is focused (§5) |
| Impatient player presses C every hand | The read is one click on the object already under the eye. Skipping is visible, not blocked (§5, §13). Forcing it is a declared non-goal |
| Price line overflow into the right-low seat | The price line is gone. The lit label occupies a reserved column, the right-low seat moved to top-centre, and the coach operands have a two-line overflow rule (§4, §6) |
