/**
 * DECKSHOT UI — all styles, injected as a <style> tag by mountUI.
 *
 * Owner: lobby-ui-hud.
 *
 * A CSS string rather than a .css import so the module graph stays plain
 * TypeScript — no bundler-specific loaders, no external fonts, no images.
 * Design goals: dark, high-contrast, readable in a firefight over a bright
 * sea (real contrast + text shadows), and fast — nothing fades slower than
 * ~150ms while someone is trying to shoot.
 */

export const UI_CSS = `
:root {
  --ui-ink: #eef4f8;
  --ui-dim: #9fb0bd;
  --ui-panel: rgba(7, 13, 20, 0.86);
  --ui-panel-soft: rgba(10, 18, 27, 0.72);
  --ui-line: rgba(150, 190, 215, 0.22);
  --ui-accent: #3be8c8;
  --ui-accent-dark: #0e8f79;
  --ui-gold: #ffc93c;
  --ui-red: #ff4d5a;
  --ui-green: #58e07c;
  --ui-alpha-team: #4da3ff;
  --ui-bravo-team: #ff8b4d;
  --ui-shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 0 12px rgba(0, 0, 0, 0.45);
}

.ds-root, .ds-root * { box-sizing: border-box; }
.ds-root {
  position: absolute; inset: 0;
  pointer-events: none;
  color: var(--ui-ink);
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  user-select: none; -webkit-user-select: none;
}

/* ---------------------------------------------------------------- screens */
.ds-screen {
  position: absolute; inset: 0;
  pointer-events: auto;
  display: flex; align-items: center; justify-content: center;
  background:
    radial-gradient(120% 90% at 50% 10%, rgba(8, 20, 32, 0.55) 0%, rgba(4, 8, 13, 0.88) 78%);
  overflow-y: auto;
}
.ds-panel {
  background: var(--ui-panel);
  border: 1px solid var(--ui-line);
  border-radius: 10px;
  padding: 28px 32px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
}
.ds-title {
  font-size: 52px; font-weight: 900; letter-spacing: 0.22em; margin: 0 0 4px;
  color: var(--ui-ink); text-shadow: 0 0 24px rgba(59, 232, 200, 0.35), var(--ui-shadow);
}
.ds-title .accent { color: var(--ui-accent); }
.ds-sub { color: var(--ui-dim); letter-spacing: 0.14em; font-size: 12px; margin: 0 0 24px; text-transform: uppercase; }

.ds-label { display:block; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ui-dim); margin: 14px 0 6px; }
.ds-input {
  width: 100%; padding: 12px 14px; font-size: 18px; font-weight: 600;
  color: var(--ui-ink); background: rgba(255,255,255,0.06);
  border: 1px solid var(--ui-line); border-radius: 6px; outline: none;
  font-family: inherit;
}
.ds-input:focus { border-color: var(--ui-accent); box-shadow: 0 0 0 2px rgba(59,232,200,0.25); }
.ds-input.code {
  font-size: 34px; letter-spacing: 0.55em; text-align: center; text-transform: uppercase;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-weight: 800;
  padding-left: calc(14px + 0.55em);
}
.ds-input.shake { animation: ds-shake 0.24s; border-color: var(--ui-red); }
@keyframes ds-shake {
  0%,100% { transform: translateX(0); } 25% { transform: translateX(-6px); }
  50% { transform: translateX(5px); } 75% { transform: translateX(-3px); }
}

.ds-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 13px 22px; border-radius: 6px; border: 1px solid var(--ui-line);
  background: rgba(255,255,255,0.07); color: var(--ui-ink);
  font: inherit; font-size: 14px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase;
  cursor: pointer; transition: transform 80ms, background 80ms, border-color 80ms, box-shadow 80ms;
}
.ds-btn:hover { background: rgba(255,255,255,0.13); border-color: rgba(180,220,240,0.4); }
.ds-btn:active { transform: translateY(1px) scale(0.99); }
.ds-btn:disabled { opacity: 0.45; cursor: default; transform: none; }
.ds-btn.primary {
  background: linear-gradient(180deg, #35d9ba, #14a98c); color: #04241d; border-color: transparent;
  box-shadow: 0 4px 18px rgba(35, 200, 170, 0.35);
}
.ds-btn.primary:hover { background: linear-gradient(180deg, #4df0d1, #19b99a); }
.ds-btn.big { width: 100%; padding: 16px 22px; font-size: 16px; }
.ds-btn.ghost { background: transparent; }
.ds-btn.danger { border-color: rgba(255,77,90,0.5); color: var(--ui-red); }
.ds-btn.gold { background: linear-gradient(180deg, #ffd45e, #e0a418); color: #241a00; border-color: transparent; }
.ds-btn.ready-on { background: linear-gradient(180deg, #58e07c, #23a04a); color: #032b12; border-color: transparent; }
.ds-row { display: flex; gap: 10px; align-items: center; }
.ds-col { display: flex; flex-direction: column; gap: 10px; }

/* ------------------------------------------------------------- big code */
.ds-code-big {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: clamp(64px, 11vw, 118px); font-weight: 900; letter-spacing: 0.28em;
  text-align: center; line-height: 1; margin: 6px 0 2px; padding-left: 0.28em;
  color: var(--ui-ink);
  text-shadow: 0 0 34px rgba(59, 232, 200, 0.5), 0 2px 4px rgba(0,0,0,0.9);
}
.ds-code-hint { text-align: center; color: var(--ui-dim); letter-spacing: 0.18em; font-size: 11px; text-transform: uppercase; }

/* --------------------------------------------------------- player table */
.ds-players { width: 100%; border-collapse: collapse; margin-top: 8px; }
.ds-players td { padding: 8px 10px; border-bottom: 1px solid rgba(150,190,215,0.12); font-size: 15px; }
.ds-players tr.me td { background: rgba(59,232,200,0.06); }
.ds-players tr.gone td { opacity: 0.4; font-style: italic; }
.ds-tag { font-size: 10px; font-weight: 800; letter-spacing: 0.1em; padding: 2px 7px; border-radius: 4px; vertical-align: middle; }
.ds-tag.host { background: var(--ui-gold); color: #241a00; }
.ds-tag.ready { background: var(--ui-green); color: #032b12; }
.ds-tag.notready { background: rgba(255,255,255,0.12); color: var(--ui-dim); }
.ds-tag.alpha { background: var(--ui-alpha-team); color: #021d3a; }
.ds-tag.bravo { background: var(--ui-bravo-team); color: #331602; }
.ds-ping { color: var(--ui-dim); font-variant-numeric: tabular-nums; font-size: 13px; }

.ds-seg { display: inline-flex; border: 1px solid var(--ui-line); border-radius: 6px; overflow: hidden; }
.ds-seg button {
  padding: 8px 14px; font: inherit; font-size: 12px; font-weight: 800; letter-spacing: 0.1em;
  text-transform: uppercase; background: transparent; color: var(--ui-dim); border: 0; cursor: pointer;
}
.ds-seg button.on { background: var(--ui-accent); color: #04241d; }
.ds-seg button:disabled { cursor: default; opacity: 0.6; }

/* -------------------------------------------------------------- overlay */
.ds-overlay {
  position: absolute; inset: 0; pointer-events: auto; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  background: rgba(3, 6, 10, 0.78);
}
.ds-overlay .ds-panel { max-height: 88vh; overflow-y: auto; }

/* -------------------------------------------------------------- loadout */
.ds-atts { display: grid; grid-template-columns: repeat(2, minmax(210px, 1fr)); gap: 8px; }
.ds-att {
  text-align: left; padding: 10px 12px; border: 1px solid var(--ui-line); border-radius: 6px;
  background: rgba(255,255,255,0.05); cursor: pointer; color: var(--ui-ink); font: inherit;
  transition: border-color 80ms, background 80ms;
}
.ds-att:hover { background: rgba(255,255,255,0.1); }
.ds-att.on { border-color: var(--ui-accent); background: rgba(59,232,200,0.12); box-shadow: inset 0 0 0 1px var(--ui-accent); }
.ds-att.blocked { opacity: 0.4; cursor: default; }
.ds-att .n { font-weight: 800; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; }
.ds-att .d { font-size: 12px; color: var(--ui-dim); margin-top: 2px; }
.ds-stats { width: 100%; border-collapse: collapse; }
.ds-stats td { padding: 5px 8px; font-size: 13px; border-bottom: 1px solid rgba(150,190,215,0.1); font-variant-numeric: tabular-nums; }
.ds-stats td:first-child { color: var(--ui-dim); text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; }
.ds-delta-good { color: var(--ui-green); font-weight: 700; }
.ds-delta-bad { color: var(--ui-red); font-weight: 700; }
.ds-camos { display: flex; gap: 8px; }
.ds-camo { width: 44px; height: 30px; border-radius: 5px; border: 2px solid transparent; cursor: pointer; padding: 0; }
.ds-camo.on { border-color: var(--ui-accent); box-shadow: 0 0 0 2px rgba(59,232,200,0.3); }

/* ------------------------------------------------------------------ HUD */
.ds-hud { position: absolute; inset: 0; pointer-events: none; }
.ds-hud-text { text-shadow: var(--ui-shadow); }

.ds-topbar {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 14px;
  background: var(--ui-panel-soft); border: 1px solid var(--ui-line); border-radius: 8px;
  padding: 6px 16px; text-shadow: var(--ui-shadow);
}
.ds-clock { font-size: 22px; font-weight: 900; font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
.ds-clock.low { color: var(--ui-red); animation: ds-pulse 1s infinite; }
.ds-limit { font-size: 12px; color: var(--ui-dim); letter-spacing: 0.1em; font-variant-numeric: tabular-nums; }
.ds-teamscore { font-size: 18px; font-weight: 900; font-variant-numeric: tabular-nums; }
.ds-teamscore.alpha { color: var(--ui-alpha-team); }
.ds-teamscore.bravo { color: var(--ui-bravo-team); }
@keyframes ds-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }

.ds-scorebox {
  position: absolute; top: 14px; left: 14px;
  background: var(--ui-panel-soft); border: 1px solid var(--ui-line); border-radius: 8px;
  padding: 8px 14px; text-shadow: var(--ui-shadow); min-width: 132px;
}
.ds-scorebox .k { font-size: 26px; font-weight: 900; font-variant-numeric: tabular-nums; display: inline-block; }
.ds-scorebox .k.pop { animation: ds-pop 0.34s cubic-bezier(0.2, 2.4, 0.4, 1); color: var(--ui-gold); }
.ds-scorebox .lbl { font-size: 10px; letter-spacing: 0.16em; color: var(--ui-dim); text-transform: uppercase; }
.ds-scorebox .row2 { font-size: 12px; color: var(--ui-dim); font-variant-numeric: tabular-nums; }
.ds-streak { color: var(--ui-gold); font-weight: 800; }
@keyframes ds-pop { 0% { transform: scale(1); } 35% { transform: scale(1.75); } 100% { transform: scale(1); } }

/* health */
.ds-health { position: absolute; left: 18px; bottom: 18px; width: 240px; text-shadow: var(--ui-shadow); }
.ds-health .num { font-size: 34px; font-weight: 900; font-variant-numeric: tabular-nums; line-height: 1; }
.ds-health.low .num { color: var(--ui-red); animation: ds-pulse 0.8s infinite; }
.ds-health .bar { height: 7px; border-radius: 4px; background: rgba(255,255,255,0.14); margin-top: 6px; overflow: hidden; border: 1px solid rgba(0,0,0,0.5); }
.ds-health .fill { height: 100%; background: linear-gradient(90deg, var(--ui-accent), #7df0da); transition: width 120ms; }
.ds-health.low .fill { background: linear-gradient(90deg, #ff4d5a, #ff8a7a); }

/* ammo */
.ds-ammo { position: absolute; right: 18px; bottom: 18px; text-align: right; text-shadow: var(--ui-shadow); }
.ds-ammo .mag { font-size: 44px; font-weight: 900; font-variant-numeric: tabular-nums; line-height: 1; }
.ds-ammo .mag.empty { color: var(--ui-red); }
.ds-ammo .res { font-size: 20px; color: var(--ui-dim); font-weight: 700; font-variant-numeric: tabular-nums; }
.ds-ammo .wpn { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ui-dim); margin-top: 4px; }
.ds-ammo .chips { display: flex; gap: 4px; justify-content: flex-end; margin-top: 4px; }
.ds-ammo .chip { font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; padding: 2px 6px; border-radius: 3px; background: rgba(255,255,255,0.12); color: var(--ui-dim); }
.ds-reload { color: var(--ui-gold); font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase; animation: ds-pulse 0.7s infinite; }

/* crosshair */
.ds-cross { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.ds-cross span { position: absolute; background: rgba(255,255,255,0.92); box-shadow: 0 0 3px rgba(0,0,0,0.9); }
.ds-cross .h { width: 8px; height: 2px; top: -1px; }
.ds-cross .v { width: 2px; height: 8px; left: -1px; }
.ds-cross .l { left: -12px; } .ds-cross .r { left: 4px; }
.ds-cross .t { top: -12px; } .ds-cross .b { top: 4px; }
.ds-cross .dot { width: 2px; height: 2px; left: -1px; top: -1px; border-radius: 50%; }

/* hitmarker */
.ds-hitm { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.ds-hitm span {
  position: absolute; width: 12px; height: 2px; left: -6px; top: -1px;
  background: #fff; box-shadow: 0 0 4px rgba(0,0,0,0.9);
  animation: ds-hitfade 0.22s forwards;
}
.ds-hitm .a { transform: translate(-7px, -7px) rotate(45deg); }
.ds-hitm .b { transform: translate(7px, -7px) rotate(-45deg); }
.ds-hitm .c { transform: translate(-7px, 7px) rotate(-45deg); }
.ds-hitm .d { transform: translate(7px, 7px) rotate(45deg); }
.ds-hitm.kill span { background: var(--ui-gold); width: 15px; left: -7.5px; animation-duration: 0.4s; box-shadow: 0 0 8px rgba(255,201,60,0.8); }
.ds-hitm.kill .a { transform: translate(-9px, -9px) rotate(45deg) scale(1.15); }
.ds-hitm.kill .b { transform: translate(9px, -9px) rotate(-45deg) scale(1.15); }
.ds-hitm.kill .c { transform: translate(-9px, 9px) rotate(-45deg) scale(1.15); }
.ds-hitm.kill .d { transform: translate(9px, 9px) rotate(45deg) scale(1.15); }
.ds-hitm.headshot span { background: #ff6b6b; box-shadow: 0 0 6px rgba(255,77,90,0.9); }
@keyframes ds-hitfade { 0% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }

/* killfeed */
.ds-feed { position: absolute; top: 14px; right: 14px; display: flex; flex-direction: column; gap: 5px; align-items: flex-end; max-width: 44vw; }
.ds-feed-item {
  display: flex; align-items: center; gap: 8px;
  background: var(--ui-panel-soft); border: 1px solid var(--ui-line); border-radius: 6px;
  padding: 4px 10px; font-size: 13px; font-weight: 700; text-shadow: var(--ui-shadow);
  animation: ds-feedin 0.14s ease-out;
}
.ds-feed-item.trick { border-color: rgba(255,201,60,0.65); box-shadow: 0 0 14px rgba(255,201,60,0.25); }
.ds-feed-item.me { border-color: rgba(59,232,200,0.65); }
.ds-feed-item .who { max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-feed-item .victim { color: var(--ui-red); }
.ds-feed-item .wpn { font-size: 9px; letter-spacing: 0.1em; color: var(--ui-dim); border: 1px solid var(--ui-line); border-radius: 3px; padding: 1px 5px; }
.ds-feed-item .hs { color: #ff6b6b; font-size: 10px; font-weight: 900; }
.ds-feed-item .trick-lbl { color: var(--ui-gold); font-size: 10px; letter-spacing: 0.08em; }
@keyframes ds-feedin { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }

/* trickshot banner */
.ds-banner {
  position: absolute; left: 50%; top: 26%; transform: translateX(-50%);
  text-align: center; pointer-events: none;
  animation: ds-bannerin 0.32s cubic-bezier(0.18, 1.6, 0.35, 1);
}
.ds-banner .line1 {
  font-size: clamp(28px, 4.4vw, 46px); font-weight: 900; letter-spacing: 0.18em;
  color: var(--ui-gold);
  text-shadow: 0 0 26px rgba(255, 201, 60, 0.6), 0 2px 3px rgba(0,0,0,0.95);
  white-space: nowrap;
}
.ds-banner .line2 { font-size: 18px; font-weight: 800; color: var(--ui-ink); text-shadow: var(--ui-shadow); letter-spacing: 0.3em; margin-top: 2px; }
.ds-banner.fading { animation: ds-bannerout 0.3s forwards; }
@keyframes ds-bannerin { 0% { transform: translateX(-50%) scale(2.1); opacity: 0; } 100% { transform: translateX(-50%) scale(1); opacity: 1; } }
@keyframes ds-bannerout { to { opacity: 0; transform: translateX(-50%) scale(0.92); } }

/* countdown */
.ds-count { position: absolute; left: 50%; top: 34%; transform: translateX(-50%); text-align: center; text-shadow: var(--ui-shadow); }
.ds-count .n { font-size: 110px; font-weight: 900; color: var(--ui-accent); line-height: 1; text-shadow: 0 0 40px rgba(59,232,200,0.55), 0 3px 6px rgba(0,0,0,0.9); animation: ds-pop 0.9s infinite; }
.ds-count .t { font-size: 14px; letter-spacing: 0.4em; text-transform: uppercase; color: var(--ui-dim); }

/* damage vignette + indicators */
.ds-vignette { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(58% 58% at 50% 50%, rgba(0,0,0,0) 55%, rgba(180, 10, 20, 0.55) 100%);
  transition: opacity 150ms; }
.ds-dmg { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.ds-dmg .arc { position: absolute; left: -60px; top: -60px; width: 120px; height: 120px; animation: ds-hitfade 0.9s forwards; }

/* death overlay */
.ds-death { position: absolute; inset: 0; pointer-events: none; display: flex; align-items: center; justify-content: center; }
.ds-death .bars { position: absolute; inset: 0; pointer-events: none; }
.ds-death .bars::before, .ds-death .bars::after {
  content: ''; position: absolute; left: 0; right: 0; height: 11vh; background: rgba(2,4,7,0.92);
}
.ds-death .bars::before { top: 0; } .ds-death .bars::after { bottom: 0; }
.ds-death .card { pointer-events: auto; text-align: center; background: var(--ui-panel); border: 1px solid var(--ui-line); border-radius: 10px; padding: 22px 34px; margin-top: 24vh; }
.ds-death .by { font-size: 12px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--ui-dim); }
.ds-death .killer { font-size: 30px; font-weight: 900; margin: 4px 0; }
.ds-death .how { font-size: 13px; color: var(--ui-dim); font-variant-numeric: tabular-nums; }
.ds-death .trick { color: var(--ui-gold); font-weight: 800; letter-spacing: 0.14em; margin-top: 4px; }
.ds-death .timer { font-size: 44px; font-weight: 900; margin: 10px 0 4px; font-variant-numeric: tabular-nums; color: var(--ui-accent); }
.ds-death .hint { font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--ui-dim); margin-bottom: 12px; }

/* scoreboard */
.ds-board {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  background: var(--ui-panel); border: 1px solid var(--ui-line); border-radius: 10px;
  padding: 18px 22px; min-width: min(680px, 92vw); z-index: 30;
}
.ds-board.inline { position: static; transform: none; min-width: 0; background: transparent; border: 0; padding: 0; box-shadow: none; }
.ds-board h3 { margin: 0 0 4px; letter-spacing: 0.2em; font-size: 13px; text-transform: uppercase; color: var(--ui-dim); }
.ds-board table { width: 100%; border-collapse: collapse; }
.ds-board th { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ui-dim); text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--ui-line); }
.ds-board th:first-child, .ds-board td:first-child { text-align: left; }
.ds-board td { padding: 6px 8px; font-size: 14px; text-align: right; font-variant-numeric: tabular-nums; border-bottom: 1px solid rgba(150,190,215,0.08); }
.ds-board tr.me td { background: rgba(59,232,200,0.08); }
.ds-board .trickcell { font-size: 11px; color: var(--ui-gold); letter-spacing: 0.04em; }
.ds-board .teamhead td { font-weight: 900; letter-spacing: 0.16em; font-size: 12px; padding-top: 12px; }

/* match over */
.ds-over-winner { font-size: 34px; font-weight: 900; letter-spacing: 0.14em; text-align: center; margin: 0; text-shadow: var(--ui-shadow); }
.ds-over-winner.alpha { color: var(--ui-alpha-team); } .ds-over-winner.bravo { color: var(--ui-bravo-team); }
.ds-over-best {
  margin: 14px 0; padding: 12px 18px; border-radius: 8px; text-align: center;
  background: linear-gradient(180deg, rgba(255,201,60,0.16), rgba(255,201,60,0.05));
  border: 1px solid rgba(255,201,60,0.5);
}
.ds-over-best .lbl { font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--ui-dim); }
.ds-over-best .txt { font-size: 22px; font-weight: 900; letter-spacing: 0.12em; color: var(--ui-gold); }
.ds-over-best .who { font-size: 13px; color: var(--ui-ink); margin-top: 2px; }

/* toast + connecting */
.ds-toast {
  position: absolute; top: 68px; left: 50%; transform: translateX(-50%);
  background: rgba(60, 8, 14, 0.94); border: 1px solid var(--ui-red); color: #ffd9dc;
  border-radius: 8px; padding: 10px 18px; font-size: 14px; font-weight: 700;
  pointer-events: none; z-index: 60; animation: ds-feedin 0.15s; text-shadow: none;
}
.ds-busy { position: absolute; inset: 0; z-index: 50; pointer-events: auto; display: flex; align-items: center; justify-content: center; background: rgba(3,6,10,0.6); }
.ds-busy .txt { font-size: 16px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--ui-accent); animation: ds-pulse 1.1s infinite; text-shadow: var(--ui-shadow); }

/* settings */
.ds-set-row { display: grid; grid-template-columns: 150px 1fr 64px; align-items: center; gap: 12px; margin: 12px 0; }
.ds-set-row .val { text-align: right; font-variant-numeric: tabular-nums; color: var(--ui-accent); font-weight: 700; }
.ds-set-row input[type=range] { width: 100%; accent-color: var(--ui-accent); }
.ds-check { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 14px; }
.ds-check input { width: 18px; height: 18px; accent-color: var(--ui-accent); }

.ds-copied { color: var(--ui-green); }
`;
