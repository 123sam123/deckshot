/**
 * DECKSHOT UI — top-level screen router.
 *
 * Owner: lobby-ui-hud.
 *
 * Screen derivation (no imperative navigation, the server state decides):
 *   no lobby                          -> landing
 *   lobby, phase Warmup               -> lobby screen
 *   lobby, Countdown / Live / Over    -> HUD (MatchOver overlays during Over)
 */

import { useMemo, useState } from 'react';
import { RoundPhase } from '../../../shared/types.js';
import type { UIBridge } from './bridge.js';
import { HUD } from './hud/HUD.js';
import { useNow } from './hud/hooks.js';
import { Landing } from './screens/Landing.js';
import { LoadoutScreen } from './screens/LoadoutScreen.js';
import { LobbyScreen } from './screens/LobbyScreen.js';
import { MatchOverScreen } from './screens/MatchOverScreen.js';
import { SettingsPanel } from './screens/SettingsPanel.js';
import { UICtx, useUI } from './store.js';
import type { Overlay, UIStore } from './store.js';

const TOAST_TTL_MS = 3_500;

export function App({ store, bridge }: { store: UIStore; bridge: UIBridge }): JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>('none');
  const ctx = useMemo(
    () => ({ store, bridge, overlay, setOverlay }),
    [store, bridge, overlay],
  );
  return (
    <UICtx.Provider value={ctx}>
      <div className="ds-root">
        <Router />
        {overlay === 'settings' ? <SettingsPanel /> : null}
        {overlay === 'loadout' ? <LoadoutScreen /> : null}
        <ErrorToast />
        <ConnectionNotice />
      </div>
    </UICtx.Provider>
  );
}

function Router(): JSX.Element {
  const lobby = useUI((s) => s.lobby);
  const phase = useUI((s) => s.round).phase;

  if (!lobby) return <Landing />;
  if (phase === RoundPhase.Warmup) return <LobbyScreen />;
  return (
    <>
      <HUD />
      {phase === RoundPhase.Over ? <MatchOverScreen /> : null}
    </>
  );
}

function ErrorToast(): JSX.Element | null {
  const error = useUI((s) => s.error);
  const now = useNow(500);
  if (!error || now - error.at > TOAST_TTL_MS) return null;
  return <div className="ds-toast">{error.message}</div>;
}

function ConnectionNotice(): JSX.Element | null {
  const connection = useUI((s) => s.connection);
  if (connection !== 'reconnecting' && connection !== 'disconnected') return null;
  return (
    <div className="ds-busy">
      <div className="txt">
        {connection === 'reconnecting' ? 'Reconnecting…' : 'Connection lost'}
      </div>
    </div>
  );
}
