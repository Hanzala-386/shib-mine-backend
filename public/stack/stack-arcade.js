/* stack-arcade.js — Arcade PvP adapter for "Stack Builder Skyscraper" (Construct 3).
 *
 * Unlike the CTL games (Flappy/Fruit Cut) the game logic here is data-driven
 * (data.json event sheets + minified c3runtime), so the adapter is a WRAPPER:
 * scripts/main.js is patched to useWorker:!1 (main-thread runtime) and this
 * script uses the OFFICIAL Construct 3 scripting API (self.runOnStartup →
 * IRuntime) to observe the game instead of editing its internals:
 *   - runtime.globalVars.score     cumulative score (authoritative)
 *   - runtime.globalVars.gameover  native game-over flag (tower collapse)
 *   - runtime.layout.name          'Game' = a run is active
 *   - runtime.callFunction('gameover')  triggers the native game-over sequence
 *
 * Responsibilities:
 *   - Strict 45s countdown pinned top-center, armed when a run starts.
 *     At 0:00 → native game-over sequence + (in match) final score lock.
 *   - Match mode (?arcade=1 via arcade-sdk.js): TAP-TO-START = entering the
 *     Game layout → Arcade.onStart(); throttled cumulative score reports
 *     (REPORT_MS > server minIntervalMs so every report lands in a fresh
 *     server window); once-only Arcade.onPlayerOut on game over / timeout;
 *     input blocker after out/freeze (host owns the result UI).
 *   - Practice / plain browser: timer still runs per run (restart re-arms it),
 *     zero Arcade traffic (SDK no-ops without a match).
 */
(function () {
  'use strict';

  var MATCH_SECONDS = 45;
  var REPORT_MS = 600;          // server scoreDelta.minIntervalMs is 500
  var WARN_AT_S = 10;           // countdown turns red for the final seconds

  var rt = null;                // C3 IRuntime (set by runOnStartup)
  var runActive = false;        // a live run on the 'Game' layout
  var started = false;          // match TAP-TO-START signalled (once)
  var out = false;              // match: Arcade.onPlayerOut already sent (once)
  var frozen = false;           // host froze us (settlement) — stop everything
  var deadlineAt = 0;           // epoch ms when this run's 45s expires
  var lastReportAt = 0;
  var timerEl = null;
  var blockEl = null;

  function isMatch() {
    try { return !!(window.Arcade && window.Arcade.isMatch()); } catch (e) { return false; }
  }
  function readScore() {
    try {
      var s = Number(rt.globalVars.score);
      return (isFinite(s) && s > 0) ? Math.floor(s) : 0;
    } catch (e) { return 0; }
  }
  function readGameOver() {
    try { return !!rt.globalVars.gameover; } catch (e) { return false; }
  }
  function layoutName() {
    try { return (rt.layout && rt.layout.name) || ''; } catch (e) { return ''; }
  }

  /* ── Overlay UI (lives in the page, above the game canvas) ─────────────── */
  function ensureTimerEl() {
    if (timerEl) return timerEl;
    timerEl = document.createElement('div');
    timerEl.id = 'arcadeTimer';
    timerEl.style.cssText =
      'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:99990;' +
      'padding:6px 18px;border-radius:999px;background:rgba(10,10,15,0.78);' +
      'border:1px solid rgba(244,196,48,0.55);color:#F4C430;' +
      'font:700 22px/1.2 "Courier New",monospace;letter-spacing:2px;' +
      'text-align:center;pointer-events:none;user-select:none;';
    document.body.appendChild(timerEl);
    return timerEl;
  }
  function hideTimer() { if (timerEl) timerEl.style.display = 'none'; }
  function showTimer() { if (ensureTimerEl()) timerEl.style.display = 'block'; }
  function paintTimer(msLeft) {
    var s = Math.max(0, Math.ceil(msLeft / 1000));
    ensureTimerEl().textContent = '0:' + (s < 10 ? '0' : '') + s;
    timerEl.style.color = (s <= WARN_AT_S) ? '#FF5252' : '#F4C430';
    timerEl.style.borderColor = (s <= WARN_AT_S) ? 'rgba(255,82,82,0.65)' : 'rgba(244,196,48,0.55)';
  }
  function showBlocker() {
    if (blockEl) return;
    blockEl = document.createElement('div');
    blockEl.id = 'arcadeBlocker';
    blockEl.style.cssText =
      'position:fixed;inset:0;z-index:99980;background:rgba(0,0,0,0.35);' +
      'touch-action:none;';
    // Swallow every input so the native restart/menu buttons are unreachable
    // once the match seat is locked. The RN host renders the result UI.
    ['pointerdown', 'touchstart', 'mousedown', 'click'].forEach(function (t) {
      blockEl.addEventListener(t, function (e) { e.stopPropagation(); e.preventDefault(); }, true);
    });
    document.body.appendChild(blockEl);
  }

  /* ── Match reporting ───────────────────────────────────────────────────── */
  function reportScore(force) {
    if (!isMatch() || out || frozen) return;
    var now = Date.now();
    if (!force && (now - lastReportAt) < REPORT_MS) return;
    lastReportAt = now;
    try { window.Arcade.onScore(readScore()); } catch (e) { /* noop */ }
  }

  function goOut() {
    if (out) return;
    out = true;
    var finalScore = readScore();
    try { window.Arcade.onScore(finalScore); } catch (e) { /* noop */ }
    try { window.Arcade.onPlayerOut(finalScore); } catch (e) { /* noop */ }
    hideTimer();
    showBlocker();
  }

  function endRunByTimer() {
    runActive = false;
    // Trigger the game's own game-over sequence (collapse + sound + panel) so
    // the 45s cutoff feels native. Guarded: the adapter's own lock below does
    // not depend on the event function existing.
    if (!readGameOver()) {
      try { rt.callFunction('gameover'); } catch (e) { /* noop */ }
    }
    if (isMatch()) { goOut(); } else { hideTimer(); }
  }

  /* ── Per-tick driver (official C3 tick event) ──────────────────────────── */
  function onTick() {
    if (!rt || frozen) return;

    var inGame = layoutName() === 'Game';
    var over = readGameOver();

    if (!runActive) {
      // Arm a fresh run: entering the Game layout with the game-over flag clear.
      // Covers first entry AND practice restarts (flag resets on layout start).
      if (inGame && !over) {
        runActive = true;
        deadlineAt = Date.now() + MATCH_SECONDS * 1000;
        showTimer();
        paintTimer(MATCH_SECONDS * 1000);
        if (isMatch() && !started) {
          started = true;
          try { window.Arcade.onStart(); } catch (e) { /* noop */ }
        }
      } else if (!inGame) {
        hideTimer();
      }
      return;
    }

    // Run is active —
    if (!inGame) {                 // backed out to the menu mid-run
      runActive = false;
      hideTimer();
      // In a match, leaving the run is final: lock the seat at the current score.
      if (isMatch() && started) goOut();
      return;
    }

    var left = deadlineAt - Date.now();
    paintTimer(left);

    if (over) {                    // native game over (tower collapsed)
      runActive = false;
      if (isMatch()) { goOut(); } else { hideTimer(); }
      return;
    }
    if (left <= 0) { endRunByTimer(); return; }

    reportScore(false);
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */
  if (window.Arcade) {
    window.Arcade.onFreeze(function () {
      frozen = true;
      hideTimer();
      if (isMatch()) showBlocker();
    });
  }

  function attach(runtime) {
    rt = runtime;
    runtime.addEventListener('tick', onTick);
  }

  function register() {
    try {
      self.runOnStartup(async function (runtime) { attach(runtime); });
      return true;
    } catch (e) { return false; }
  }

  // scripts/main.js (a module evaluated before this one) defines
  // self.runOnStartup; poll briefly as a belt-and-braces fallback in case
  // script order ever changes on the hosting.
  if (!(typeof self.runOnStartup === 'function' && register())) {
    var tries = 0;
    var poll = setInterval(function () {
      if (typeof self.runOnStartup === 'function' && register()) { clearInterval(poll); }
      else if (++tries > 2000) { clearInterval(poll); }   // ~20s then give up
    }, 10);
  }
})();
