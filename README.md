# DECKSHOT

A browser multiplayer quickscoping arena on a yacht at sea. Create a lobby, get
a 4-character code, text the link to a friend, and they're in your match in
about three seconds. No install, no account, no login.

Original map, original weapons, original everything — it's *inspired by* the
sniper lobbies of a certain 2012 shooter's boat map, not extracted from it.

---

## Run it

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. Client runs on Vite, game server on :8080, and
Vite proxies the WebSocket — so the single-URL behaviour is identical in dev and
production.

To test multiplayer on one machine: open the game in two windows (one normal,
one private). Create a lobby in the first, hit **COPY INVITE LINK**, paste into
the second.

To play with someone over the internet, see **[deploy.md](deploy.md)** — one
`fly deploy` and you have a public HTTPS link.

### Play on your LAN

Everyone on the same network, one machine hosting, no deploy and no config:

```bash
npm run build
PORT=8080 npm start
```

The server prints the address to hand out:

```
[deckshot] listening on :8080 — production (serving dist/public)
[deckshot] this machine: http://localhost:8080
[deckshot] LAN — send this to players on your network: http://192.168.1.42:8080
```

Everyone opens that URL, one player creates a lobby, and **COPY INVITE LINK**
gives a link the others can actually open — the client asks the server for its
LAN address, so a host who is themselves on `localhost` still hands out
`http://192.168.1.42:8080/?lobby=K7QX` rather than a `localhost` link that
resolves on every machine and points each of them at their own laptop.

`npm run dev` works on the LAN too (Vite binds every interface and proxies both
`/ws` and `/lan`), but the built server is one process on one port and is what
you want for an actual game.

Two things that are not the game's fault when this does not work: macOS will ask
once whether `node` may accept incoming connections — say yes — and a network
with client isolation on (most guest and cafe Wi-Fi) blocks machine-to-machine
traffic entirely, so nothing on it can host anything.

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
- **Four competitive maps**, every one mirror-symmetric about its middle, picked
  by the host in the lobby:
  - **Sundeck** — the original three-lane yacht: pool spine down the middle,
    walkways port and starboard, two cabins with a corridor between them for the
    cross-map shot, catwalks overhead to drop off mid-air.
  - **Death Trap** — an offshore rig whose centre is a hole. 48m across the pit,
    or one bridge over the top. *After the Red Eclipse map by Derek Stegall,
    Architect, Favorito and SniperGoth (CC BY-SA 4.0).*
  - **Hangar A482** — a cargo ship's deck split into two 44m bays by a bulkhead
    you can walk the top of. *After the map by SniperGoth (CC BY-SA 4.0).*
  - **Unknown Rooftop** — a temple on stilts over a wooded valley, two towers,
    one plank each. *After the map by SniperGoth (CC BY-SA 4.0).*

  The three adaptations are rebuilt from scratch at Deckshot's movement metrics;
  no original geometry or asset ships here. See **[MAPS.md](MAPS.md)**.
  SURVIVAL has its own map, **Leviathan**, and is pinned to it.
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
shared/     one file per arena, plus the map format and the registry
tests/      478 tests, including a real two-socket end-to-end match
tools/      map preview harness with a collision wireframe overlay
```

`shared/` contains no `three`, no DOM, no Node APIs. That constraint is what
lets both sides run the same simulation.

## Tests

```bash
npm test
```

478 tests across 13 files. The interesting ones:

- **Determinism** — a fixed 600-input sequence produces bit-identical positions
  on replay. This is the guarantee everything else rests on.
- **`tests/e2e.test.ts`** — a real HTTP server, real WebSockets, real binary
  codec, two clients: one creates a lobby, the other joins by code, and each
  sees the other move. Nothing mocked.
- **Bandwidth** — 12 players moving continuously, measured and printed per run.
- **Lag** — the client converges over a simulated 150ms / 2% packet loss link.
- **`tests/maps.test.ts`** — holds every competitive map to one contract: mirror
  symmetry about Z=0 (an asymmetric spawn advantage is very hard to see and very
  obvious to lose to), brushes inside the bounds box, no spawn buried in
  geometry or hanging over a hole, a clear signature sightline, a settle
  simulation from every spawn, and nine walked routes. It caught four bad
  spawns, one of them Sundeck's own.
- **Map symmetry** — asserts no brush lacks its bow-to-stern mirror, because an
  asymmetric spawn advantage is very hard to see and very obvious to lose to.

Useful flags: `?netsim=150,2` (simulate latency/loss), `?debug=perf` (frame time,
draw calls, triangles), `?quality=low|medium|high`.

## Docs

- **[MAPS.md](MAPS.md)** — the five arenas, where the adapted ones came from,
  what "adaptation" means here, and how to add a sixth.
- **[TUNING.md](TUNING.md)** — every number that changes how the game feels, and
  what it does. Start with `accuracyLockAt`.
- **[DECISIONS.md](DECISIONS.md)** — every ambiguous call made during the build
  and why, including the bugs that only appeared at integration.
- **[deploy.md](deploy.md)** — getting a public URL.
- **[INTEGRATION.md](INTEGRATION.md)** — module ownership and the interfaces
  between subsystems.
