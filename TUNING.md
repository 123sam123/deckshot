# TUNING — how to change how DECKSHOT feels

Every number below lives in `shared/tuning.ts`. Both the client and the server
import from there, so changing a value once changes it everywhere. If you find
the same number written down in two places, that is a bug — fix it by deleting
one.

Restart the server after changing anything here. The client hot-reloads.

---

## The three numbers that matter most

### `accuracyLockAt` (default `0.82`)

**This is the game.** It is the fraction of the aim-down-sight transition at
which your shot stops taking a spread cone and becomes a pinpoint ray.

- **Lower it** (0.6) — shots land earlier in the scope-in. Quickscoping becomes
  easy and forgiving. Good for a casual lobby; the skill ceiling drops.
- **Raise it** (0.95) — you must almost fully complete the scope-in. Punishing,
  much higher ceiling, and it starts to favour holding angles over movement.
- **Above ~0.97** the mode stops being quickscoping and becomes hardscoping.

Tune this *before* anything else. Almost every complaint that the gun "feels
wrong" is actually about this number or the one below.

### `adsTime` (default `0.34s` on the Talon)

How long the scope-in takes. Interacts multiplicatively with `accuracyLockAt`:
what a player actually feels is `adsTime * accuracyLockAt` — 279ms by default —
which is the real "time to a lethal shot".

With Fast Draw equipped (`×0.62`) that becomes 173ms, which is the intended
competitive build. If you change `adsTime`, re-check that Fast Draw still feels
like a meaningful upgrade rather than a mandatory tax.

### `QUICKSCOPE_WINDOW` (default `0.25s`)

How soon after the accuracy lock a shot still counts as a quickscope *for
scoring*. Purely cosmetic — it affects the banner and the score, never whether
the bullet hits. Widen it if players who are clearly quickscoping aren't getting
credit.

---

## Movement feel

| Constant | Default | Effect |
|---|---|---|
| `SPEED_SPRINT` | 7.4 | Base pace of the game. Raising it makes the boat feel small. |
| `JUMP_IMPULSE` | 6.1 | ~1.05m apex. **Tightly coupled to the crate route** — the jump from the high crate (top at 2.4m) to the catwalk (3.3m) only works because apex is just over 1.05m. Lower this and that route silently disappears. |
| `AIR_CONTROL` | 0.35 | How much you can steer mid-air. Higher feels floaty; lower kills strafe-jumping. |
| `ACCEL_GROUND` / `FRICTION` | 60 / 9 | Snappiness of starting and stopping. Raise both together for a more arcade feel. |
| `SLIDE_SPEED_MULT` | 1.35 | Slide burst speed. Above ~1.6 sliding becomes the only correct way to move. |
| `SLIDE_COOLDOWN` | 1.1 | The only thing stopping slide-spam. |
| `GRAVITY` | 18.0 | Arcade-heavy (real gravity is 9.8). Lowering it toward realism makes airborne shots much easier and slows the whole game down. |

There is deliberately **no air speed cap**. Strafe-jumping to build speed is a
feature. If you add a cap you will delete most of the movement skill ceiling.

---

## Weapon handling

| Constant | Default | Effect |
|---|---|---|
| `swayAmplitude` | 0.9° | Idle scope wobble. Set to 0 for a sterile, arcade feel. |
| `swaySettleFactor` / `swaySettleTime` | 0.25 / 0.7s | How much sway calms down if you hold the scope. Rewards patience over flicking. |
| `flinch` | 2.2° | Camera kick when hit while scoped. **This is the main counter to hardscoping.** Reduce it and holding an angle becomes dominant. |
| `recoilVertical` | 3.1° | Kick per shot. Barely matters on a bolt-action with a 0.9s cycle; matters a lot on the pistol. |
| `cycleTime` | 0.9s | Bolt cycle. The single biggest lever on how punishing a miss is. |
| `hipSpreadStand` | 6.5° | No-scope viability. Tighten it and no-scoping becomes reliable rather than a gamble. |
| `damage` | 100 above the waist | One-shot-kill zone. Dropping chest damage below 100 fundamentally changes the mode — don't, unless you mean to. |

---

## Attachments

All attachments in `ATTACHMENTS` are **pure multipliers** into the same weapon
state machine. There are no special cases in gameplay code, so you can add a new
attachment by adding one entry — no engine changes.

Balance rule of thumb: every attachment should cost something. The two that are
easiest to accidentally make mandatory are `FastDraw` (`adsTimeMult: 0.62`) and
`StabilizerCPU` (`swayAmplitudeMult: 0.25`). If a build is a strict upgrade with
no downside, add a cost rather than nerfing the benefit.

---

## Match pacing

| Constant | Default | Effect |
|---|---|---|
| `FFA_SCORE_LIMIT` | 30 | ~8-12 minutes with 6 players. |
| `RESPAWN_DELAY` | 2.5s | Lower feels frantic; higher makes deaths feel punishing on a map this small. |
| `SPAWN_MIN_ENEMY_DIST` | 12.0 | **Do not lower this.** Spawn-trapping is the fastest way to make a small symmetric map miserable. |
| `SPAWN_LOS_PENALTY` | 1000 | A soft penalty, not a ban — on a 62m boat there is not always a spawn with no sightline, so the scorer picks the least-bad one. |
| `MATCH_TIME_LIMIT` | 600s | Backstop so a stalled match ends. |

---

## Netcode

Change these only with a clear reason; they trade responsiveness against
smoothness and the defaults are the standard competitive compromise.

| Constant | Default | Effect |
|---|---|---|
| `TICK_RATE` | 60 | Server sim rate. Raising it costs CPU per lobby, linearly. |
| `SNAPSHOT_RATE` | 20 | Broadcast rate. Raising it costs bandwidth, linearly. |
| `INTERP_DELAY_MS` | 100 | How far in the past remote players are rendered. Must be ≥ 2 snapshot intervals (100ms at 20Hz) or remote players stutter on any jitter. **Lowering this below 100 is the most common way to make a game look broken.** |
| `LAGCOMP_MAX_REWIND_MS` | 250 | How far back the server will rewind hitboxes to honour a shot. Higher favours high-ping shooters and produces more "I died behind cover" moments; lower punishes them. 250ms is the usual compromise. |
| `RECONCILE_EPSILON` | 0.01 | Position disagreement that triggers a correction. Too low and you correct on float noise every tick; too high and cheats slip through. |

---

## Graphics

`FRAME_BUDGET_MS` (16.6) is a hard target, not an aspiration. The quality tier
(`?quality=low|medium|high`) scales shadow map size, SSAO samples and bloom.

If you are below budget, the two most expensive things to reach for first are
shadow map resolution and the ocean's reflection method. `MAX_PARTICLES` (2000)
and `MAX_DECALS` (128) are ring-buffer caps — raising them raises memory and GC
pressure, not just draw cost.
