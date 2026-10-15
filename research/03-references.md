# 03 — References

One line each: why the source matters. Claims marked (unverified) were not re-checked this session.

## Games
- https://store.steampowered.com/app/2379780/Balatro/ : the quality bar. Fixed-colour numbers in fixed wells, scoring revealed step by step.
- https://www.playbalatro.com : the reference named in CONTRACT.md.
- https://github.com/idkhan/Balatro3DS/blob/main/globals.lua : Balatro's `G.C` colour table. Proves the current build copies its hexes.
- https://github.com/idkhan/Balatro3DS/blob/HEAD/engine/moveable.lua : the `juice_up` curve: 0.4s, sin 50.8/40.8, cubic and quadratic decay.
- https://github.com/Steamodded/smods/blob/main/src/game_object.lua : CRT uniforms. Shows the effect is subtle and has a slider.
- https://github.com/PortsMaster/PortMaster-New : the CRT-off patch shows the base 1.14 contrast grade.
- https://www.devolverdigital.com/games/card-shark : one candle-lit pool; being watched creates the tension.
- https://www.troshinsky.com/cardshark.html : Troshinsky on the art direction.
- https://www.historyhit.com/gaming/hustle-king-louis-in-nerials-picaresque-card-shark/ : Barry Lyndon and monotype as references; flat art lit in the engine.
- https://store.steampowered.com/app/1092790/Inscryption/ : the scale as the score; the table as the interface.
- https://www.gamedeveloper.com/design/how-game-jam-sacrifices-became-inscryption : Mullins on dropping text to keep low-res cards legible.
- https://gdcvault.com/play/1027609/Independent-Games-Summit-Sacrifices-Were : Inscryption post-mortem (paywalled, unverified).
- https://store.steampowered.com/app/1404850/Luck_be_a_Landlord/ : one threat number that never leaves the screen.
- https://store.steampowered.com/app/646570/Slay_the_Spire/ : intents shown above enemies; card type read from frame shape.
- https://store.steampowered.com/app/2179850/Cobalt_Core/ : outcomes telegraphed before you commit.
- https://store.steampowered.com/app/861540/Dicey_Dungeons/ : slot silhouettes show the rule; flat cardboard cards.
- https://store.steampowered.com/app/1296610/Peglin/ : damage held back, then released.
- https://store.steampowered.com/app/1972440/ : Shotgun King, a monochrome board with one alarm colour.
- https://store.steampowered.com/app/1205520/Pentiment/ : the typeface tells you who is speaking.
- https://store.steampowered.com/app/2835570/Buckshot_Roulette/ : one lamp over a black room. The closest match to "tense".
- https://papersplea.se : still, document-based, stamps as feedback.
- https://itch.io/games/top-rated/free/tag-pixel-art/tag-poker : current pixel poker. Confirms nobody treats the decision as the hero.
- https://pazoff.itch.io/poker : the best rules implementation found; not pixel art.

## Interviews and press
- https://rogueliker.com/balatro-interview/ : "poker theme… mainly as an onboarding tool"; the appeal is how the cards feel to handle.
- https://toucharcade.com/2024/03/18/balatro-interview-mobile-port-localthunk-dlc-plans-updates-new-jokers-demo-feedback/ : Big Two as the origin.
- https://www.pcgamer.com/games/localthunk-gave-up-making-balatro-for-3-months-but-resumed-because-i-was-bored-but-the-internet-was-out-so-i-couldnt-play-rocket-league/ : the juice was the first thing built after the break.
- https://www.pcgamer.com/card-shark-is-a-love-letter-to-historys-best-tricksters-scammers-and-cheats/ : suspicion meter and escalating consequences.
- https://gameinformer.com/review/card-shark/bad-luck-at-the-tables : long, thin tutorials. The failure mode to avoid.
- https://www.gamedeveloper.com/design/breaking-the-nes-for-shovel-knight : keep the limits that help, break the ones that cost readability.

## Craft and rendering
- https://developer.mozilla.org/en-US/docs/Web/CSS/image-rendering : `pixelated` also applies to border-image, which lets 9-slice frames work.
- https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled : reset this after every resize.
- https://forums.tigsource.com/index.php?topic=40832.0 : Lucas Pope's Obra Dinn dithering devlog (Bayer vs blue noise).
- http://aleclownes.com/2017/02/01/crt-display.html : the common CSS CRT. A starting point not to ship as-is.
- https://emulation.fandom.com/wiki/CRT_Geom : scanline weight ≤ 0.4.
- https://steamcommunity.com/app/2379780/discussions/0/4357869219923111864 : Balatro players asking to turn the CRT off.

## Fonts
- https://departuremono.com : Departure Mono (Helena Zhang, SIL OFL 1.1), 11px native, monospace. **Chosen face.**
- https://managore.itch.io/m6x11 : m6x11. Rejected because it is Balatro's font.
- https://datagoblin.itch.io/monogram : monogram (CC0). Considered as a second voice and rejected; one face wins.
- https://www.dafont.com/pixel-operator.font : Pixel Operator (CC0 per author). Backup choice.
- https://fonts.google.com/specimen/Press+Start+2P/about : rejected; it is the most recognizable "AI pixel game" font.
- https://kottke.org/plus/type/silkscreen/ : Silkscreen. Rejected; it is the current build's tiny-caps tell.
- https://fonts.google.com/specimen/Pixelify+Sans : the current face. An outline font imitating pixels, smeared at sizes off the pixel grid.

## Palettes
- https://lospec.com/palette-list/apollo : ramps whose hue shifts. Source for the felt and rail ramps.
- https://lospec.com/palette-list/endesga-32 : a colder felt alternative.
- https://lospec.com/palette-list/lost-century : nicotine paper tones for card faces and the review sheet.
- https://lospec.com/palette-list/resurrect-64 : a teal felt alternative.

## Juice and feel
- https://www.youtube.com/watch?v=AJdEqssNZ-U : Nijman, "The Art of Screenshake". Permanence and sleep (hitstop).
- https://www.youtube.com/watch?v=Fy0aCDmgnxg : Jonasson & Purho, "Juice it or lose it".
- https://www.gdcvault.com/play/1023557/Math-for-Game-Programmers-Juicing : Eiserloh. Shake proportional to trauma², driven by Perlin noise.
- https://dev.to/saltmire/godot-4-screen-shake-and-hit-stop-in-one-script-11eh : hitstop rule of thumb, 40–180ms.

## Poker trainers
- https://help.gtowizard.com/measure-performance/ : the five-step grade ladder; EV loss as % of pot.
- https://help.gtowizard.com/how-to-use-the-trainer/ : coach speaks only when the game pauses; "close" hands.
- https://help.gtowizard.com/ranges-tab/ : the equity graph convention.
- https://www.pokernews.com/strategy/how-to-calculate-pot-odds-42847.htm : required equity = call ÷ pot after call.
- https://pokerfuse.com/features/reviews/review-poker-snowie-promises-perfect-gameplay-training-with-new-gto-based-learning-software-01-10/ : error and blunder grading.
- https://pokerfuse.com/news/poker-room-news/221052-wsop-deploys-new-table-layout-pa-ahead-software/ : WSOP redesign complaints (red text, missing info). Anti-reference.
- https://www.pokerlistings.com/enjoy-the-shiny-new-table-design-and-features-at-juicy-stakes-poker : hand strength shown at the point of decision.
- https://www.zynga.com/games/zynga-poker/ : anti-reference for casino gloss.

## Outside games
- https://www.lybrary.com/scarnes-new-complete-guide-to-gambling-p-749.html : Scarne. Diagram plates with callouts, for the tutorial.
- https://drf.uky.edu/catalog/1950s/drf1957062501/drf1957062501_30_1 : DRF on reading past performances: dense one-line history.
- https://c2055.cloudnet.se/en/daily-racing-form-symbols.html : DRF symbol key.
- https://en.wikipedia.org/wiki/American_Totalisator : tote boards. Pot odds shown as a price ("3.0–1").
- https://pinside.com/pinball/machine/miss-annabelle/details : Gottlieb's "score to beat" card. Equity to beat.
- https://homepinballrepair.com/em-score-reels-gottlieb/ : EM reels step one digit per pulse with a visible carry.
- https://en.wikipedia.org/wiki/Split-flap_display : Solari flap timing, for street headers (not used in v1).
- https://data.fitzmuseum.cam.ac.uk/id/object/225187 : la pinta. A gap in the border frame encodes the suit.
- https://en.wikipedia.org/wiki/Ace_of_spades : "Old Frizzle", the duty ace. The one ornate card.
- https://www.i-p-c-s.org/wp/the-ace-of-spades/ : duty ace history.
- https://wopc.co.uk/hungary/seasons : the Seasons pattern; scene aces.
- https://www.artofthetitle.com/title/casino/ : the Bass Casino titles. Flat cut-paper silhouettes for the title screen.
- https://en.wikipedia.org/wiki/Neon_Museum : chasing-bulb borders, used only on all-in.
- https://special.library.unlv.edu/node/1429 : UNLV matchbook covers. Two flat inks.
