/**
 * DECKSHOT UI — settings overlay.
 *
 * Owner: lobby-ui-hud.
 *
 * Persisted to localStorage. Volume is applied to the Audio facade right
 * here; everything else reaches the engine through bridge.applySettings.
 */

import { SENSITIVITY_MAX, SENSITIVITY_MIN } from '../../../../shared/tuning.js';
import { Audio } from '../../audio/index.js';
import type { UISettings } from '../bridge.js';
import { FOV_MAX_DEG, FOV_MIN_DEG, saveSettings } from '../persist.js';
import { useUI, useUICtx } from '../store.js';
import { click } from '../util.js';

const QUALITIES: Array<UISettings['quality']> = ['low', 'medium', 'high'];

export function SettingsPanel(): JSX.Element {
  const { store, bridge, setOverlay } = useUICtx();
  const settings = useUI((s) => s.settings);

  const update = (patch: Partial<UISettings>): void => {
    const next = { ...settings, ...patch };
    store.patch({ settings: next });
    saveSettings(next);
    Audio.setMasterVolume(next.masterVolume);
    bridge.applySettings(next);
  };

  return (
    <div className="ds-overlay">
      <div className="ds-panel" style={{ width: 'min(460px, 94vw)' }}>
        <h2 style={{ margin: '0 0 14px', letterSpacing: '0.2em' }}>SETTINGS</h2>

        <div className="ds-set-row">
          <span className="ds-label" style={{ margin: 0 }}>
            Sensitivity
          </span>
          <input
            type="range"
            min={SENSITIVITY_MIN}
            max={SENSITIVITY_MAX}
            step={0.1}
            value={settings.sensitivity}
            onChange={(e) => update({ sensitivity: Number(e.target.value) })}
          />
          <span className="val">{settings.sensitivity.toFixed(1)}</span>
        </div>

        <div className="ds-set-row">
          <span className="ds-label" style={{ margin: 0 }}>
            Field of view
          </span>
          <input
            type="range"
            min={FOV_MIN_DEG}
            max={FOV_MAX_DEG}
            step={1}
            value={settings.fovDegrees}
            onChange={(e) => update({ fovDegrees: Number(e.target.value) })}
          />
          <span className="val">{settings.fovDegrees}°</span>
        </div>

        <div className="ds-set-row">
          <span className="ds-label" style={{ margin: 0 }}>
            Master volume
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.masterVolume}
            onChange={(e) => update({ masterVolume: Number(e.target.value) })}
          />
          <span className="val">{Math.round(settings.masterVolume * 100)}%</span>
        </div>

        <div className="ds-set-row">
          <span className="ds-label" style={{ margin: 0 }}>
            Quality
          </span>
          <div className="ds-seg">
            {QUALITIES.map((q) => (
              <button
                key={q}
                className={settings.quality === q ? 'on' : ''}
                onClick={() => {
                  click();
                  update({ quality: q });
                }}
              >
                {q}
              </button>
            ))}
          </div>
          <span />
        </div>

        <label className="ds-check" style={{ margin: '14px 0' }}>
          <input
            type="checkbox"
            checked={settings.invertY}
            onChange={(e) => update({ invertY: e.target.checked })}
          />
          Invert Y axis
        </label>

        <div className="ds-row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="ds-btn primary"
            onClick={() => {
              click();
              setOverlay('none');
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
