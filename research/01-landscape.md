# 01 — Landscape teardown: pixel and retro card/table games

Each entry: the one decision worth stealing, how it frames panels, how it shows critical numbers, and what transfers to PIXEL HOLD'EM. Hex values marked *(decompile)* come from Balatro's `globals.lua` as reproduced at github.com/idkhan/Balatro3DS. Sample a screenshot before you treat them as ground truth.

---

## Balatro (LocalThunk / Playstack, 2024)
- **Decision:** every number is an object with a fixed colour and a fixed home. Chips are always blue and mult is always red, in two side-by-side wells with a × between them. Triggers fire left to right in series, 0.2–0.4s apart, so cause and effect stay readable.
- **Palette** *(decompile)*: chips `#009DFF`, mult `#FE5F55`, money `#F3B958`, gold `#EAC058`, green `#4BC292`, "black" `#374244` (teal-grey), L_Black `#4F6367`. Gold is only ever used for money.
- **Framing:** UIBox `emboss` is a solid, zero-blur darker lip under each box, and buttons press by losing it. Live values sit in darker inset wells.
- **Juice** *(from the Lua port)*: `juice_up` lasts 0.4s, scale follows `sin(50.8t)·(1−t/0.4)³`, rotation follows `sin(40.8t)·(1−t/0.4)²` with a random ±1 sign. Every scoring trigger uses `juice_up(0.6, 0.1)`. One curve, many strengths.
- **CRT** *(smods reimplementation)*: `crt = setting×0.3`, barrel distortion about 2–3% at maximum, intensity `0.16·crt/100`, and a slider that goes down to 0. Base grade `rgb=(rgb−0.55)·1.14+0.5`.
- **Font:** m6x11 (Daniel Linssen), used at 16/32/48.
- **Origin:** LocalThunk said "I don't really care very much about poker." The theme is an onboarding wrapper around Big Two.
- **Transfer:** take the *fixed colour, fixed home, serialized reveal* grammar and apply it to the decision (equity vs needed), not the score. **The current build reuses Balatro's exact hexes** (`--red #fe5f55`, `--blue #009dff`, `--orange #fda200`, `--green #4bc292`), its swirl shader, card sway, bobbing logo and stacked-shadow buttons. That makes it a palette swap of Balatro, not a game inspired by it.

## Card Shark (Nerial; Nicolai Troshinsky and Arnaud De Bock; Devolver, 2022)
- **Decision:** tension comes from a timed physical input performed while someone is watching, not from visual effects. It runs on a suspicion meter with escalating stakes.
- **Look:** lit like Barry Lyndon (Kubrick, 1975). The table is the only lit object and the room falls off to brown-black. Flat hand-drawn art is lit in the engine.
- **Framing:** no UI boxes. Instructions are drawn onto the table as hand-drawn arrows.
- **Weakness:** long tutorials with thin explanations. The coach must avoid this.
- **Transfer:** "2am back room" is a lighting problem before it is a UI problem. Use one warm pool of light.

## Inscryption (Daniel Mullins Games / Devolver, 2021)
- **Decision:** state lives on the table as objects. Damage is teeth on a brass scale, and the scale's tilt is the score. You read who is winning in under 100ms without reading a digit.
- **Look:** Act 1 has sodium-orange candlelight against green-black, with heavy vignette. Act 2 switches to SNES-style pixel art.
- **Numbers:** single glyphs painted into the card corners. Mullins: "forgoing text on the card" for legibility at low resolution.
- **Transfer:** one diegetic gauge for the one comparison that matters. Cut text before you shrink it.

## Luck be a Landlord (TrampolineTales, 2023)
- **Decision:** one number that is always on screen and always a threat: "$X due in N spins."
- **Framing:** a hard-edged square grid with 1px dividers and no rounded containers.
- **Numbers:** each symbol pops its value in sequence, then the values sum. It is Balatro's serialization done more cheaply.
- **Transfer:** the to-call amount is our "rent due." It should be the largest money figure on screen when it's your turn.

## Slay the Spire (Mega Crit, 2019)
- **Decision:** card type is encoded in the shape of the art window (pointed for Attack, rectangular for Skill, oval for Power). Rarity is the frame colour.
- **Numbers:** energy sits in an orb that breaks out of the frame. Enemy *intent* (an icon plus a number) floats over each enemy before you commit.
- **Transfer:** each bot's last action and its bet sit at its seat, visible before the hero acts.

## Cobalt Core (Rocket Rat Games / Brace Yourself Games, 2023)
- **Decision:** projected outcomes are drawn on the board before you commit. Card tint shows which pilot owns the card.
- **Transfer:** project the decision onto the table. The needed-equity notch is drawn on the gauge before the equity fill arrives.

## Dicey Dungeons (Terry Cavanagh; art by Marlowe Dobbe; music by Chipzel, 2019)
- **Decision:** the rule is the slot's silhouette. A socket shows exactly what it accepts.
- **Framing:** chunky cardboard cards with 3–4px dark outlines and a flat offset drop. No gradients.
- **Transfer:** constraints are shown through shape, as in la pinta borders on cards and the notch on the gauge.

## Peglin (Red Nexus Games, 2022 → 1.0 in 2024)
- **Decision:** damage is earned visibly into a counter during the shot and only released after it. The gap between earning and applying creates the tension.
- **Transfer:** the pot ticks up as chips slide in instead of jumping to the new total.

## Shotgun King: The Final Checkmate (PUNKCAKE Délicieux, 2022)
- **Decision:** a near-monochrome board with one alarm colour. Threats are marked on the squares themselves. The exact palette is unverified, so sample screenshots.
- **Transfer:** a restrained base palette lets one red carry every mistake.

## Pentiment (Obsidian; Josh Sawyer; art director Hannah Kennedy, 2022)
- **Decision:** the typeface tells you who is speaking.
- **Transfer:** the coach and the table must not share a voice. We separate them by ink and surface: the coach is cool ink on a cool sheet out of the lamplight, and the table is lamp-lit cream.

## Buckshot Roulette (Mike Klubnika, 2023)
- **Decision:** one overhead lamp, a black room, and a table game where you can feel the stakes. It is the closest emotional reference for "tense."
- **Transfer:** the room *is* the background. The darkness is the design.

## Papers, Please (Lucas Pope, 2013)
- **Decision:** a dull, limited palette, information delivered as physical documents, and tension from stillness plus a clock. Grades are ink stamps.
- **Transfer:** the Hand Review is a document, and its grades are red-pen marks and stamps.

## itch.io pixel poker (pazoff/poker, kudanagwatidzo Texas Hold'em II Turbo, okutasan / realrogue asset kits)
- **Pattern:** asset-pack quality: a flat green oval, stock chip sprites and default boxes. The best rules implementation (pazoff, three AI levels plus beginner help) doesn't commit to pixel art at all.
- **Gap:** no pixel Hold'em treats **decision legibility** as its hero. That niche is open.

---

## Cross-cutting

| Problem | Best-in-class answer | Source |
|---|---|---|
| Panels without slate boxes | Zero-blur lip, inset wells, or no panels at all (info on the table) | Balatro, Inscryption, Card Shark |
| Critical numbers | One fixed colour per quantity, a fixed home, serialized reveal at 150–400ms per step | Balatro, LBaL, Peglin |
| Tension | One lit pool, a threat number that's always visible, a telegraph before you commit | Card Shark, Buckshot, LBaL, StS |
| Teaching | Constraints shown as shape; the teacher has a different voice | Dicey Dungeons, Pentiment |
| What not to take | m6x11, Balatro's hexes, swirl shader, rotational wobble, card sway | Balatro (anti-goal 3) |
