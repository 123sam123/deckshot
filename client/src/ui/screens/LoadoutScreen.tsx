/**
 * DECKSHOT UI — loadout overlay.
 *
 * Owner: lobby-ui-hud.
 *
 * Stat numbers are computed from shared/tuning.ts via loadoutMath — real
 * deltas (Fast Draw: ADS 340ms -> 211ms), never hand-written copy.
 */

import { useMemo, useState } from 'react';
import { ATTACHMENTS, WEAPONS } from '../../../../shared/tuning.js';
import { AttachmentId, CamoId, MAX_ATTACHMENTS, WeaponId } from '../../../../shared/types.js';
import type { Loadout } from '../../../../shared/types.js';
import { baseStats, resolveStats } from '../loadoutMath.js';
import type { ResolvedStats } from '../loadoutMath.js';
import { saveLoadout } from '../persist.js';
import { useUI, useUICtx } from '../store.js';
import { click, hover } from '../util.js';

const ALL_ATTACHMENTS: AttachmentId[] = [
  AttachmentId.FastDraw,
  AttachmentId.VariableZoom,
  AttachmentId.StabilizerCPU,
  AttachmentId.FMJ,
  AttachmentId.ExtendedMag,
  AttachmentId.Suppressor,
  AttachmentId.Laser,
  AttachmentId.LightweightStock,
  AttachmentId.IronSightSwap,
  AttachmentId.BallisticCompensator,
];

const CAMOS: Array<{ id: CamoId; name: string; css: string }> = [
  { id: CamoId.Gunmetal, name: 'Gunmetal', css: 'linear-gradient(135deg,#3a4048,#20242a)' },
  { id: CamoId.Arctic, name: 'Arctic', css: 'linear-gradient(135deg,#e8eef2,#9fb3c0)' },
  { id: CamoId.Carbon, name: 'Carbon', css: 'repeating-linear-gradient(45deg,#15181c 0 4px,#23272e 4px 8px)' },
  { id: CamoId.Tiger, name: 'Tiger', css: 'repeating-linear-gradient(60deg,#c98a2b 0 6px,#1d1a14 6px 11px)' },
  { id: CamoId.Chrome, name: 'Chrome', css: 'linear-gradient(135deg,#f4f8fb,#7e8b96 45%,#cfd9e0)' },
  { id: CamoId.Gold, name: 'Gold', css: 'linear-gradient(135deg,#ffe28a,#c99416 55%,#ffd45e)' },
];

interface StatRow {
  label: string;
  unit: string;
  get: (s: ResolvedStats) => number;
  /** true when a LOWER value is better (ADS time, spread…). */
  lowerIsBetter: boolean;
}

const STAT_ROWS: StatRow[] = [
  { label: 'ADS time', unit: 'ms', get: (s) => s.adsTimeMs, lowerIsBetter: true },
  { label: 'Bolt cycle', unit: 's', get: (s) => s.cycleTimeS, lowerIsBetter: true },
  { label: 'Mag size', unit: 'rds', get: (s) => s.magSize, lowerIsBetter: false },
  { label: 'Reload', unit: 's', get: (s) => s.reloadTimeS, lowerIsBetter: true },
  { label: 'Hipfire spread', unit: 'deg', get: (s) => s.hipSpreadStandDeg, lowerIsBetter: true },
  { label: 'Moving hipfire', unit: 'deg', get: (s) => s.hipSpreadMovingDeg, lowerIsBetter: true },
  { label: 'Scope sway', unit: 'deg', get: (s) => s.swayAmplitudeDeg, lowerIsBetter: true },
  { label: 'ADS move speed', unit: 'm/s', get: (s) => s.adsMoveSpeed, lowerIsBetter: false },
  { label: 'Damage', unit: 'x', get: (s) => s.damageMult, lowerIsBetter: false },
  { label: 'Recoil', unit: 'x', get: (s) => s.recoilMult, lowerIsBetter: true },
  { label: 'Penetration', unit: 'walls', get: (s) => s.penetrationCount, lowerIsBetter: false },
];

export function LoadoutScreen(): JSX.Element {
  const { store, bridge, setOverlay } = useUICtx();
  const saved = useUI((s) => s.loadout);
  const inMatch = useUI((s) => s.lobby)?.inProgress ?? false;

  const [primary, setPrimary] = useState<WeaponId>(saved.primary);
  const [atts, setAtts] = useState<AttachmentId[]>(
    saved.attachments.filter((a) => a !== AttachmentId.None),
  );
  const [camo, setCamo] = useState<CamoId>(saved.camo);

  const stats = useMemo(() => resolveStats(primary, atts), [primary, atts]);
  const base = useMemo(() => baseStats(primary), [primary]);

  const toggleAtt = (a: AttachmentId): void => {
    click();
    setAtts((cur) =>
      cur.includes(a) ? cur.filter((x) => x !== a) : cur.length < MAX_ATTACHMENTS ? [...cur, a] : cur,
    );
  };

  const apply = (): void => {
    click();
    const padded: AttachmentId[] = [...atts];
    while (padded.length < MAX_ATTACHMENTS) padded.push(AttachmentId.None);
    const loadout: Loadout = {
      primary,
      attachments: [padded[0], padded[1], padded[2]],
      camo,
    };
    store.patch({ loadout });
    saveLoadout(loadout);
    bridge.setLoadout(loadout);
    setOverlay('none');
  };

  return (
    <div className="ds-overlay">
      <div className="ds-panel" style={{ width: 'min(860px, 96vw)' }}>
        <div className="ds-row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, letterSpacing: '0.2em' }}>LOADOUT</h2>
          <span className="ds-code-hint">
            {inMatch ? 'Applies on your next respawn' : `${atts.length}/${MAX_ATTACHMENTS} attachments`}
          </span>
        </div>

        <label className="ds-label">Primary</label>
        <div className="ds-seg">
          {[WeaponId.Talon, WeaponId.Kestrel].map((w) => (
            <button
              key={w}
              className={primary === w ? 'on' : ''}
              onMouseEnter={hover}
              onClick={() => {
                click();
                setPrimary(w);
              }}
            >
              {WEAPONS[w].name}
            </button>
          ))}
        </div>

        <div
          className="ds-row"
          style={{ alignItems: 'flex-start', gap: 22, marginTop: 16, flexWrap: 'wrap' }}
        >
          <div style={{ flex: '1 1 440px' }}>
            <label className="ds-label" style={{ marginTop: 0 }}>
              Attachments — pick up to {MAX_ATTACHMENTS}
            </label>
            <div className="ds-atts">
              {ALL_ATTACHMENTS.map((a) => {
                const spec = ATTACHMENTS[a];
                const on = atts.includes(a);
                const blocked = !on && atts.length >= MAX_ATTACHMENTS;
                return (
                  <button
                    key={a}
                    className={`ds-att${on ? ' on' : ''}${blocked ? ' blocked' : ''}`}
                    onMouseEnter={hover}
                    onClick={() => !blocked && toggleAtt(a)}
                  >
                    <div className="n">{spec.name}</div>
                    <div className="d">{spec.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ flex: '1 1 280px' }}>
            <label className="ds-label" style={{ marginTop: 0 }}>
              Computed stats
            </label>
            <table className="ds-stats">
              <tbody>
                {STAT_ROWS.map((row) => {
                  const b = row.get(base);
                  const v = row.get(stats);
                  const changed = v !== b;
                  const better = row.lowerIsBetter ? v < b : v > b;
                  return (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      <td style={{ textAlign: 'right' }}>
                        {changed ? (
                          <>
                            <span style={{ color: 'var(--ui-dim)' }}>
                              {b}
                              {row.unit === 'x' || row.unit === 'deg' ? '' : ' '}
                              {row.unit === 'x' ? 'x' : row.unit}
                            </span>{' '}
                            <span className={better ? 'ds-delta-good' : 'ds-delta-bad'}>
                              → {v}
                              {row.unit === 'x' ? 'x' : ` ${row.unit}`}
                            </span>
                          </>
                        ) : (
                          <span>
                            {v}
                            {row.unit === 'x' ? 'x' : ` ${row.unit}`}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <label className="ds-label">Camo</label>
            <div className="ds-camos">
              {CAMOS.map((c) => (
                <button
                  key={c.id}
                  className={`ds-camo${camo === c.id ? ' on' : ''}`}
                  style={{ background: c.css }}
                  title={c.name}
                  onClick={() => {
                    click();
                    setCamo(c.id);
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="ds-row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
          <button
            className="ds-btn ghost"
            onClick={() => {
              click();
              setOverlay('none');
            }}
          >
            Cancel
          </button>
          <button className="ds-btn primary" onMouseEnter={hover} onClick={apply}>
            {inMatch ? 'Apply on respawn' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
