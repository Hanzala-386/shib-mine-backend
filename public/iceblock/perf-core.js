/* perf-core.js — Hard-Performance Override for low-end devices.
 *
 * MUST be loaded BEFORE any game script that reads window.devicePixelRatio
 * (main.js captures it into a `const dpr` at load time).
 *
 * What it does:
 *  1. DPR CAP — caps the effective devicePixelRatio at 2 (1.5 on devices that
 *     report navigator.deviceMemory <= 3 GB). A 3x-dpr budget phone otherwise
 *     pushes a 2160x3840 canvas backing store through a weak GPU = single-digit
 *     FPS. Done via Object.defineProperty so ALL game code (which reads
 *     window.devicePixelRatio) picks up the capped value with zero edits.
 *  2. ADAPTIVE RESOLUTION — rolling FPS sampler (rAF) + a render-scale ladder
 *     [1, 0.75, 0.5] with hysteresis: below 30 FPS for 2s -> step down; above
 *     50 FPS for 10s -> step back up. The current scale is published as
 *     window.__renderScale; game files multiply their canvas backing size,
 *     stage scale and input mapping by it (patched lines are marked PERF).
 *     __perfApplyScale() (game-specific, bottom of this file) applies a scale
 *     change immediately without waiting for a window resize.
 *  3. TELEMETRY — while gameplay is active (window.__perfActive), accumulates
 *     avg/min FPS and reports {avgFps, minFps, scale} to the RN host every 10s
 *     via window.Arcade.onPerf (arcade-sdk.js). The host attaches the device
 *     model and writes ONE PocketBase row per session at game end.
 *
 * Debug query params (dev only, harmless in prod):
 *   ?perfsim=<ms>   busy-wait <ms> per frame on the main thread — simulates a
 *                   low-end device so the ladder can be verified on a fast box.
 *   ?fpsdebug=1     tiny overlay showing live FPS + current render scale.
 * State is exposed at window.__perfState for automated verification.
 */
(function () {
  'use strict';

  var qs;
  try { qs = new URLSearchParams(location.search || ''); } catch (e) { qs = { get: function () { return null; } }; }
  var SIM_MS = Math.max(0, Number(qs.get('perfsim')) || 0);
  var FPS_DEBUG = qs.get('fpsdebug') === '1';

  /* ── 1. DPR cap ─────────────────────────────────────────────────────────── */
  var realDpr = window.devicePixelRatio || 1;
  var mem = navigator.deviceMemory;                 // undefined on iOS/older WebViews
  var CAP = (typeof mem === 'number' && mem <= 3) ? 1.5 : 2;
  var cappedDpr = Math.min(realDpr, CAP);
  try {
    Object.defineProperty(window, 'devicePixelRatio', {
      get: function () { return cappedDpr; },
      configurable: true,
    });
  } catch (e) { /* very old WebView — game falls back to the real dpr */ }

  /* ── 2. Adaptive render-scale ladder ───────────────────────────────────── */
  var LADDER = [1]; /* C3 games: STATIC dpr cap only — no dynamic stepping in v1.
                     The C3 runtime owns its canvas sizing; the capped
                     devicePixelRatio getter (re-read by scripts/main.js on
                     every resize) is the whole resolution story here. */
  var DOWN_FPS = 30, UP_FPS = 50;
  var DOWN_HOLD_MS = 2000, UP_HOLD_MS = 10000;
  var idx = 0;
  var belowSince = 0, aboveSince = 0;

  window.__renderScale = 1;
  window.__perfState = {
    scale: 1, dprCap: cappedDpr, realDpr: realDpr,
    lastFps: 0, avgFps: 0, minFps: 0, sim: SIM_MS,
  };

  function applyScale(s) {
    window.__renderScale = s;
    window.__perfState.scale = s;
    try {
      if (typeof window.__perfApplyScale === 'function') window.__perfApplyScale(s);
    } catch (e) { /* game not booted yet — the PERF-patched resize paths pick it up */ }
  }

  function isActive() {
    try { return (typeof window.__perfActive === 'function') ? !!window.__perfActive() : true; }
    catch (e) { return true; }
  }

  /* ── 3. Telemetry ──────────────────────────────────────────────────────── */
  var sumFps = 0, nFps = 0, minFps = Infinity, lastReportAt = 0;
  var REPORT_EVERY_MS = 10000;

  function maybeReport(now) {
    if (nFps === 0) return;
    if (now - lastReportAt < REPORT_EVERY_MS) return;
    lastReportAt = now;
    try {
      if (window.Arcade && typeof window.Arcade.onPerf === 'function') {
        window.Arcade.onPerf({
          avgFps: sumFps / nFps,
          minFps: (minFps === Infinity) ? 0 : minFps,
          scale: window.__renderScale,
        });
      }
    } catch (e) { /* telemetry is best-effort */ }
  }

  /* ── Debug overlay ─────────────────────────────────────────────────────── */
  var dbgEl = null;
  function paintDebug(fps) {
    if (!dbgEl) {
      dbgEl = document.createElement('div');
      dbgEl.id = 'perfDebug';
      dbgEl.style.cssText =
        'position:fixed;top:4px;right:4px;z-index:99999;padding:2px 6px;' +
        'font:bold 11px monospace;background:rgba(0,0,0,.55);color:#0f0;' +
        'border-radius:4px;pointer-events:none;user-select:none;';
      var attach = function () { try { document.body.appendChild(dbgEl); } catch (e) { /* noop */ } };
      if (document.body) attach(); else window.addEventListener('DOMContentLoaded', attach);
    }
    dbgEl.style.color = fps >= 50 ? '#5f5' : (fps >= 30 ? '#fc0' : '#f55');
    dbgEl.textContent = Math.round(fps) + ' FPS ×' + window.__renderScale;
  }

  /* ── Sampler loop (rAF = true main-thread frame rate) ──────────────────── */
  var frames = 0, winStart = 0;
  function loop(ts) {
    requestAnimationFrame(loop);

    // Low-end simulation: burn main-thread time per frame (dev verification only).
    if (SIM_MS > 0) {
      var end = performance.now() + SIM_MS;
      while (performance.now() < end) { /* busy-wait */ }
    }

    frames++;
    if (!winStart) { winStart = ts; return; }
    var span = ts - winStart;
    if (span < 500) return;

    var fps = frames * 1000 / span;
    frames = 0; winStart = ts;
    window.__perfState.lastFps = Math.round(fps);

    if (isActive()) {
      sumFps += fps; nFps++;
      if (fps < minFps) minFps = fps;
      window.__perfState.avgFps = Math.round(sumFps / nFps);
      window.__perfState.minFps = Math.round(minFps === Infinity ? 0 : minFps);
      maybeReport(ts);
    }

    // Hysteresis ladder (runs everywhere — menus downscale harmlessly too).
    if (fps < DOWN_FPS) {
      aboveSince = 0;
      if (!belowSince) belowSince = ts;
      else if (ts - belowSince >= DOWN_HOLD_MS && idx < LADDER.length - 1) {
        idx++; applyScale(LADDER[idx]); belowSince = 0;
      }
    } else if (fps > UP_FPS) {
      belowSince = 0;
      if (!aboveSince) aboveSince = ts;
      else if (ts - aboveSince >= UP_HOLD_MS && idx > 0) {
        idx--; applyScale(LADDER[idx]); aboveSince = 0;
      }
    } else {
      belowSince = 0; aboveSince = 0;
    }

    if (FPS_DEBUG) paintDebug(fps);
  }
  requestAnimationFrame(loop);

  /* ══ GAME-SPECIFIC GLUE (Construct 3 runtime) ═══════════════════════ */

  // Gameplay-active gate: the game's *-arcade.js adapter sets window.__c3Active
  // every C3 tick (Game layout + not game-over). No __perfApplyScale — the
  // ladder is disabled for C3 (static dpr cap only).
  window.__perfActive = function () { return window.__c3Active === true; };
})();
