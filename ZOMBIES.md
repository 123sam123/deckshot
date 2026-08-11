# ZOMBIES — design & build plan (full rewrite)

The SURVIVAL mode shipped in `e712dc4` is deleted and rebuilt from scratch on
this branch. The goal, verbatim from the brief: *as close to Black Ops Zombies
as possible, light and clean so friends can play together without lag, wall
buys, revives, escalating rounds, unlockable sections, kept separate from the
competitive modes.*

Everything below is the plan. Values marked **[pinned]** get a test.

---

## 1. What was wrong with the old mode (and the fix)

| Old failure | Rebuild |
|---|---|
| Zombies had no animation at all — a static 0.12 rad slump, no walk cycle, no attack wind-up, no death | Instanced horde renderer with procedural walk/lunge/collapse cycles |
| 24 zombies × 7 meshes = **168 draw calls** | One `InstancedMesh` per body part ≈ **9 draw calls for the whole horde** |
| Zero zombie audio | Synth groans/attacks/deaths + round stingers + buy/perk/power-up cues |
| Every door purchase threw away and rebuilt the whole merged world + collision BVH (a visible hitch, 6-7×/match) | Static geometry built once; doors are individual meshes toggled by zone mask; only the collision BVH rebuilds |
| Power-ups applied squad-wide invisibly the moment a zombie died | Real pickup entities: spinning emissive drops you walk over |
| No window barriers — zombies just popped out of spawner points | Boarded windows: zombies tear planks, players hold F to rebuild for points, Carpenter power-up now exists |
| All five perk machines in one room | Perks distributed one-per-zone across the map |
| Economy = trickshot score × 0.5 (opaque, swingy) | Canon flat payouts: 10/hit, 60/kill, 100/headshot, 130/knife |
| Zombies froze mid-map when the whole squad was down | They shamble away toward the horizon while a self-revive pends |
| Uniform zombie speed per round | Mixed cohorts per round (walkers/joggers/runners), canon-style |
| Four survival guns borrowed two viewmodel rigs | Kept (cosmetic; recorded gap — not worth the scope) |

## 2. Mode identity

- `GameMode.Zombies = 2` (same wire value as old Survival; TS member renamed).
- 1–4 players **[pinned]** (canon squad size; old cap was 5), min 1, no quick-play
  matchmaking into it, joiners come by invite code. Late joiners allowed.
- Pistol start: Kestrel + knife, 500 points **[pinned]**.
- No respawn button: bleed out → spectate → return at the next round.
- Match ends only on squad wipe. `MatchOver` shows rounds survived.
- UI label: **ZOMBIES**. Map: **SHIPBREAK**.

## 3. The map — SHIPBREAK (`shared/shipbreak.ts`, `MapId.Shipbreak = 1`)

A shipbreaker's yard at dusk: a beached freighter being cut apart, gantry
crane, container rows, workshop, flooded drydock basin. Same brush/material
vocabulary as Sundeck so all materials, ocean, sky and footstep audio work
with zero new art. Water level well below deck; denser fog + low amber sun for
mood (fog pulled in via a renderer hook, competitive maps unchanged).

Seven zones, six doors, ~10 barrier windows, three deck levels:

| Zone | Name | Door cost | Needs power | Contents |
|---|---|---|---|---|
| 0 | Quarterdeck (spawn) | — | — | 3 windows, wall buy Osprey 500 |
| 1 | Cargo Hold | 750 (from 0) | no | 2 windows, wall buy Shrike 900, box spot A |
| 2 | Gangway | 750 (from 0) | no | 1 window, wall buy Harrier 1200, perk ADRENALINE |
| 3 | Engine Room | 1000 (from 1) | no | 1 window, **POWER SWITCH**, perk BULWARK |
| 4 | Breaker's Yard | 1000 (from 2) | no | 2 windows, wall buy Condor 1750, box spot B, perk SECOND WIND |
| 5 | Workshop | 1250 (from 3 or 4) | no | 1 window, wall buy Talon 1400, perk HANDLOADER |
| 6 | Drydock Basin | 1750 (from 5) | **yes** | THE FORGE (pack-a-punch), perk HAIR TRIGGER |

Total unlock 6500 **[pinned]**. Progression gate: power lives in zone 3, the
Forge zone needs power. The Yard (4) is the open "run a train" loop; the Hold
is the tight container maze. Nav graph hand-authored (~50 nodes), validated by
tests: dense ids, bidirectional edges, every node inside its zone's boxes,
unlock connectivity zone-by-zone, every door brush id exists **[pinned]**.

**Windows** are map data: `{ zone, outsideNode, insideNode, blockerBrushId,
plankAnchor pos/yaw }`. The blocker brush blocks *players* only (new
`blocksZombies: false` flag on Brush, penetrable to bullets, never rendered —
zombie locomotion sweeps a filtered brush set). Zombies spawned at outside
spawners path to the window, tear planks (1 per 1.2 s), walk through at 0.
Players near the inside face hold F: +1 plank per 0.8 s, +10 points each,
repair income capped at 100/round **[pinned]**. Max 6 planks **[pinned]**.

## 4. Rounds (`shared/zombies.ts`)

- Health: `150 + 100·(r−1)` through r9, then `×1.1` per round, cap 100 000
  **[pinned: r1=150, r9=950, r10=1045]** (canon curve).
- Count: `floor((6 + 0.85r + 0.075r²) · mult(players))`, mult = 1 / 1.55 /
  1.95 / 2.3 **[pinned: solo r1=6, r10=22, r20=53]**. Alive cap 24; the rest
  queue on a spawn budget.
- Spawn interval: `max(0.35, 2.2 − 0.06r)` s.
- Speed cohorts rolled per spawn (seeded): walkers 1.7, joggers 3.0, runners
  4.6 m/s; runner fraction `clamp(0.09(r−3), 0, 0.75)`, joggers grow from r2.
- **Blood Fog** every 5th round from r5: sprinters at 6.2 m/s, health ×0.35,
  red-shifted fog + drone stinger **[pinned: fog rounds are 5,10,15…]**.
- Intermission 10 s (first round starts after 3 s). Round number + stinger on
  transition; Max Ammo is NOT guaranteed (canon), only the 2% drop table.

## 5. Economy (`shared/zombies.ts`) — canon flat payouts

Hit 10 · kill body +60 · headshot kill +100 · knife kill +130 · plank +10 ·
revive +50 · Nuke +400 each **[all pinned]**. Double Points doubles all of it.
Points are per-player, u32, mirrored into `score` for the scoreboard.
Trickshot flags still show in the feed for style, but pay nothing (deliberate
break from the old mode; the killfeed itself is hidden in Zombies — canon HUD).

Spending: doors (table above), wall guns (Osprey 500 / Shrike 900 / Harrier
1200 / Talon 1400 / Condor 1750, ammo refill = half, forged ammo = 4500),
mystery box 950, perks below, Forge 5000 **[pinned]**.

## 6. Perks — one machine per zone, power required, max 4, lost on down

| Perk | Cost | Effect |
|---|---|---|
| BULWARK | 2500 | max health 100 → 250 |
| HANDLOADER | 3000 | reload times ×0.5 |
| SECOND WIND | 1500 (solo 500) | revive others ×2 speed; solo: 3 auto self-revives (10 s) |
| ADRENALINE | 2000 | move speed ×1.07 (walk/sprint/crouch), via a new optional `PlayerState.speedMult` applied identically in shared movement on both sides |
| HAIR TRIGGER | 2000 | damage ×2 |

`accuracyLockAt` stays 0.82 and untouchable, as ever **[pinned]**.

## 7. Mystery box & THE FORGE

Box: 950/spin, pool = the five primaries, offer stands 12 s, seeded 4–8 spins
per location then it relocates to the other spot. Forge: 5000, per-weapon
upgrade (bitmask per player per WeaponId): damage ×2, mag ×2, reserve ×2,
free refill on purchase. Headshot multiplier vs zombies ×2.5. Insta-Kill 1e6
**[pinned: r1 Talon headshot one-shots; r9 needs Forge + HAIR TRIGGER]**.

## 8. Power-up drops (real entities now)

2% per kill, max 4 concurrent, despawn 30 s (blink last 8 s), pickup radius
1.2 m, effects squad-wide: **Max Ammo**, **Insta-Kill** 30 s, **Double
Points** 30 s, **Nuke** (kill all alive, +400 each), **Carpenter** (all
windows to 6 planks, +200 each). Replicated in the state message (kind + pos +
seconds); rendered as spinning emissive icons with pickup/expiry sounds.

## 9. Downs, revives, wipe

Lethal hit → last stand: health 1, prone crawl, pistol only, input mask
(Fire/ADS/Reload/Use kept) enforced by BOTH sides, bleedout 40 s, perks wiped.
Teammate holds F within 2 m for 3.75 s (1.9 s with SECOND WIND) → back at 50
HP, rescuer +50. Bleedout pauses while a revive is in progress. Bleed out →
dead until the next round starts, points kept, guns reduced to pistol. Squad
wipe (nobody standing, no pending self-revive) → MatchOver: "THE YARD KEEPS
YOU — ROUND N". While a solo self-revive pends, zombies disengage and wander.

## 10. Zombie AI (server)

Target: nearest standing player, repath 0.8 s (BFS on the nav graph, ≤4
repaths/tick staggered), direct-chase inside 10 m, window edges gated on plank
count, locomotion by capsule sweep against the zombie brush set (window
blockers excluded), step-up 0.5 / drop 2.0, no jumping. Attack: 0.35 s
telegraphed wind-up then 40 damage, 0.9 s cadence, 1.5 m reach — the wind-up
tick sets the entity's `firedThisTick` flag so the client plays the lunge.
Spawners ranked by distance to the squad, seeded pick from best 3, only in
open zones. All rng from `shared/rng.ts` seeded on (matchSeed, tick, slot).

## 11. Netcode (breaking payload changes; PROTOCOL_VERSION → 2.0.0)

Kept from the old wire design (it measured 7.1 KB/s against the 12 KB/s
budget): zombies are PlayerState-shaped snapshot entities, ids 200–227,
`TeamId.Bravo`, masked to `Position|Yaw|Flags` (~12 B); health never on the
wire; lag comp slots `MAX_PLAYERS..39`.

`ServerMessage.ZombiesState` (opcode 76, new payload, on change + 1 Hz):
round u16 · phase u8 · timeRemaining f32 · zombiesRemaining u16 · powerOn u8 ·
zoneMask u16 · boxLocation u8 · active effects (≤4 × [u8 kind, f32 secs]) ·
drops (≤4 × [u8 id, u8 kind, pos 3×u16, f32 secs]) · window planks (u8 count +
u4 per window, packed) · per-recipient: points u32, perks u8, bleedout f32,
selfRevives u8, forgedMask u8, held/stowed weapon u8×2, four ammo u16,
boxOffer u8, repairBudget u8. `ClientMessage.Purchase {kind,itemId}` /
`Interact {target}` keep opcodes 13/14. Bandwidth budget test updated: 4
players + 24 zombies + full window/drop state < 12 KB/s **[pinned]**.

## 12. Client

- **Horde renderer** (`client/src/gameplay/horde.ts`): one `InstancedMesh`
  per body part (head, torso, pelvis, 2×arm, 2×leg, jaw) + instanced emissive
  eyes ≈ 9 draw calls. Procedural shamble: per-zombie gait phase from id hash
  + distance walked; arms raised, head bob, lunge on the fired flag, 0.7 s
  collapse-and-sink on despawn (client-side corpse pool). Palette: rust-stained
  coveralls, pale heads, ember eyes readable at 60 m and in fog.
- **Doors** (`client/src/world/doors.ts`): door brushes rendered as
  individual meshes with a cheap dissolve on open; static world never rebuilt.
  Prediction collision world still swaps per zone mask (BVH rebuild only).
- **Barricades** (`client/src/world/barricades.ts`): 6 plank meshes per
  window, visibility from state, tear/repair audio + dust puff.
- **ZombiesHUD** (`client/src/ui/hud/ZombiesHUD.tsx`): big red round number
  (pulse on change), gold points with floating +N deltas, perk chips, power-up
  timers, window-repair/interact prompt, downed overlay with bleedout bar,
  revive progress ring, "X IS DOWN" callouts, zombies-remaining counter,
  POWER OFF chip. Killfeed hidden in this mode. MatchOver: rounds survived +
  per-player kills/points/revives.
- **Audio** (new synth recipes): `zombie_groan/attack/die`, `round_start`,
  `round_end`, `powerup_spawn/pickup/expire`, `buy`, `perk_jingle`,
  `door_open`, `plank_tear/repair`, `box_spin`, `forge_hum`, `revive_ok`,
  fog-round drone. Groans throttled to the nearest 3 zombies.
- Interact prompts, world swap, downed input mask, points popups wired in
  `main.ts` behind a single `zombiesActive` flag, same seams as before.

## 13. Performance budget

60 FPS on the `low` tier stays the bar: horde ≤ 9 draw calls + eyes, no
per-zombie materials, shadows off beyond 15 m, corpse pool ≤ 8, plank/door
meshes static, fog cheapens overdraw. Server: spawn/path stagger unchanged,
one collision rebuild per door (players) + one filtered set (zombies), no
allocation in the tick path. Net: ≤ 12 KB/s with 4 players + 24 zombies +
drops + windows, test-enforced.

## 14. What is deliberately NOT in scope

Grenades (the game has none), traps, buildables, wonder weapons, easter eggs,
hellhound entities (fog rounds reuse the standard body at sprint speed), 5th
player seat, per-weapon viewmodel rigs for the four survival guns.

## 15. Build order

1. Delete old mode (files + every integration branch, DECISIONS inventory).
2. Shared contracts: `shared/zombies.ts`, protocol/codec payloads, mapdef
   window/door vocabulary, `PlayerState.speedMult`, version bump.
3. SHIPBREAK map data + validation tests.
4. Server: `sim/zombies/` director + horde + room/lobby/server wiring.
5. Client: horde renderer, doors/barricades, main.ts wiring, weapons sync,
   ZombiesHUD, audio, landing/lobby copy.
6. Tests green (old suite + new), typecheck, build, manual browser run,
   DECISIONS.md/README/MAPS.md updates.
