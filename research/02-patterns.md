# 02 — Patterns: eight principles for PIXEL HOLD'EM

## P1. Light is the hierarchy
- **Source:** Card Shark's Barry Lyndon candle pool; Buckshot Roulette's single lamp; Inscryption's vignette.
- **Applies here as:** the canvas renders one tungsten pool. It is an ellipse centred at (176, 118) in game pixels, with radius 0.6× the felt width, ramping `#2a5e40 → #1f4532 → #10261b` through Bayer 4×4 bands 12 game-px wide. The acting seat sits in light. Every other seat's DOM drops to `filter: brightness(.72)`, about −28% value, in 2 steps over 66ms. Folded seats drop to `.5`.
- **Rejects:** gold glows (`0 0 18–30px rgba(255,204,77,…)`), `.seat.acting` box-shadows, bordered panels used to signal importance.

## P2. Two quantities, two inks, two fixed homes
- **Source:** Balatro's chips/mult wells; Inscryption's scale; GTO Wizard's break-even threshold.
- **Applies here as:** NEED (required equity = call ÷ (pot + call)) is always lamp amber `#ffb45e`. HAVE (hero equity) is always gaslight blue `#8cc0e0`. Neither colour means anything else anywhere in the game. Both sit at 66px in the hero instrument on the rail. On a 96-game-px gauge, NEED is the notch and HAVE is the fill. Hue is never the only cue: NEED is always a notch and HAVE is always a bar.
- **Rejects:** a 30px equity in the corner with a 9px "NEED" tick; reusing a colour for both "toggle on" and "fold"; Balatro's blue and red.

## P3. The table holds the rule, the coach holds the verdict
- **Source:** blackjack felts ("DEALER MUST STAND ON ALL 17s"), Scarne/Hoyle diagram plates, the Juicy Stakes redesign.
- **Applies here as:** a silkscreen arc printed on the felt above the board reads `CALL WHEN EQUITY ≥ TO CALL ÷ (POT + TO CALL)`. The ink is `#d9c9a0` at 22% with about 6% pixel dropouts. When the hero must act, the live numbers ink into the blanks at 100% over 3 alpha steps in 150ms, e.g. `40 ÷ (120 + 40) = 25%`. The coach column then says only the verdict word and one sentence.
- **Rejects:** a SaaS sidebar of label/value rows; the "COACH SAYS" pill; bullet lists cut off at `max-height: 64%`.

## P4. Close spots look misprinted
- **Source:** letterpress and risograph misregistration; the tightly registered engraved Bicycle Rider Back as the "locked" state.
- **Applies here as:** the coach verdict word (CALL / FOLD / RAISE) is printed in two inks, cream `#ece2c9` and red `#e8604f` underneath. Registration offset by edge |HAVE − NEED|:
  - more than 10pts: 0px
  - 3–10pts: 1 game-px right
  - under 3pts: 2 right and 1 down
  This replaces the "LOW" confidence chip.
- **Rejects:** confidence chips, confidence percentages, any text label for "confidence".

## P5. One unit, unbreakable
- **Source:** Hyper Light Drifter (480×270), Celeste (320×180), Shovel Knight's fixed grid.
- **Applies here as:** the art renders at 480×270 and scales by an integer computed in device pixels. That is 3× on 1440×900 (`--u: 3px`) and 2× at 1024. Every art dimension, frame, shadow, tween step and shake offset is n×`--u`. Type is the one declared exception: it gets its own integer grid of Departure Mono at 22/44/66/88px, multiples of its 11px em.
- **Rejects:** `border-radius` (52 instances), `clamp()`/`vw` font sizes, fractional transforms, opacity fades on framed pixel art.

## P6. Stillness is tension; spend motion only where it means something
- **Source:** Papers, Please (stillness plus a clock); Inscryption (drumming fingers); Nijman's "permanence".
- **Applies here as:** zero idle animation. The only loop is the acting seat's timer bar: linear, 1 game-px tall. Bets stay on the felt as chip towers until the gather. The gather is 200ms with `steps(8)`.
- **Rejects:** `sway`, `letterBob`, `heroPulse`, `blink`, `crtFlicker`, `winBob`. That is all 9 current infinite loops except the timer.

## P7. Juice is tiered and budgeted, and the coach never shakes
- **Source:** Nijman, Jonasson & Purho, Eiserloh (shake ∝ trauma²); Balatro's single-curve-many-strengths `juice_up`.
- **Applies here as:** one function, `knock(el, tier)`, with tiers 1, 2 and 3.
  - **Tier 1:** 1u drop and return in 66ms.
  - **Tier 2:** 2u drop plus a 1-frame `#ece2c9` flash.
  - **Tier 3:** a 100–133ms hitstop plus table shake.
  - **Shake:** only two events can shake: all-in (trauma .4, about 2u max, 300ms decay) and a pot of 50bb or more (trauma .6, 3u max, 400ms decay).
  - Numbers never overshoot their true value.
- **Rejects:** a 7px shake with rotation; overshoot `cubic-bezier(…1.3–1.6…)` on equity bars; Balatro's rotational wobble.

## P8. Grade like a teacher: only mistakes get ink
- **Source:** GTO Wizard's Best/Correct/Inaccuracy/Wrong/Blunder and EV loss as % of pot; GNU Backgammon's error/blunder marks; Papers, Please stamps; the duty-stamp ace.
- **Applies here as:** Best and Correct are printed plain cream. "Close" is dim `#9a8f7b`. Inaccuracy gets a red-pen underline, Wrong a circle, and Blunder a struck stamp in `#9e2a1e` on paper at −4° to +3° with 12% pixel dropout. The stamp lands in 80ms from 1.15 to 1.0 with a 1-frame hitstop. Every mistake shows the cost as both bb and % of pot.
- **Rejects:** green "GREAT" pills; rainbow grade tiers; KPI tiles.
