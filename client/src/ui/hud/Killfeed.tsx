/**
 * DECKSHOT UI — killfeed (top right) + the trickshot banner.
 *
 * Owner: lobby-ui-hud.
 *
 * The banner is the game's reward loop: gold, huge, punchy scale-in, and
 * built from describeTrickshot so "360 NO-SCOPE COLLATERAL" reads exactly
 * like the clip title it is about to become.
 */

import { useUI } from '../store.js';
import { useNow } from './hooks.js';

const FEED_TTL_MS = 6_000;
const BANNER_TTL_MS = 2_600;
const BANNER_FADE_MS = 2_200;

export function Killfeed(): JSX.Element {
  const feed = useUI((s) => s.killfeed);
  const now = useNow(500);
  const live = feed.filter((f) => now - f.at < FEED_TTL_MS);
  return (
    <div className="ds-feed" aria-live="polite">
      {live.map((f) => (
        <div key={f.key} className={`ds-feed-item${f.trickshot ? ' trick' : ''}${f.byMe ? ' me' : ''}`}>
          <span className="who">{f.killerName}</span>
          <span className="wpn">{f.weaponName}</span>
          {f.headshot ? <span className="hs">HS</span> : null}
          <span className="who victim">{f.victimName}</span>
          {f.trickshot ? <span className="trick-lbl">{f.trickshot}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function TrickshotBanner(): JSX.Element | null {
  const banner = useUI((s) => s.banner);
  const now = useNow(120);
  if (!banner || now - banner.at > BANNER_TTL_MS) return null;
  const fading = now - banner.at > BANNER_FADE_MS;
  return (
    <div key={banner.key} className={`ds-banner${fading ? ' fading' : ''}`}>
      <div className="line1">{banner.text}</div>
      <div className="line2">+{banner.score}</div>
    </div>
  );
}
