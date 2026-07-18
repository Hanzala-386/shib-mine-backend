---
name: Arcade perf-core adaptive resolution
description: How the per-game perf-core.js FPS rescue works — dpr cap, resolution ladder, engine-specific glue, and pointer-coord traps.
---

# perf-core.js pattern (all 6 arcade games)

Each game loads `perf-core.js` immediately after `arcade-sdk.js`. Generic half is
copied from the color master; only the GAME-SPECIFIC GLUE tail differs.

- **DPR cap**: `Object.defineProperty(window,'devicePixelRatio',{get})` capped at 2
  (1.5 if `navigator.deviceMemory<=3`). Must load BEFORE game scripts. C3 runtime
  re-reads it on resize, so the getter alone is enough there.
- **Ladder**: ×1→×0.75→×0.5; <30 FPS sustained 2s steps down, >50 for 10s steps up.
  C3 games (stack/2048/iceblock) run `LADDER=[1]` — static cap only; C3 owns its
  canvas sizing and fighting it corrupts state.
- **Telemetry**: `Arcade.onPerf({avgFps,minFps,renderScale})` every 10s gated by a
  per-game `__perfActive`; RN buffers the last report and writes ONE `perf_logs`
  row per session at gameover/unmount (latched). Ads: banners only on VS screen.
- **Test hooks**: `?perfsim=<ms>` busy-wait per frame + `?fpsdebug=1` overlay —
  verifiable via app_preview screenshots (C3 games excepted: headless preview has
  no WebGL, they show a "Software update needed" card — not a regression).

**Pointer-coord trap (EaselJS-NEXT / fruitcut)**: `e.stageX` is in canvas
*backing-store pixels* with CSS-size compensation. If you shrink the backing store
by renderScale, either fold rs into `s_iScaleFactor` (desktop branch) or divide
stageX/Y by rs at the input handler (Android branch — its handlers skip the
s_iScaleFactor division). Missing/double division = touch offset bugs.

**Why:** low-end Androids hit 4 FPS on Color Rush; resolution is the only lever
available inside hosted WebView games without touching gameplay constants.

**How to apply:** new arcade game → copy generic perf-core, write glue
(`__perfActive` gate + `__perfApplyScale` that reuses the game's OWN resize path),
patch its canvas-sizing lines to multiply by `window.__renderScale||1`, bump
script `?v` tags + GAME_HOSTS v, rebuild the game's dist zip.
