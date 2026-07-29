/**
 * DECKSHOT UI — hitmarkers.
 *
 * Owner: lobby-ui-hud.
 *
 * Subscribes to Effects.onHitmarker (viewmodel-vfx-audio's facade): white X
 * on hit, gold and larger on kill, red-tinted on headshot. The sound is
 * already played by the Effects facade; this only draws.
 */

import { useEffect, useState } from 'react';
import { Effects } from '../../gameplay/effects/index.js';
import type { HitmarkerKind } from '../../gameplay/effects/index.js';

export function Hitmarker(): JSX.Element | null {
  const [mark, setMark] = useState<{ kind: HitmarkerKind; key: number } | null>(null);

  useEffect(() => {
    let key = 0;
    const unsub = Effects.onHitmarker((kind) => {
      key++;
      setMark({ kind, key });
    });
    return unsub;
  }, []);

  if (!mark) return null;
  // The CSS animation runs forwards to opacity 0, so a stale marker is
  // invisible without any cleanup timer; a new key restarts the animation.
  return (
    <div key={mark.key} className={`ds-hitm ${mark.kind}`}>
      <span className="a" />
      <span className="b" />
      <span className="c" />
      <span className="d" />
    </div>
  );
}
