# DECKSHOT

A browser multiplayer quickscoping arena on a yacht at sea. Create a lobby, get
a 4-character code, text the link to a friend, and they're in your match in
about three seconds. No install, no account, no login.

Original map, original weapons, original everything — it's *inspired by* the
sniper lobbies of a certain 2012 shooter's boat map, not extracted from it.

Three modes: **FFA** and **TDM** quickscoping on the yacht, and **ZOMBIES** —
1–4 player round-based undead co-op on Shipbreak, a shipbreaker's yard at
dusk. Pistol start, points for hits and kills, wall buys, boarded windows,
doors to open, a power switch, five perk machines, a mystery box, the Forge
(weapon upgrades), power-up drops, and last-stand revives. Solo-friendly.
Design doc: **[ZOMBIES.md](ZOMBIES.md)**.

---

## Run it

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. Client runs on Vite, game server on :8080, and
Vite proxies the WebSocket — so the single-URL behaviour is identical in dev and
production.

To play with someone else, see **[deploy.md](deploy.md)** — one `fly deploy` and
you have a public HTTPS link.

To test multiplayer on one machine: open the game in two windows (one normal,
one private). Create a lobby in the first, hit **COPY INVITE LINK**, paste into
the second.

## Controls

| | |
|---|---|
| **WASD** | move |
| **Mouse** | look (raw input — no acceleration, no smoothing, **no aim assist**) |
| **Left click** | fire |
| **Right click** | aim down sight |
| **Shift** | sprint |
| **Ctrl / C** | crouch — while sprinting, slide; in the air, drop-shot |
| **Space** | jump |
| **R** | reload |
| **1 / 2 / Q** | weapon swap |
| **V** | knife |
| **Tab** | scoreboard |
| **Esc** | release mouse |

**How to quickscope:** flick your aim onto a target, tap right-click, and fire
the instant the scope comes up. Your shot becomes pinpoint-accurate at 82% of
the way through the aim-down-sight animation — about 280ms, or 173ms with the
Fast Draw attachment. Fire before that and it takes a spread cone. That single
number is the whole game; see [TUNING.md](TUNING.md) to change how it feels.

One shot kills above the waist. Two to the legs. The bullet keeps going after a
kill, so lining two people up gets you a collateral.

## What's in it

- **Real netcode.** Authoritative 60Hz server, client-side prediction, server
  reconciliation, entity interpolation, and lag compensation that rewinds
  hitboxes up to 250ms so your shots land where your crosshair was. Binary
  protocol, delta-compressed — **4.79 KB/s per client at 12 players.**
- **One deterministic simulation.** Client and server run literally the same
  movement code from `shared/`, stepped identically. That's what makes
  prediction work.
- **Sundeck**, a mirror-symmetric three-lane yacht: a pool spine down the
  middle, walkways port and starboard, two cabins with a corridor between them
  for the cross-map shot, and catwalks overhead to drop off mid-air.
- **10 attachments** that are pure multipliers into one weapon state machine —
  adding an eleventh is one entry in `shared/tuning.ts` and no engine changes.
  The loadout screen shows real computed stat deltas, not hardcoded text.
- **Trickshot scoring**, server-authoritative: quickscope, no-scope, 360/540/720,
  collateral, cross-map, airborne, drop-shot, jump-shot, feed.
- **Graphics**: PBR throughout with image-based lighting baked from a
  physically-based sky, Gerstner-wave ocean with planar reflection and foam,
  3-cascade shadows, SSAO → bloom → ACES → SMAA.
- **Audio**: 39 sounds, every one synthesized at runtime in WebAudio. No audio
  files ship.
- Lobby codes, invite links, quick play, host migration, 30-second reconnect.

## Layout

```
shared/     engine-free game logic — imported by BOTH the browser and the server
client/     renderer, world, gameplay, netcode, React HUD
server/     authoritative sim, lobby registry, WebSocket transport
tests/      396 tests, including a real two-socket end-to-end match
tools/      map preview harness with a collision wireframe overlay
```

`shared/` contains no `three`, no DOM, no Node APIs. That constraint is what
lets both sides run the same simulation.

## Tests

```bash
npm test
```

396 tests across 13 files. The interesting ones:

- **Determinism** — a fixed 600-input sequence produces bit-identical positions
  on replay. This is the guarantee everything else rests on.
- **`tests/e2e.test.ts`** — a real HTTP server, real WebSockets, real binary
  codec, two clients: one creates a lobby, the other joins by code, and each
  sees the other move. Nothing mocked.
- **Bandwidth** — 12 players moving continuously, measured and printed per run.
- **Lag** — the client converges over a simulated 150ms / 2% packet loss link.
- **Map symmetry** — asserts no brush lacks its bow-to-stern mirror, because an
  asymmetric spawn advantage is very hard to see and very obvious to lose to.

Useful flags: `?netsim=150,2` (simulate latency/loss), `?debug=perf` (frame time,
draw calls, triangles), `?quality=low|medium|high`.

## Docs

- **[TUNING.md](TUNING.md)** — every number that changes how the game feels, and
  what it does. Start with `accuracyLockAt`.
- **[DECISIONS.md](DECISIONS.md)** — every ambiguous call made during the build
  and why, including the bugs that only appeared at integration.
- **[deploy.md](deploy.md)** — getting a public URL.
- **[INTEGRATION.md](INTEGRATION.md)** — module ownership and the interfaces
  between subsystems.
