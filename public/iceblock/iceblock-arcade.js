/* iceblock-arcade.js — Arcade PvP adapter for "Ice Block Puzzle" (Construct 3).
 *
 * Same wrapper strategy as Tower Stack: scripts/main.js is patched to
 * useWorker:false (main-thread runtime) and this module observes the game
 * through the OFFICIAL Construct 3 scripting API (self.runOnStartup → IRuntime)
 * instead of editing the minified runtime:
 *   - runtime.globalVars.Score      cumulative score (authoritative)
 *   - runtime.globalVars.GameOver   native game-over flag
 *   - runtime.layout.name           'Game' = a run is active ('manu' = menu)
 *   - runtime.objects.BtnReset      reset button (top-right)  — DESTROYED in a match
 *   - runtime.objects.BtnHome       home button (top-left)    — DESTROYED in a match
 *   - runtime.objects.BtnResetGO    game-over restart button  — DESTROYED in a match
 *
 * TWO-STAGE TIMER (match only — practice is untimed free play):
 *   Stage 1 (pre-game AFK, 45s): armed on the SDK 'arcade:matchstart' event —
 *     when ARCADE_MATCH_START actually lands (match found + revealed). NEVER at
 *     boot: the RN host mounts this WebView warm (with ?arcade=1) while the
 *     player is still in the unbounded matchmaking queue. Covers the menu AND
 *     the Play screen; the first real gameplay tap on the Game layout ends it.
 *     At 0:00 without a tap → forfeit (Arcade.onPlayerOut(0)). If the event
 *     never lands, there is NO adapter forfeit — the RN 50s AFK and the server
 *     60s readyAfkSeconds backstop still cover the seat.
 *     Margins (all from ~match start): adapter 45s < RN 50s < server 60s.
 *   Stage 2 (active match, 5:00): starts on that first gameplay tap
 *     (Arcade.onStart() + Arcade.onScore(0) fire here — engagement signal that
 *     cancels the RN AFK and clears the server AFK on a genuine physical tap).
 *     Play/score freely until 0:00 → the seat is frozen + final score locked;
 *     the server settles both-out on the higher locked score.
 */
(function () {
  'use strict';

  var STAGE1_SECONDS = 45;      // pre-game AFK window (match only)
  var STAGE2_SECONDS = 300;     // active-match play window (5 minutes)
  var REPORT_MS = 600;          // server scoreDelta.minIntervalMs is 500
  var WARN_AT_S = 10;           // countdown turns red for the final seconds

  var rt = null;                // C3 IRuntime (set by runOnStartup)
  var playing = false;          // stage 2 running (a live, tapped-in run)
  var started = false;          // match TAP-TO-START signalled (once)
  var out = false;              // match: Arcade.onPlayerOut already sent (once)
  var frozen = false;           // host froze us (settlement) — stop everything
  var stage1DeadlineAt = 0;     // epoch ms when the pre-game AFK window expires
  var stage2DeadlineAt = 0;     // epoch ms when the active run expires
  var lastReportAt = 0;
  var timerEl = null;
  var blockEl = null;

  function isMatch() {
    try { return !!(window.Arcade && window.Arcade.isMatch()); } catch (e) { return false; }
  }
  function readScore() {
    try {
      var s = Number(rt.globalVars.Score);
      return (isFinite(s) && s > 0) ? Math.floor(s) : 0;
    } catch (e) { return 0; }
  }
  function readGameOver() {
    try { return !!rt.globalVars.GameOver; } catch (e) { return false; }
  }
  function layoutName() {
    try { return (rt.layout && rt.layout.name) || ''; } catch (e) { return ''; }
  }

  /* ── Reset / Home / game-over-restart removal (match only) ─────────────── */
  function killButtons() {
    ['BtnReset', 'BtnHome', 'BtnResetGO'].forEach(function (name) {
      try {
        var oc = rt.objects && rt.objects[name];
        if (!oc) return;
        var list = (typeof oc.getAllInstances === 'function') ? oc.getAllInstances() : null;
        if (!list && typeof oc.instances === 'function') {
          list = []; var it = oc.instances();
          for (var v = it.next(); !v.done; v = it.next()) list.push(v.value);
        }
        if (!list) return;
        for (var i = 0; i < list.length; i++) {
          try { list[i].destroy(); } catch (e) { /* single instance */ }
        }
      } catch (e) { /* object class absent — nothing to remove */ }
    });
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
      'position:fixed;inset:0;z-index:99980;background:rgba(0,0,0,0.35);' +
      'touch-action:none;';
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
    playing = false;
    var finalScore = readScore();
    try { window.Arcade.onScore(finalScore); } catch (e) { /* noop */ }
    try { window.Arcade.onPlayerOut(finalScore); } catch (e) { /* noop */ }
    hideTimer();
    showBlocker();
  }

  function endRunByTimer() {
    playing = false;
    // 5:00 cutoff. We do NOT trigger the game's native game-over sequence (it
    // can navigate to the 'adloader' layout); freezing input via the blocker
    // locks the board and the final score just as effectively.
    if (isMatch()) { goOut(); } else { hideTimer(); }
  }

  /* ── Stage 2 start: the first REAL gameplay tap on the Game layout ─────── */
  function onFirstGameplayTap() {
    if (playing || out || frozen) return;
    if (!isMatch()) return;               // practice: untimed free play
    if (layoutName() !== 'Game' || readGameOver()) return;
    playing = true;
    stage2DeadlineAt = Date.now() + STAGE2_SECONDS * 1000;
    showTimer();
    paintTimer(STAGE2_SECONDS * 1000, '');
    if (!started) {
      started = true;
      try { window.Arcade.onStart(); } catch (e) { /* noop */ }
      // Emit a score of 0 on the genuine first tap so the SERVER AFK timer
      // (cleared only by a SCORE) releases even if the first line-clear is slow.
      // acceptScore ignores a non-increase, so this only clears the timer.
      try { window.Arcade.onScore(0); } catch (e) { /* noop */ }
    }
  }
  ['pointerdown', 'touchstart', 'mousedown'].forEach(function (t) {
    window.addEventListener(t, onFirstGameplayTap, true);
  });

  /* ── Per-tick driver (official C3 tick event) ──────────────────────────── */
  function onTick() {
    if (!rt || frozen) return;

    var match = isMatch();
    if (!match) { hideTimer(); return; }  // practice: no timer, keep Reset/Home
    killButtons();                        // reset/home/restart must not exist in a match
    if (out) return;

    var inGame = layoutName() === 'Game';
    var over = readGameOver();

    if (!playing) {
      // Stage 1 (match): pre-game AFK — menu + Play screen. Only once armed by
      // 'arcade:matchstart' (never during the warm matchmaking queue).
      if (stage1DeadlineAt) {
        var s1Left = stage1DeadlineAt - Date.now();
        showTimer();
        paintTimer(s1Left, 'START IN');
        if (s1Left <= 0) { goOut(); }     // never tapped in → forfeit at 0
      } else {
        hideTimer();
      }
      return;
    }

    // Stage 2 — a live, tapped-in run.
    if (!inGame) {                        // backed out to the menu mid-run
      playing = false;
      hideTimer();
      if (started) goOut();               // leaving a match run is final
      return;
    }

    var left = stage2DeadlineAt - Date.now();
    paintTimer(left, '');

    if (over) {                           // native game over (board resolved)
      playing = false;
      goOut();
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

  window.addEventListener('arcade:matchstart', function () {
    if (!stage1DeadlineAt && !playing && !out && !frozen) {
      stage1DeadlineAt = Date.now() + STAGE1_SECONDS * 1000;
    }
  });

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

  if (!(typeof self.runOnStartup === 'function' && register())) {
    var tries = 0;
    var poll = setInterval(function () {
      if (typeof self.runOnStartup === 'function' && register()) { clearInterval(poll); }
      else if (++tries > 2000) { clearInterval(poll); }   // ~20s then give up
    }, 10);
  }
})();
