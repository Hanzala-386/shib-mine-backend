/* color-arcade.js — Arcade PvP adapter for "Color Rush" (createjs).
 *
 * Color Rush is ENDLESS: there is NO gameplay match timer (spec timerSeconds:
 * null, like Flappy / Fruit Cut). A run ends only on the first wrong-colour
 * collision (the game's endGame()) → PLAYER_OUT; the server settles on the
 * higher locked score.
 *
 * Unlike the C3 games this adapter cannot use a runtime scripting API, so it
 * hooks a few named globals that js/game.js and js/canvas.js expose (all are
 * plain top-level `var`s = window globals in these classic scripts):
 *   - window.playerData.score   cumulative score (authoritative, +1 per ball)
 *   - window.gameData.over       native game-over flag
 *   - window.Arcade              the arcade-sdk.js bridge (loaded first)
 * and three thin call-outs game.js/canvas.js make into us at runtime:
 *   - window.__arcadeColorStart()  from startGame()  — first genuine Play
 *   - window.__arcadeColorTick()   from updateGame() — per-frame score report
 *   - window.__arcadeColorEnd()    from endGame()    — wrong-colour game over
 *   - window.__arcadeColorMatch()  guards Exit-from-Settings + confirm in a match
 *
 * STAGE-1 PRE-GAME AFK (45s, match only): armed on the SDK 'arcade:matchstart'
 * event (NEVER at boot — the WebView mounts warm during the unbounded queue).
 * Covers the start screen before the player taps Play. At 0:00 without a Play →
 * forfeit (onPlayerOut(0)). Backstops if the event never lands: RN 50s AFK and
 * server 60s readyAfkSeconds. Margins (from ~match start): adapter 45 < RN 50 <
 * server 60. On Play, onStart() (cancels RN AFK) + onScore(0) (clears the
 * server AFK, which releases only on a SCORE; acceptScore ignores the
 * non-increase) fire once. Practice: no stage-1, no forfeit, Exit intact.
 */
(function () {
  'use strict';

  var STAGE1_SECONDS = 45;
  var REPORT_MS = 600;          // server scoreDelta.minIntervalMs is 500
  var WARN_AT_S = 10;

  var started = false;          // match: onStart / onScore(0) sent (once)
  var out = false;              // match: onPlayerOut sent (once)
  var frozen = false;           // host froze us (settlement)
  var stage1DeadlineAt = 0;     // epoch ms when the pre-game AFK window expires
  var lastReportAt = 0;
  var timerEl = null;
  var blockEl = null;

  function isMatch() {
    try { return !!(window.Arcade && window.Arcade.isMatch()); } catch (e) { return false; }
  }
  function readScore() {
    // playerData is a top-level `const` in game.js → a global LEXICAL binding,
    // NOT a property on window. Reference it bare (classic scripts share the
    // global scope); window.playerData would be undefined and pin the score to 0.
    try {
      var s = Number(playerData.score);
      return (isFinite(s) && s > 0) ? Math.floor(s) : 0;
    } catch (e) { return 0; }
  }

  /* ── Overlay UI (page-level, above the game canvas) ────────────────────── */
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
  function paintTimer(msLeft, label) {
    var s = Math.max(0, Math.ceil(msLeft / 1000));
    var m = Math.floor(s / 60);
    var ss = s % 60;
    ensureTimerEl().textContent =
      (label ? label + ' ' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
    timerEl.style.color = (s <= WARN_AT_S) ? '#FF5252' : '#F4C430';
    timerEl.style.borderColor = (s <= WARN_AT_S) ? 'rgba(255,82,82,0.65)' : 'rgba(244,196,48,0.55)';
  }
  function showBlocker() {
    if (blockEl) return;
    blockEl = document.createElement('div');
    blockEl.id = 'arcadeBlocker';
    blockEl.style.cssText =
      'position:fixed;inset:0;z-index:99980;background:rgba(0,0,0,0.35);touch-action:none;';
    ['pointerdown', 'touchstart', 'mousedown', 'click'].forEach(function (t) {
      blockEl.addEventListener(t, function (e) { e.stopPropagation(); e.preventDefault(); }, true);
    });
    document.body.appendChild(blockEl);
  }

  function goOut(finalOverride) {
    if (out) return;
    out = true;
    var f = (typeof finalOverride === 'number') ? finalOverride : readScore();
    try { window.Arcade.onScore(f); } catch (e) { /* noop */ }
    try { window.Arcade.onPlayerOut(f); } catch (e) { /* noop */ }
    hideTimer();
    showBlocker();
  }

  /* ── Hooks called from game.js / canvas.js ─────────────────────────────── */
  window.__arcadeColorMatch = isMatch;

  window.__arcadeColorStart = function () {   // startGame()
    if (!isMatch() || started || out || frozen) return;
    started = true;
    try { window.Arcade.onStart(); } catch (e) { /* noop */ }
    try { window.Arcade.onScore(0); } catch (e) { /* noop */ }
    hideTimer();
  };

  window.__arcadeColorTick = function () {    // updateGame() — per frame
    if (!isMatch() || out || frozen || !started) return;
    var now = Date.now();
    if (now - lastReportAt < REPORT_MS) return;
    lastReportAt = now;
    try { window.Arcade.onScore(readScore()); } catch (e) { /* noop */ }
  };

  window.__arcadeColorEnd = function () {      // endGame() — wrong-colour hit
    if (!isMatch()) return;
    goOut(readScore());
  };

  /* ── Stage-1 pre-game AFK driver (rAF — independent of game pause) ──────── */
  function loop() {
    requestAnimationFrame(loop);
    if (frozen || out || started) { return; }
    if (!isMatch() || !stage1DeadlineAt) { hideTimer(); return; }
    var left = stage1DeadlineAt - Date.now();
    showTimer();
    paintTimer(left, 'START IN');
    if (left <= 0) { goOut(0); }              // never tapped Play → forfeit
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */
  if (window.Arcade) {
    window.Arcade.onFreeze(function () {
      frozen = true;
      hideTimer();
      // Suppress the game's own result page — the RN host renders the match
      // result. The input blocker also covers it.
      try { if (window.resultContainer) window.resultContainer.visible = false; } catch (e) { /* noop */ }
      if (isMatch()) showBlocker();
    });
  }

  window.addEventListener('arcade:matchstart', function () {
    if (!stage1DeadlineAt && !started && !out && !frozen) {
      stage1DeadlineAt = Date.now() + STAGE1_SECONDS * 1000;
    }
  });

  requestAnimationFrame(loop);
})();
