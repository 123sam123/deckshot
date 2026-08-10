/**
 * DECKSHOT UI — localStorage persistence (name, settings, loadout).
 * Owner: lobby-ui-hud. Every read tolerates garbage; every write is try/catch.
 */

import {
  DEFAULT_SENSITIVITY,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
} from '../../../shared/tuning.js';
import {
  AttachmentId,
  CamoId,
  DEFAULT_LOADOUT,
  MAX_ATTACHMENTS,
  SkinId,
  WeaponId,
} from '../../../shared/types.js';
import type { Loadout } from '../../../shared/types.js';
import type { UISettings } from './bridge.js';

const KEY_NAME = 'deckshot.name';
const KEY_SETTINGS = 'deckshot.settings';
const KEY_LOADOUT = 'deckshot.loadout';

export const FOV_MIN_DEG = 70;
export const FOV_MAX_DEG = 110;

export const DEFAULT_SETTINGS: UISettings = {
  sensitivity: DEFAULT_SENSITIVITY,
  fovDegrees: 90,
  invertY: false,
  masterVolume: 0.8,
  quality: 'high',
};

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — persistence is best-effort */
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function loadName(): string {
  return (read(KEY_NAME) ?? '').slice(0, 16);
}

export function saveName(name: string): void {
  write(KEY_NAME, name.slice(0, 16));
}

export function loadSettings(): UISettings {
  const raw = read(KEY_SETTINGS);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const p = JSON.parse(raw) as Partial<UISettings>;
    return {
      sensitivity: clamp(Number(p.sensitivity) || DEFAULT_SENSITIVITY, SENSITIVITY_MIN, SENSITIVITY_MAX),
      fovDegrees: clamp(Number(p.fovDegrees) || 90, FOV_MIN_DEG, FOV_MAX_DEG),
      invertY: !!p.invertY,
      masterVolume: clamp(Number(p.masterVolume ?? 0.8), 0, 1),
      quality: p.quality === 'low' || p.quality === 'medium' ? p.quality : 'high',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: UISettings): void {
  write(KEY_SETTINGS, JSON.stringify(s));
}

export function loadLoadout(): Loadout {
  const raw = read(KEY_LOADOUT);
  const fallback: Loadout = { ...DEFAULT_LOADOUT, attachments: [...DEFAULT_LOADOUT.attachments] };
  if (!raw) return fallback;
  try {
    const p = JSON.parse(raw) as Partial<Loadout>;
    const atts: AttachmentId[] = [];
    if (Array.isArray(p.attachments)) {
      for (const a of p.attachments) {
        if (
          typeof a === 'number' &&
          Number.isInteger(a) &&
          a > AttachmentId.None &&
          a <= AttachmentId.BallisticCompensator &&
          !atts.includes(a) &&
          atts.length < MAX_ATTACHMENTS
        ) {
          atts.push(a);
        }
      }
    }
    while (atts.length < MAX_ATTACHMENTS) atts.push(AttachmentId.None);
    const primary =
      p.primary === WeaponId.Talon || p.primary === WeaponId.Kestrel
        ? p.primary
        : DEFAULT_LOADOUT.primary;
    const camo =
      typeof p.camo === 'number' && p.camo >= CamoId.Gunmetal && p.camo <= CamoId.Gold
        ? p.camo
        : DEFAULT_LOADOUT.camo;
    // Loadouts stored before skins existed have no `skin` — default, don't drop.
    const skin =
      typeof p.skin === 'number' && Number.isInteger(p.skin) && p.skin >= SkinId.Vanguard && p.skin <= SkinId.Breacher
        ? p.skin
        : DEFAULT_LOADOUT.skin;
    return { primary, attachments: [atts[0], atts[1], atts[2]], camo, skin };
  } catch {
    return fallback;
  }
}

export function saveLoadout(l: Loadout): void {
  write(KEY_LOADOUT, JSON.stringify(l));
}
