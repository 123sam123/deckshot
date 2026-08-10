# DECISIONS

Every ambiguous call made during the build, and why. Orchestrator decisions are
recorded here as they happen; agent decisions are folded in at integration.

## Phase 0 — architecture

**Original assets, original names.** The brief described this as a Black Ops 2
quickscoping lobby on the boat map. Nothing from that game is reproduced: the
map is an original yacht ("Sundeck") with an original layout, and weapons and
attachments have original names. The *design philosophy* is borrowed — a small,
symmetric, three-lane arena with a long central sightline and an elevated route
over it — because that is what makes the mode work, and layout philosophy is
not what gets a project taken down. The alternative (extracting real geometry
and audio) would make the game undistributable, which defeats the entire point
of a game whose core feature is sending a friend a link.

**No `shared/` dependency on any engine.** `shared/` is imported by both a
browser and a Node process. It contains no `three`, no `rapier`, no DOM, no Node
APIs — plain TypeScript only. This is what makes it possible for client and
server to run literally the same movement code, which is what makes prediction
work.

**Rapier was specified but movement does not use it.** The brief called for
Rapier on both sides. Rapier is a WASM library, and WASM float behaviour across
two different host environments is a bad foundation for the one guarantee this
game cannot compromise on: bit-identical client and server simulation. The
character controller is therefore a hand-written capsule sweep in
`shared/collision.ts` against static oriented boxes, which is fully
deterministic and, for a static 62m map with ~60 brushes, considerably faster
than a general-purpose physics engine. Rapier remains a dependency and is the
right tool if ragdolls or dynamic props are added later — those are client-only
cosmetics and do not need to be deterministic.

**`ws` instead of `uWebSockets.js`.** The brief allowed the fallback. uWS
installs from a GitHub tarball with prebuilt native binaries, which is a
recurring source of install failures across Node versions and architectures —
an unacceptable risk for a project whose deploy story is "one Docker build".
`ws` handles far more throughput than 12 players at 20Hz requires. If this ever
needs to scale to hundreds of concurrent lobbies per machine, revisit.

**One process, one port.** The Node server serves the built client statically
*and* the WebSocket endpoint. The client derives its socket URL from
`window.location`, so `http://localhost:8080` and `https://deckshot.fly.dev`
both work with zero configuration. This is what makes the invite link a single
URL with nothing to configure.

**No `@shared` path alias; relative imports with `.js` extensions everywhere.**
The server compiles under `NodeNext`, which requires explicit extensions; the
client runs through Vite, which resolves `.js` to `.ts` for local files. A path
alias would have needed separate configuration in tsc, vite, and vitest, and
would have given agents two conventions to confuse. One ugly convention that
always works beats two clean ones that sometimes don't.

**Contracts frozen before fan-out.** `shared/types.ts`, `shared/tuning.ts`,
`shared/protocol.ts` and `shared/mapdata.ts` were written in full before any
agent started, and agents were forbidden from editing them. Parallel agents
editing a shared schema is the failure mode that turns a fan-out into a merge
disaster. Changes had to be reported up instead.

**Waves, not one big fan-out.** The plan called for eight agents at once. They
were sequenced into dependency waves instead: the five agents with no
cross-dependencies first (movement, renderer, map, viewmodel/VFX/audio,
trickshot), then the three that consume their output (netcode, weapons,
lobby/UI). Eight agents writing simultaneously against interfaces that don't
exist yet produces eight piles of code that don't compile together.

**The map is data, once.** `shared/mapdata.ts` defines the level as an array of
oriented boxes. The renderer builds meshes from it; the physics builds colliders
from it. Neither is allowed to author geometry independently, so the thing you
see and the thing you collide with cannot drift. Decorative, non-colliding props
live separately in `client/src/world/props.ts`.

**Map symmetry is asserted by a test.** `assertSymmetric()` in mapdata fails if
any brush lacks its bow-to-stern mirror. In a mode where both teams spawn at
opposite ends of a boat, an asymmetric map is a balance bug that is very hard to
notice by eye and very obvious to a player who keeps losing.

## Tuning

**`accuracyLockAt = 0.82` is the game.** Fire before 82% of the ADS transition
and the shot takes a spread cone; fire after and it is a pinpoint ray. Everything
about how quickscoping feels comes out of this one number and `adsTime`. It is
isolated in `shared/tuning.ts` for exactly that reason. See TUNING.md.

**No aim assist, no mouse smoothing, no mouse acceleration.** Not configurable.
A quickscoping game with aim assist is a different, worse game.

**No air speed cap.** Strafe-jumping to build speed is left in deliberately.
Movement tech is most of the skill ceiling in this genre, and capping air speed
is the standard way to accidentally delete it.

**Fall damage off.** `FALL_DAMAGE_ENABLED = false`. The map's whole vertical
design encourages dropping off catwalks to take airborne shots; punishing that
would fight the mode.

## Wave 1 — decisions folded in from agents

**Vitest gets its own config file.** `vite.config.ts` sets `root: 'client'` for
the client build, and vitest inherits that root, so it scanned `client/` and
found no tests. A separate `vitest.config.ts` takes precedence and pins the test
root to the repo root. Found by the trickshot agent; it would have broken test
discovery for every agent in the project.

**The score limit counts kills, not trickshot points.** `FFA_SCORE_LIMIT` is 30
while a single stylish kill can be worth 1000+ points, so the limit can only
sensibly be a kill count. Trickshot points rank the scoreboard; kills end the
match.

**`onKill` is called once per bullet, not once per victim.** A collateral is one
call carrying multiple victims. Calling per-victim would double-count kills and
award the collateral bonus twice.

**`timeSinceAccuracyLock` is a rising-edge stopwatch**, reset to `Infinity` when
the player leaves ADS — not a running measure of time spent above the accuracy
lock. This is the distinction between "flicked in and shot" (a quickscope) and
"held the scope for ten seconds" (not one). If the weapons module implements the
running version instead, quickscope detection silently dies. This constraint was
passed explicitly to the weapons agent in Wave 2.

**`teamScores` is `[Alpha, Bravo]`, not indexed by `TeamId`.** The protocol
documents `RoundStateMsg.teamScores` as "index by TeamId", but `TeamId.Alpha = 1`
and `Bravo = 2`, so a 2-tuple indexed literally is off by one. Convention is
positional. Frozen contract, so the comment is wrong rather than the code — noted
here rather than edited.

**Draws** are encoded as `TeamId.None` for a tied TDM and `TeamId.FFA` for FFA,
since `MatchOverMsg` has no explicit draw representation.

**`JUMPSHOT_WINDOW = 0.4s`** lives in `shared/trickshot.ts` rather than
`shared/tuning.ts`, because tuning was frozen without it and it is the only
trickshot constant that was missing.

**Brush rotation order is yaw-about-+Y then pitch-about-local-X** (Three's
`'YXZ'` Euler order), and `brushMatrix()` in `client/src/world/brushes.ts` is the
reference implementation. Collision must match it or the ramps will be walkable
in a different place than they are drawn. This is currently latent rather than
live: every brush in `mapdata.ts` has `yaw === 0`, and with a single non-zero
rotation the order is irrelevant. It becomes real the moment anyone adds a brush
with both a yaw and a pitch.

**Planar reflection instead of SSR on the ocean.** Screen-space reflection needs
the depth buffer and the postfx composer, which the renderer owns; the ocean is
built by a different agent that is correctly forbidden from constructing a
renderer. A quarter-resolution planar reflection with oblique-plane clipping
renders through the ocean mesh's `onBeforeRender`, needs nothing from the
composer, and at this scene scale is cheaper and cleaner. Water colour is
likewise analytic (signed distance to the hull footprint) rather than
depth-buffer driven.

**`buildWorld(scene, materials?)` — materials is optional.** INTEGRATION.md
contracted `buildWorld(scene)`; the world agent shipped a superset with the
material registry optional and a full procedural fallback, so the world renders
correctly whether or not the renderer's registry exists. Keeping the superset:
it removed a hard ordering dependency between two concurrent agents at zero cost.

**`assertSymmetric()` has a known blind spot.** Its key ignores yaw/pitch sign,
so it would pass a mirrored pair of yawed brushes that are actually asymmetric.
Correct for the current brush set (all yaw zero); worth tightening if the map
grows rotated geometry.

**The sky is baked to an environment map once at load.** A single PMREM capture
of the Preetham sky drives image-based lighting for every PBR material in the
scene. This one decision is most of why the materials read as expensive rather
than plastic, and it costs one render at startup instead of anything per-frame.

**Cascaded shadow maps require patching every lit material.** Three's CSM addon
needs a per-material shader patch, and unpatched materials get lit three times
over (once per cascade) — visibly blown out. `Lighting.update()` sweeps the
scene once per new object, WeakSet-guarded, chaining any existing
`onBeforeCompile`. Opt out with `material.userData.csmIgnore = true`; custom
`ShaderMaterial`s (the ocean) are left alone.

**Shadow casting is automatic and radius-limited.** Lit meshes receive shadows;
only meshes with a bounding radius under 25m cast them. Large geometry like the
ocean plane would otherwise consume the whole shadow budget for no visual gain.
Opt out with `object.userData.noShadow = true`.

**A third-party bug is worked around in `postfx.ts`.** `postprocessing@6.39` +
`three@0.170` alias their depth textures: the composer creates them via
`DepthTexture.clone()`, and in r170 clones share one `Source`, which three's
texture cache collapses into a single GL image — producing `glBlitFramebuffer`
"same image" errors and a black frame. `fixDepthTextureAliasing()` gives each
depth texture its own `Source`. The workaround degrades to a no-op if either
library fixes it, but retest if those versions are bumped. (Note: `^6.36.0`
resolves to 6.39.4; the code targets the installed 6.39 API.)

**The viewmodel scene is camera space.** The rig is authored around a camera at
the origin looking down -Z at `FOV_VIEWMODEL`, and the scope overlay is a
clip-space quad so it survives any camera. It carries its own shadowless sun and
hemisphere fill so the gun is never unlit regardless of world lighting.

**The weapon rig hides itself while scoped** (once scope glass exceeds 0.55) so
the barrel doesn't block the aperture. The camera rig must not also try to hide
it — double-hiding was an easy integration bug to walk into.

**`SoundId` lives in `client/src/audio/sounds.ts`, not `shared/types.ts`.** The
audio facade in INTEGRATION.md referenced the type without anywhere declaring it,
and sound identifiers are client presentation with no business appearing in a
contract the server imports.

**Four map bugs were found by the movement agent and fixed in `mapdata.ts`**,
which meant unfreezing it mid-build. Worth it — all four were silent and would
have been miserable to diagnose later:

1. *Every spawn faced out to sea.* `sp()` computed `atan2(-x, -z)`, which only
   points at the origin under a `forward = (sin yaw, 0, cos yaw)` convention.
   `types.ts` specifies `forward = (-sin yaw, 0, -cos yaw)` (yaw 0 looks down
   -Z), so the correct expression is `atan2(x, z)`. Every player was spawning
   with their back to the map.
2. *Players had to jump onto their own spawn platform.* The step and platform
   were 0.5m rises against `STEP_HEIGHT = 0.4`. Rebuilt as two 0.375m rises
   (step top 0.375, platform top 0.75), and the bow/stern spawn point Y values
   moved from 1.0 to 0.75 to match.
3. *The low crate poked through the foot of the ramp.* Collision resolved it
   correctly but it would have rendered visibly wrong, since both are built from
   the same brush array.
4. *The crates then blocked the port walkway.* Moving them clear of the ramp put
   them mid-lane at z≈0, which broke four tests and was bad map design besides.
   They now stack outboard against the bulwark (x=-8.2), which leaves the lane
   open and turns the catwalk jump into a real 1.25m gap rather than a step up.

**`prevButtons`, `proneTime` and `adsMoveSpeedOverride` were promoted into
`PlayerState`.** Movement needs a previous-button field to detect rising edges
(without it, holding jump bunny-hops forever), a prone transition timer, and a
way to receive the Lightweight Stock speed without reading `loadout` itself. The
movement agent added them as optional fields on a `MovementState` extension;
promoting them into the frozen type is additive, breaks nothing, and means the
netcode agent carries them in its prediction history as a matter of course
rather than discovering them at integration.

**Friction is floored at the input's target speed.** `ACCEL_GROUND / FRICTION`
= 60/9 = 6.67 m/s, which is *below* `SPEED_SPRINT = 7.4` — under textbook Quake
friction, sprinting is literally unreachable with the tuning as frozen. The
alternative Quake formulation makes ground acceleration complete in a single
tick at 60Hz, which makes `ACCEL_GROUND` meaningless. Flooring friction at the
target speed reaches every speed constant exactly while still bleeding off
excess speed carried in from a strafe-jump landing. If sprint was *meant* to be
slightly out of reach, that is a tuning change, not a code change.

**Air acceleration is `ACCEL_AIR * AIR_CONTROL`, not `ACCEL_AIR`.** With the
full constant, strafe-jumping gained ~9.5 m/s per jump and turned a 62m boat
into a racetrack. Scaled, a perfect jump gains ~3.3 m/s and a casual one ~1.2 —
enough that movement tech is real and rewarding, not enough that it replaces the
game. There is still no total air-speed cap.

**Gravity is integrated leapfrog** (half-step before the move, half after), which
puts sampled positions exactly on the analytic parabola and yields a 1.033m jump
apex. Quake's full-gravity-before-move gives 0.983m and misses the documented
~1.05m by more than the test tolerance.

**Prone is reachable only by drop-shot** — crouch held through a landing. There
is no deliberate go-prone binding, which keeps prone a movement flourish rather
than a camping position on a map this small.

**Bolt-cycle and reload animations time off the frozen base weapon spec**, not
the attachment-resolved values. A Ballistic Compensator build cycles ~8% faster
than its animation implies. Cosmetic-only, and fixable at integration by passing
resolved times into `onFire`/`onReload`; noted rather than papered over.

**The rooms module defines `Connection`; netcode implements it.** The lobby
registry depends on a four-method interface, never on `ws`. Inverting the
dependency this way meant the lobby agent did not have to wait for the transport
agent, and it makes the registry testable against a `FakeConn` with no sockets
involved — which is how all 19 of its tests run.

**Errors are sent by the registry, not by its caller.** Every failing registry
call has already emitted the `Error` frame before returning its `ErrorCode`, so
the caller must not send a second one. Chosen because the silent-failure variant
(return a code, hope the caller reports it) is exactly how a player ends up
staring at a lobby screen that does nothing after typing a wrong code.

**The host migrates the instant the host's socket drops**, not after the 30s
reconnect grace. Waiting would leave the lobby unable to change settings or
start a match for half a minute. A reconnecting ex-host returns as a regular
player.

**Lobby capacity counts grace-held slots.** A reconnecting player's seat is
genuinely reserved for 30s rather than being given away to whoever knocks next.

**Screen routing is server-driven.** The React tree picks its screen from the
authoritative round phase rather than from local navigation state, so a client
cannot get stuck on a screen the server does not think it is on.

**Reconnecting players are signalled with a `ping: 999` sentinel.**
`LobbyPlayerInfo` has no connected flag, and the type is frozen; the UI renders
that value as "RECONNECTING". A boolean would be cleaner and should be added if
the protocol is ever revised.

**New lobbies default to `MATCH_TIME_LIMIT`.** `CreateLobbyMsg` carries no time
limit — only `SetMatchConfigMsg` does — so the host adjusts it after creation.

**The accuracy lock has to be *armed* before it can retrigger.** The agreed
rising-edge stopwatch had an exploit: `adsProgress` only decays ~0.05 in a single
tick, so a camper could tap ADS off for one frame, re-cross the lock, and harvest
a free QUICKSCOPE bonus without ever losing accuracy. The lock now requires the
aim to have genuinely fallen below `accuracyLockAt` before it can fire again.
Found by the weapons agent; the contracted behaviour is otherwise unchanged.

**Attachment mods resolve by naming convention, not by attachment name.**
`*Mult` multiplies, `*Add` sums, an unsuffixed key is an absolute override, and
the order is multiplicative → additive → override. No attachment is named
anywhere in gameplay code, so a new one is a single entry in `tuning.ts`. The
frozen `AttachmentSpec.mods` does mix the two conventions (`adsTimeMult` is
suffixed, `penetrationDamage` is not) — a future `penetrationDamageMult` would
silently differ from `penetrationDamage`. Worth tidying if the schema is revised.

**`accuracyLockAt` is deliberately not modifiable by any attachment.** It is the
one number that defines the mode; letting a loadout move it would make the
game's identity a build choice.

**Raw vs eased ADS progress are tracked separately.** `accuracyLockAt` (0.82) is
evaluated against the raw linear progress, while camera FOV and the viewmodel use
a smoothstep-eased value (eased(0.82) = 0.9145). Conflating them would change how
every shot in the game feels.

**Recoil and sway are presentation-only** and never perturb the authoritative
ray, which uses the input's absolute view angles. Sway is hashed integer
value-noise rather than `Math.sin(time)` and recoil decays linearly rather than
exponentially, so replay stays bit-stable during reconciliation.

**Hitbox stance scaling squashes Y only, leaving radii alone.** Scaling radii
too would make a prone player far narrower than their own collision capsule —
shots that visibly connect would miss. The chest top and head bottom are butted
together at y=1.47 so a head-only band survives the squash; without it, crouched
headshots silently stop registering.

**Bullets never stop on players**, which is what makes collaterals work, and a
single bullet can never hit the same player twice. On a distance tie between
world geometry and a player, the world wins.

## Phase 2 — integration

Four real bugs surfaced only when the eight subsystems were wired together and
run in a browser. Every one of them typechecked and unit-tested clean, which is
the point: contracts catch signature mismatches, not semantic ones.

**The viewmodel camera was posed as world space; the rig was authored in camera
space.** `Renderer.render()` copied the world camera's position and quaternion
into the viewmodel camera, alongside the shadow camera where that is correct.
But the viewmodel agent authored the weapon rig at the origin looking down -Z,
with the scope overlay as a clip-space quad. The result: the camera sat at eye
height, two metres above a perfectly correct rig, rendering it just off the
bottom of the screen. **The game shipped with no visible gun and no error of any
kind.** The viewmodel camera is now pinned to identity in the renderer, with a
comment explaining why it differs from the shadow camera beside it.

**Nothing ever called `viewmodel.setWeapon()`.** The `Viewmodel` builds no mesh
until it is told which weapon to build, and the integration layer set the
loadout on the predicted weapon state only. Loadout changes now go through a
single `applyLoadout()` that updates both halves, because updating one is
silent.

**`<canvas>` does not stretch to `position: fixed; inset: 0`.** A canvas is a
replaced element, so with `width: auto` it falls back to its intrinsic 300x150
regardless of the inset. The entire game was rendering into a 300x150 buffer
scaled up. Fixed with explicit `width/height: 100%` in `index.html`.

**Spawn awnings filled half the screen.** The canopies were correctly sized and
at realistic 2.5m head clearance — but players spawn directly underneath them,
so the first thing anyone saw on spawn was a wall of fabric. Raised to 3.95m.
Realistic and unplayable is still unplayable.

**Third-person avatars did not exist and were written at integration.** The
fan-out covered the weapon in your own hands but nothing rendered other players.
They are built from `HITBOX_TEMPLATE` — the same capsules the server hit-tests
against — so the silhouette and the hitboxes cannot drift. In a game decided by
one-shot headshots, a model fatter or thinner than its hitbox is a fairness bug
that players experience as "the hit detection is broken".

**The fixed-timestep loop now clamps its own timer delay.** `setTimeout`
silently truncates anything above 2^31-1 to 1ms, so a caller driving
`advanceTo()` with a different clock than the loop's (`Date.now()` vs
`process.hrtime`) turned a 60Hz loop into a 1000Hz busy-spin. Clamping to the
step size degrades that to "ticks at the normal rate", which is recoverable.

**Known gap: invert-Y is persisted and shown in Settings but not wired.** The
input controller exposes no inversion hook, and faking it in the integration
layer by mirroring pitch deltas would fight the controller's internal absolute
angle state. Recorded rather than papered over; it needs a one-line option on
`InputController`.

## Weapons and hit registration (continued)

**Melee is a separate action that never becomes the held weapon.**
`WeaponId.Knife` inherits `magSize: 0` from the pistol spec and so can never
satisfy `canFire`; rather than special-case it, the knife is a button, not a
weapon you hold.

## Player skins

**Skins are free expression; team identity is nameplates.** Body colour no
longer encodes team. Each player picks one of five operator skins
(`SkinId`, rendered by `client/src/gameplay/skins.ts`) that is never
overridden by team; teammates are marked by a team-coloured nameplate and
ground rim instead, and enemies get *nothing* — an enemy nameplate drawn
through geometry is a wallhack. In FFA nobody gets a plate. The five skins are
spread across value AND hue (mid olive, near-black, white, teal+brass, hot
orange) so they stay separable at 40–60m and in greyscale.

**Gear must stay inside the hitbox capsule union above the waist.** The
avatar body is built from the server's hit-test capsules, and a helmet wider
than the head capsule creates shots that visually hit and mechanically miss.
Flat boxes are almost never legal (corners leave the capsule) and flush
plates are invisible (buried in the body mesh), so skin gear is built as
capsule-profile lathe shells at ≤99.9% of the true radius, with the base body
capsules rendered radially inset (`HEAD_INSET` 0.94, `LIMB_INSET` 0.985 —
X/Z only, never Y). The inset errs in the safe direction: a shot that
visually misses by 3mm and still hits is imperceptible; the reverse reads as
broken hit detection. Only leg gear (boots, knee pads) may extend outward —
below the waist nothing is a one-shot kill.

**A mid-match skin change applies immediately; the rest of the loadout stays
respawn-gated.** `Room.setSkin` patches only the cosmetic skin into the live
body so remote players see it within a snapshot; weapon and attachments
still apply at spawn time as before. The skin is part of the snapshot
`identityKey` — without that, delta compression would never resend the
loadout and a mid-match change would be invisible to everyone else.

**Skin thumbnails in the loadout screen are runtime renders**
(`client/src/ui/skinThumbs.ts`): a throwaway WebGL context renders the same
materials and gear the avatar wears, once per session. No asset files, and a
tweaked skin can never drift from its picker card. The wire format grew one
byte (`writeLoadout`/`readLoadout`), clamped by `clampEnum` so a stale or
hostile skin byte degrades to Vanguard instead of dropping the socket.

## SURVIVAL (co-op Zombies, ticket DECK-V85WIP)

**Frozen-contract edits — reported per INTEGRATION.md rule 1.** All additive,
none change the wire layout of an existing message:

| File | Edit |
|---|---|
| `types.ts` | `GameMode.Survival = 2`; `InputButton.Use = 1 << 9` (u16 buttons, bits 9-15 were free); `WeaponId` 3–6 (Osprey/Shrike/Condor/Harrier); optional `PlayerState.downed/bleedout/points/perks` |
| `protocol.ts` | `ClientMessage.Purchase = 13`, `Interact = 14`; `ServerMessage.SurvivalState = 76`; `SnapshotPlayer.downed?` riding Flags bit 3; `PROTOCOL_VERSION` → `1.2.0` (stale tabs get a version-mismatch error, by design) |
| `tuning.ts` | Four new `WeaponSpec`s (the `WEAPONS` record is typed over `WeaponId`, so the enum addition forces them); optional `WeaponSpec.auto` for hold-to-fire |
| `mapdata.ts` | **untouched** — Leviathan lives in `shared/leviathan.ts` behind a `MapDef` registry (`shared/maps.ts`), and `assertSymmetric()` keeps applying to Sundeck only |

**Zombies are `PlayerState`-shaped entities on the existing snapshot channel,
partitioned by id range** (players 1–199, horde 200+, `TeamId.Bravo`). That
buys hitboxes, penetration collaterals, delta compression, interpolation and
lag comp with no parallel entity pipeline. They replicate `Position|Yaw|Flags`
only (~12 B) via a per-entity mask ceiling in the snapshot assembler — a
bandwidth requirement (5 players + 24 zombies measures ~7.1 KB/s against the
12 KB/s budget, enforced by test). Zombie health (up to 100,000) never goes on
the wire; the u8 health field could not carry it and canon shows no bars.

**The `collision.ts` multi-map refactor is additive.** Zero-arg
`createCollisionWorld()` still returns the cached Sundeck singleton;
`CollisionWorld` now carries its own `bounds`/`waterLevel`;
`raycastWorld[All]In(world, ...)` variants exist beside the singleton forms;
`isOutOfBounds(pos, world?)` defaults to Sundeck. No existing call site
changed behaviour.

**Zone doors are real brushes, removed on purchase.** Opening a zone rebuilds
the collision world (server) and the render + prediction worlds (client) from
`collisionBrushesFor(map, zoneMask)`; zombies path a waypoint graph whose
edges are traversable iff the zone they ENTER is open, so "zombies only reach
where players have paid to open" falls out of the graph.

**STEADY HAND halves `adsTime` and nothing else.** `accuracyLockAt` stays
0.82 and unmodifiable (`applySurvivalWeaponMods` spreads it through
untouched; a test pins it). Down-state is enforced as an input mask
(`filterDownedButtons`) applied by BOTH sides, so prediction stays honest
while crawling.

**Known survival gaps, recorded not hidden:** power-ups apply squad-wide the
moment they drop (no pickup entity); the four new guns borrow the two
existing viewmodel rigs; Carpenter never drops (no repairable barriers, per
the plan's out-of-scope list); zombie audio is not yet synthesized.

