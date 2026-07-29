# INTEGRATION — file ownership and the rules of the build

This project is built by parallel agents. The only thing preventing them from
destroying each other's work is this document. Read it before writing a line.

## The three hard rules

1. **`shared/types.ts`, `shared/tuning.ts`, `shared/protocol.ts` and
   `shared/mapdata.ts` are FROZEN.** They were written by the orchestrator
   before fan-out. If you need a change, **stop and report it** — do not edit
   them. A silent edit to a frozen contract will desync every other agent.

2. **Never write to a file you do not own.** The table below assigns exactly one
   owner per path. If you need behaviour from another agent's module, code
   against the interface it is contracted to export (listed below) and report
   the dependency in your final message.

3. **The repo must always boot.** If your subsystem is not finished, export a
   working reduced version — never a stub that throws, never a file that fails
   to typecheck.

## Import conventions (non-negotiable, they break the build otherwise)

- **Always use relative paths with a `.js` extension**, even from `.ts` files:
  `import { PlayerState } from '../../shared/types.js'`.
  There is no `@shared` alias. The server compiles under `NodeNext`, which
  requires explicit extensions; the client uses Vite, which resolves `.js` to
  `.ts` for local files. One convention, both targets.
- `shared/` must stay **engine-free**: no `three`, no `rapier`, no DOM, no Node
  APIs. It is imported by a browser and a server. Plain TypeScript only.
- No `Math.random()` or `Date.now()` inside anything the simulation touches.
  Randomness comes from `shared/rng.ts` (seeded, owned by weapons-hitreg); time
  comes from the tick number.

## Ownership table

| Path | Owner | Notes |
|---|---|---|
| `shared/types.ts` | orchestrator | FROZEN |
| `shared/tuning.ts` | orchestrator | FROZEN |
| `shared/protocol.ts` | orchestrator | FROZEN |
| `shared/mapdata.ts` | orchestrator | FROZEN |
| `package.json`, `tsconfig*.json`, `vite.config.ts`, `client/index.html` | orchestrator | Request additions; don't edit |
| `shared/codec.ts`, `shared/quantize.ts` | **netcode-core** | Binary encode/decode, the only module allowed to touch bytes |
| `server/src/net/**` | **netcode-core** | Socket handling, snapshot assembly, lag-comp history |
| `client/src/net/**` | **netcode-core** | Socket, prediction, reconciliation, interpolation |
| `shared/movement.ts` | **physics-movement** | The deterministic `applyMovement` both sides call |
| `shared/collision.ts` | **physics-movement** | Brush→collider conversion, capsule sweep, raycast |
| `client/src/gameplay/controller.ts` | **physics-movement** | Local input sampling → `ClientInput` |
| `server/src/sim/movement.ts` | **physics-movement** | Server-side application of the same function |
| `shared/weapons.ts`, `shared/rng.ts` | **weapons-hitreg** | ADS state machine, resolved weapon stats, spread |
| `shared/hitbox.ts` | **weapons-hitreg** | Capsule set per stance, ray-vs-capsule |
| `server/src/sim/combat.ts` | **weapons-hitreg** | Authoritative firing, penetration, damage |
| `client/src/gameplay/weapons.ts` | **weapons-hitreg** | Predicted weapon state for the local player |
| `client/src/engine/**` | **renderer-graphics** | Renderer, postfx, lighting, materials, sky |
| `client/src/world/**` | **map-and-ocean** | Scene construction from `mapdata`, ocean, props |
| `tools/mapgen.ts` | **map-and-ocean** | Debug/preview tooling for the map |
| `client/src/gameplay/viewmodel.ts` | **viewmodel-vfx-audio** | Procedural weapon mesh + springs |
| `client/src/gameplay/effects/**` | **viewmodel-vfx-audio** | Tracers, muzzle flash, impacts, decals |
| `client/src/audio/**` | **viewmodel-vfx-audio** | Synthesized WebAudio graph |
| `client/src/ui/**` | **lobby-ui-hud** | React menus, HUD, killfeed, scoreboard, loadout |
| `server/src/rooms/**` | **lobby-ui-hud** | Lobby registry, codes, host migration, reconnect |
| `shared/trickshot.ts` | **trickshot-scoring** | Modifier detection, pure functions |
| `server/src/sim/scoring.ts` | **trickshot-scoring** | Score accumulation, match end conditions |
| `client/src/main.ts` | orchestrator | Written at integration; do not create it |
| `server/src/index.ts` | orchestrator | Written at integration; do not create it |
| `tests/**` | everyone | Namespace your files: `tests/<yourdomain>.test.ts` |

## Contracted interfaces between agents

These are the seams. Code against them; they will exist.

**`shared/movement.ts`** (physics-movement provides)
```ts
export interface MoveResult { state: PlayerState; landed: boolean; impactSpeed: number }
export function applyMovement(
  state: PlayerState, input: ClientInput, dt: number, world: CollisionWorld
): MoveResult;
export function createCollisionWorld(): CollisionWorld;
```
`applyMovement` must be **pure with respect to its inputs**: same state + input +
dt + world ⇒ bit-identical output, on both Node and the browser. No time, no
randomness, no floating-point-order surprises. There is a determinism test.

**`shared/weapons.ts`** (weapons-hitreg provides)
```ts
export interface ResolvedWeapon { /* WeaponSpec with attachment mods applied */ }
export function resolveWeapon(weapon: WeaponId, attachments: AttachmentId[]): ResolvedWeapon;
export function advanceWeapon(ws: WeaponRuntime, input: ClientInput, dt: number, rw: ResolvedWeapon): WeaponRuntime;
export function spreadForShot(ws: WeaponRuntime, rw: ResolvedWeapon, state: PlayerState): number;
```

**`shared/hitbox.ts`** (weapons-hitreg provides)
```ts
export function hitboxesFor(state: PlayerState): HitboxCapsule[];  // world space
export function rayVsPlayer(origin: Vec3, dir: Vec3, state: PlayerState): { part: HitboxPart; t: number } | null;
```

**`shared/collision.ts`** (physics-movement provides)
```ts
export function raycastWorld(origin: Vec3, dir: Vec3, maxDist: number):
  { point: Vec3; normal: Vec3; brush: Brush; t: number } | null;
```

**`shared/trickshot.ts`** (trickshot-scoring provides)
```ts
export function evaluateTrickshot(ctx: TrickshotContext): { flags: number; score: number };
```

**`client/src/engine/`** (renderer-graphics provides)
```ts
export class Renderer {
  readonly scene: THREE.Scene;
  readonly viewmodelScene: THREE.Scene;   // rendered over the world at FOV_VIEWMODEL
  readonly camera: THREE.PerspectiveCamera;
  setWorldFov(radians: number): void;
  render(dtSeconds: number): void;
  addDynamicLight(pos: Vec3, color: number, intensity: number, lifetime: number): void;
}
```
Everyone else adds objects to `renderer.scene`. Nobody else creates a
`WebGLRenderer`, a composer, or a camera.

**`client/src/world/`** (map-and-ocean provides)
```ts
export function buildWorld(scene: THREE.Scene): WorldHandle;
export interface WorldHandle { update(dt: number, cameraPos: Vec3): void }
```

**`client/src/audio/`** (viewmodel-vfx-audio provides)
```ts
export const Audio: {
  init(): Promise<void>;
  play(id: SoundId, opts?: { position?: Vec3; pitch?: number; volume?: number }): void;
  setListener(pos: Vec3, forward: Vec3, up: Vec3): void;
};
```

**`server/src/rooms/`** (lobby-ui-hud provides)
```ts
export class LobbyRegistry {
  create(hostConn: Connection, cfg: CreateLobbyMsg): Lobby;
  join(conn: Connection, code: LobbyCode): Lobby | ErrorCode;
  quickPlay(conn: Connection): Lobby | ErrorCode;
  tick(nowMs: number): void;   // called at TICK_RATE by the server loop
}
```

## Reporting back

End your final message with exactly these sections:

- **Files created** — full paths
- **Exports** — the public API you actually shipped, signature by signature
- **Assumptions** — anything you decided that another agent might contradict
- **Needs** — what you depend on from another agent, and what you stubbed to
  keep the build green in the meantime
- **Contract friction** — anything in the frozen files that fought you. Do not
  fix it; report it.
