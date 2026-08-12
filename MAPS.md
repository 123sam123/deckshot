# Maps

Deckshot ships five arenas. Two are original; three are **adaptations** of maps
from [Red Eclipse](https://www.redeclipse.net/), an open source arena shooter
whose content is released under free-culture Creative Commons licences.

| Map | Mode | Original | Author(s) | Project | Licence |
|---|---|---|---|---|---|
| **Sundeck** | FFA / TDM | — | — | Deckshot | original work |
| **Leviathan** | SURVIVAL | — | — | Deckshot | original work |
| **Death Trap** | FFA / TDM | *Death Trap* | Derek Stegall, Architect, Favorito, SniperGoth | Red Eclipse | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| **Hangar A482** | FFA / TDM | *Hangar inspection A482* | SniperGoth | Red Eclipse | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| **Unknown Rooftop** | FFA / TDM | *Unknown Rooftop* | SniperGoth | Red Eclipse | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

Author lines are quoted from each original map's own `.cfg` header in
[redeclipse/maps](https://github.com/redeclipse/maps). Red Eclipse's licence
terms are in [redeclipse.net/docs/License](https://www.redeclipse.net/docs/License):
content defaults to CC BY-SA 4.0-or-later, and commercial use and modification
are permitted for everything shipped with the game.

The map name and its credit line are shown **in game**, on the scoreboard and in
the lobby's map picker — not only here.

## What "adaptation" means

These are not conversions and they are not imports. **No geometry, texture,
model, sound or asset file from any original is present in this repository.**
Deckshot ships zero binary assets: every surface is procedural and every arena
is a list of oriented boxes in TypeScript.

What was taken is the *layout* — how a map plays. Each original's flow was read
off its own bot-waypoint graph (`.wpt`, the nav mesh Red Eclipse's bots walk),
which gives real walkable topology: lanes, room shapes, floor heights, where the
long crossings are. That was then rebuilt from scratch against Deckshot's
movement metrics, which are nothing like Red Eclipse's:

| | Red Eclipse | Deckshot |
|---|---|---|
| Vertical traversal | parkour, wall-runs, impulse boosts, jump pads | walking, a 0.4m step, a 1.05m jump apex, ramps |
| Map extent | ~100m across, 30m of vertical range | tens of metres, under 10m of vertical range |
| Weapons | full arsenal | one sniper, one sidearm, a knife |

So a faithful polygon conversion would be unplayable: most of an original's
space is only reachable by movement Deckshot does not have. Every height and
every run in the ported maps is walkable on foot, and each is checked by
`tests/maps.test.ts`, which drops a player at every spawn and simulates two
seconds to confirm they land on solid ground and stay in the world, then walks
nine named routes end to end.

Two originals are enclosed interiors stacked several levels deep. Deckshot has
one baked physically-based sky and no indoor lighting rig, so **both are two
levels and open to it**. That is not a shortcut, it is the constraint: the first
draft kept the third layer, and the result was maps you could not see in. Death
Trap's balcony ring roofed its entire ground floor into an unlit 3.3m tunnel you
spawned inside; Hangar's 4.6m hull walls turned it into a windowless grey crate
with a 10m hole at each end that dropped you in the sea two metres from a spawn.
Both were rebuilt lower and opener, and both play better for it.

The adapted map data in `shared/deathtrap.ts`, `shared/hangar.ts` and
`shared/rooftop.ts` is offered under **CC BY-SA 4.0**, the same licence as
the works it derives from. The rest of Deckshot is not affected: no GPL or
otherwise code-copyleft content was used, and none of these files is linked into
anything that would change its terms.

## The maps

### Sundeck — original *(FFA / TDM)*
A yacht at sea. Three lanes running its length: port and starboard walkways, a
pool spine down the middle, two cabins with a 4m corridor between them for the
cross-map shot, and catwalks overhead to drop off mid-air. 44m sightline.

### Death Trap — offshore rig *(FFA / TDM)*
Four-fold symmetric, two levels, open to the sky. The centre of the map is a
**hole**: a 2m-deep pit spanning 18m × 22m, with no floor at deck level. You can
see 48m clean across it from one spawn deck to the other — that is the cross-map
shot, and it runs under both bridge landings, which is why the four ramps are
held off the centreline. Crossing at floor level means the two pit ramps at x=0
or the side lanes at x=±12. A 27m bridge crosses the whole thing at y=3.3;
dropping off it into the pit is the airborne shot.

### Hangar A482 — cargo ship's weather deck *(FFA / TDM)*
A centre bulkhead splits the deck into two parallel 44m bays, joined by three
doorways, and guarantees the two lanes can never see each other. A walkway runs
along the top of it at y=3.5 and overlooks both at once — the strongest position
on the map, reachable only by the two end ramps, so taking it is a commitment.
One cargo stack per bay tops out at 2.6m for a 0.9m hop onto the spine through a
deliberate gap in its rail. 1.1m bulwarks all the way round: you see the sea
over them standing, hide behind them crouched, and cannot fall off anywhere.

### Leviathan — derelict liner *(SURVIVAL)*
The co-op map: eight purchasable zones, a nav graph, wall buys and zombie
spawners. Deliberately asymmetric, and every route through it is gated behind a
purchase — which is why it is the one map `competitive: false` excludes from the
lobby's picker, and why SURVIVAL is pinned to it.

### Unknown Rooftop — mountain temple *(FFA / TDM, land map)*
Deckshot's first map with no sea under it: a timber temple on stilts, 26m above
a wooded valley. A shrine sits in the middle with a doorway on all four sides; the two
end doorways line up, so tower-to-tower is a 48m shot threaded through a
building. The tile roof is walkable and sees both plank crossings at once. Every
railing on this map is penetrable, and the drop behind them kills.

## How it fits together

- `shared/mapdata.ts` — FROZEN. Sundeck's geometry, and the `Brush` /
  `SurfaceMaterial` / `BrushTag` vocabulary everything else is built from.
- `shared/mapdef.ts` — the `MapDef` type, the `MapId` enum, and the survival
  vocabulary (zones, interactables, spawners).
- `shared/brushkit.ts` — `b`, `mirrorX`, `mirrorZ`, `quad`, `sp`, `solvedRamp`.
- `shared/<map>.ts` — one file per arena.
- `shared/maps.ts` — the registry: `MAPS`, `COMPETITIVE_MAPS`, `mapById`,
  `mapForMode`, `worldForMap`, and `collisionBrushesFor` for Leviathan's doors.

## Adding a map

1. Write `shared/<id>.ts` exporting a `MapDef`. Build the geometry with the
   helpers in `shared/brushkit.ts` — the mirror helpers are what make the
   symmetry test pass by construction, and `solvedRamp` is what stops a ramp
   shipping with a lip you cannot climb.
2. Add a value to `MapId` and the map to `MAPS` in `shared/maps.ts`. **Append to
   `MapId`** — its value is the wire byte, so renumbering desynchronises an old
   client from a new server. Set `competitive: true` to make it pickable.
3. Run `npm test`. `tests/maps.test.ts` holds every competitive map to the same
   contract: Z-symmetry, brushes inside the bounds box, unique ids, spawns that
   are neither buried in geometry nor over a hole, a clear signature sightline,
   a settle simulation from every spawn, and nine walked routes.
4. **Fly it at eye level.** `npm run dev:client`, then open
   <http://localhost:5173/mapgen.html?map=2>. **M** cycles maps, **B** overlays
   the collision brushes, **X** sees them through walls, and
   `?cam=x,y,z,yaw,pitch` reproduces a shot exactly. This step is not optional —
   see the note below.

If the map is adapted from someone else's work, fill in `credit`. The lobby
picker and the scoreboard both read it, and an adapted map without one fails the
credit test.

## Why step 4 is not optional

Two of these maps once passed every physics test in the suite while being
unplayable. Death Trap had a 5m balcony ring that roofed its entire ground floor
into an unlit 3.3m tunnel you spawned inside. Hangar was a windowless grey crate
with 4.6m walls and a 10m hole at each end that dropped you in the sea two metres
from a spawn. Symmetry, spawn validity, a settle sim, a reachability flood-fill
and a 45,000-walk stuck sweep were all green on both.

None of that was a bad test. Simulation cannot see. Both maps were *correct* and
neither was playable, and one screenshot from standing height found what none of
it could.
