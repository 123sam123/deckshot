/**
 * DECKSHOT UI — real computed loadout stats.
 *
 * Owner: lobby-ui-hud.
 *
 * The loadout screen shows numbers DERIVED from shared/tuning.ts, never
 * hand-written text, so "Fast Draw takes ADS from 340ms to 211ms" is always
 * true even if tuning changes. Convention for combining attachment mods
 * (mirrors what a resolver naturally does; weapons-hitreg owns the
 * authoritative resolveWeapon — flag any divergence at integration):
 *   - *Mult fields multiply together, then *Add fields sum on top;
 *   - magSizeAdd / reloadTimeAdd sum;
 *   - penetrationDamage / penetrationCount / adsMoveSpeed take the best
 *     value any equipped attachment provides.
 */

import { ATTACHMENTS, SPEED_ADS, WEAPONS } from '../../../shared/tuning.js';
import { AttachmentId } from '../../../shared/types.js';
import type { WeaponId } from '../../../shared/types.js';

const RAD_TO_DEG = 180 / Math.PI;

export interface ResolvedStats {
  adsTimeMs: number;
  magSize: number;
  reserveAmmo: number;
  reloadTimeS: number;
  cycleTimeS: number;
  hipSpreadStandDeg: number;
  hipSpreadMovingDeg: number;
  swayAmplitudeDeg: number;
  adsMoveSpeed: number;
  damageMult: number;
  recoilMult: number;
  penetrationCount: number;
}

export function resolveStats(weapon: WeaponId, attachments: readonly AttachmentId[]): ResolvedStats {
  const base = WEAPONS[weapon];
  let adsTimeMult = 1;
  let adsTimeAdd = 0;
  let swayMult = 1;
  let hipMult = 1;
  let magAdd = 0;
  let reloadAdd = 0;
  let cycleMult = 1;
  let damageMult = 1;
  let recoilMult = 1;
  let adsMoveSpeed = SPEED_ADS;
  let penetrationCount = base.penetrationCount;

  for (const a of attachments) {
    if (a === AttachmentId.None) continue;
    const spec = ATTACHMENTS[a];
    if (!spec) continue;
    const m = spec.mods;
    if (m.adsTimeMult !== undefined) adsTimeMult *= m.adsTimeMult;
    if (m.adsTimeAdd !== undefined) adsTimeAdd += m.adsTimeAdd;
    if (m.swayAmplitudeMult !== undefined) swayMult *= m.swayAmplitudeMult;
    if (m.hipSpreadMult !== undefined) hipMult *= m.hipSpreadMult;
    if (m.magSizeAdd !== undefined) magAdd += m.magSizeAdd;
    if (m.reloadTimeAdd !== undefined) reloadAdd += m.reloadTimeAdd;
    if (m.cycleTimeMult !== undefined) cycleMult *= m.cycleTimeMult;
    if (m.damageMult !== undefined) damageMult *= m.damageMult;
    if (m.recoilMult !== undefined) recoilMult *= m.recoilMult;
    if (m.adsMoveSpeed !== undefined) adsMoveSpeed = Math.max(adsMoveSpeed, m.adsMoveSpeed);
    if (m.penetrationCount !== undefined) {
      penetrationCount = Math.max(penetrationCount, m.penetrationCount);
    }
  }

  return {
    adsTimeMs: Math.round((base.adsTime * adsTimeMult + adsTimeAdd) * 1000),
    magSize: base.magSize + magAdd,
    reserveAmmo: base.reserveAmmo,
    reloadTimeS: round2(base.reloadTime + reloadAdd),
    cycleTimeS: round2(base.cycleTime * cycleMult),
    hipSpreadStandDeg: round1(base.hipSpreadStand * hipMult * RAD_TO_DEG),
    hipSpreadMovingDeg: round1(base.hipSpreadMoving * hipMult * RAD_TO_DEG),
    swayAmplitudeDeg: round2(base.swayAmplitude * swayMult * RAD_TO_DEG),
    adsMoveSpeed: round1(adsMoveSpeed),
    damageMult: round2(damageMult),
    recoilMult: round2(recoilMult),
    penetrationCount,
  };
}

export function baseStats(weapon: WeaponId): ResolvedStats {
  return resolveStats(weapon, []);
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;
