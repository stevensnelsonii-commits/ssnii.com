# DROP ZONE — sound manifest (fix-it-all §4, 2026-11-10)

Every clip in this folder is a REAL recording from Steve's studio audio
catalogue (index: `~/workspace/your_files/audio-library/audio-index-2026-11-10.csv`,
sources on kickass under `C:\Users\steve\prime-assets\`), trimmed/converted
with ffmpeg to mono 22.05 kHz Ogg Vorbis. Total payload: **355,781 bytes
(0.34 MB)** — budget was ≤ 4 MB.

**Licensing:** all clips are OvaniSound packs. OvaniSound terms permit
production use inside the game; the library is **NEVER for AI training**
(Steve's standing tag). No OneDrive personal-listening material was used.
Synthesized WebAudio blips remain only as a fallback if a clip fails to load.

| Clip | Game event(s) | Exact catalogue source |
|---|---|---|
| select.ogg | tile select, squad pick | `C:\Users\steve\prime-assets\dataset\raw\OvaniSound-Extracted-All-HB\Building Tycoon Sound FX Pack\Building Tycoon Sound FX Pack\Non Loops\Selection\Building Select Brick A.wav` |
| deselect.ogg | squad deselect, cancel | `...\Building Tycoon Sound FX Pack\Building Tycoon Sound FX Pack\Non Loops\Selection\Building Select Brick C.wav` |
| confirm.ogg | move ordered, placement, turn end | `...\Building Tycoon Sound FX Pack\Building Tycoon Sound FX Pack\Non Loops\Building\Basic Placement A.wav` |
| denied.ogg | grounded denial, any refusal | `...\Building Tycoon Sound FX Pack\Building Tycoon Sound FX Pack\Non Loops\Warnings\Warning A.wav` (trim 0.9s) |
| raid.ogg | raid incoming warning | `...\Building Tycoon Sound FX Pack\Building Tycoon Sound FX Pack\Non Loops\Warnings\Disaster Warning A.wav` (trim 1.8s) |
| fanfare.ogg | chart fragment earned, settlement tier up | `...\Building Tycoon Sound FX Pack\Building Tycoon Sound FX Pack\Non Loops\Notifications\City Level Up A.wav` (trim 2.6s) |
| success.ogg | extraction complete, good report | `...\Combos Crits and Fails Sound FX Pack\Combos Crits and Fails Sound FX Pack\Misc Template\Success Level A.wav` |
| door.ogg | bunker door / heavy hatch opened | `...\Motion & Impacts Sound FX Pack Vol. 2\Motion and Impacts Sound FX Pack Vol. 2\Impacts\Impact Magic Lock 001.wav` (trim 1.1s) |
| device.ogg | recon bought, ground INTERACT | `...\Player Status Sound FX Pack\Player Status Sound FX Pack\Sci-Fi\Sci-Fi Device Use 001.wav` |
| refill.ogg | refuel from cargo | `...\Player Status Sound FX Pack\Player Status Sound FX Pack\Sci-Fi\Sci-Fi Meters Refill 001.wav` (trim 1.2s) |
| powerup.ogg | settlement founded | `...\Player Status Sound FX Pack\Player Status Sound FX Pack\Sci-Fi\Sci-Fi Power Up-001.wav` (trim 1.4s) |
| readyfly.ogg | drop launched, extraction liftoff | `...\Player Status Sound FX Pack\Player Status Sound FX Pack\Sci-Fi\Sci-Fi Ready To Fly 001.wav` (trim 1.4s) |
| whoosh.ogg | airship in transit, descent skip | `...\Motion & Impacts Sound FX Pack Vol. 2\Motion and Impacts Sound FX Pack Vol. 2\Whoosh\Whoosh Air Vibe 001.wav` (trim 1.3s) |
| fire.ogg | FIRE (shot) | `...\Combos Crits and Fails Sound FX Pack\Combos Crits and Fails Sound FX Pack\Gun\Gun Combo A.wav` |
| firehit.ogg | FIRE hits | `...\Combos Crits and Fails Sound FX Pack\Combos Crits and Fails Sound FX Pack\Gun\Gun Crit A.wav` (trim 0.9s) |
| firemiss.ogg | FIRE misses | `...\Combos Crits and Fails Sound FX Pack\Combos Crits and Fails Sound FX Pack\Gun\Gun Fail A.wav` |
| punch.ogg | machine/raider melee hits a diver | `...\Combos Crits and Fails Sound FX Pack\Combos Crits and Fails Sound FX Pack\Punch\Punch Crit A.wav` |
| siren-attack.ogg | Siren melee bite lands | `...\Mutated Beings Sound FX Pack\Mutated Beings Sound FX Pack\Mutant\Labspawn Attack 001.wav` (trim 1.2s) |
| shriek.ogg | Siren ranged shriek attack | `...\Animals Sound FX Pack\Animals Sound FX Pack\Non Loops\Birds Single\Parrot Screech A.wav` |
| wingbeat.ogg | Siren flying move/attack | `...\Animals Sound FX Pack\Animals Sound FX Pack\Loops\Big Bird Wings Loop A.wav` (excerpt 1.2s) |
| siren-death.ogg | hostile down (Siren/machine/raider) | `...\Mutated Beings Sound FX Pack\Mutated Beings Sound FX Pack\Mutant\Labspawn Death 003.wav` (trim 1.6s) |
| wound.ogg | diver wounded | `...\Player Status Sound FX Pack\Player Status Sound FX Pack\Ailments\Ailments Bleed 001.wav` (trim 0.9s) |
| death.ogg | diver death | `...\Motion & Impacts Sound FX Pack Vol. 2\Motion and Impacts Sound FX Pack Vol. 2\Impacts\Impact Fatality 001.wav` (trim 1.6s) |
| thunder.ogg | descent lightning near-miss/strike | `...\Seafaring Sound FX Pack\Seafaring Sound FX Pack\Non Loops\Environment\Distant Thunder Short A.wav` (trim 2.4s) |
| touchdown.ogg | descent touchdown, brutal landing | `...\Motion & Impacts Sound FX Pack Vol. 2\Motion and Impacts Sound FX Pack Vol. 2\Impacts\Impact Heavy Tom 001.wav` (trim 1.2s) |
| step.ogg | ground move step | `...\Animals Sound FX Pack\Animals Sound FX Pack\Non Loops\Steps\Horse Step Grass A.wav` |
| loot.ogg | loot pickup, cache gathered | `...\Decks and Cards Sound FX Pack\Decks and Cards Sound FX Pack\Coins\Treasure Box 001.wav` |
| coin.ogg | fuel cell lifted, cargo gains | `...\Decks and Cards Sound FX Pack\Decks and Cards Sound FX Pack\Coins\Bet Placed 001.wav` |
| crowd.ogg | settlement ambience (loop) | `...\Crowds Sound FX Pack\Crowds Sound FX Pack\Loops\Hall Murmur Loop.wav` (excerpt 8s) |

## Ambience architecture (2026-11-12 — layered loops, one master)

Steve: "Sound off doesn't work. The background loop is jarring. Build a
layered sound that loops." sfx.js now runs ONE AudioContext with ONE
master gain; ambience, one-shots and fallback blips all flow through
it. Mute = master gain 0 + context suspended (the stored pref is read
at load, before any audio). Ambience is layered sets of decoded
buffers, each loop baked with an equal-power crossfade at the seam
(2 s wind beds, 3 s crowd), layers at different lengths so the
combination never repeats obviously:

| Set | Layers (file · gain · loop after bake) |
|---|---|
| map-ambience | wind-loop · 0.50 · 4 s + descent-loop · 0.15 · 3 s |
| descent-loop | descent-loop · 0.55 · 3 s + wind-loop · 0.30 · 4 s |
| settlement-loop | crowd · 0.45 · 5 s + wind-loop · 0.22 · 4 s |

Performance: buffers decode once and cache; ≤2 ambience sources + a
capped handful of one-shots; no per-frame nodes; no streaming; the
context suspends when muted or the tab is hidden.
| wind-loop.ogg | map ambience + ship transit (loop) | `...\Seafaring Sound FX Pack\Seafaring Sound FX Pack\Loops\Ship Sailing Medium Loop.wav` (excerpt 6s) |
| descent-loop.ogg | descent wind rush (loop) | `...\Seafaring Sound FX Pack\Seafaring Sound FX Pack\Loops\Ship Sailing Fast Loop.wav` (excerpt 5s) |
| plant.ogg | glow-plant tentacle attack | `...\Mutated Beings Sound FX Pack\Mutated Beings Sound FX Pack\Mutant\Disgusting Spit 001.wav` (trim 1.0s) |
| flash.ogg | flashbang detonation | `...\Motion & Impacts Sound FX Pack Vol. 2\Motion and Impacts Sound FX Pack Vol. 2\Impacts\Impact Gravi Blast 001.wav` |
| flare.ogg | flare ignites / burning zone | `...\Animals Sound FX Pack\Animals Sound FX Pack\Non Loops\Reptiles\Snake Hiss A.wav` (trim 1.2s) |

(`...` = `C:\Users\steve\prime-assets\dataset\raw\OvaniSound-Extracted-All-HB` — full
paths verified against the CSV index rows for each filename on 2026-11-10.)
