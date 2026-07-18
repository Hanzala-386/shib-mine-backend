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
 *   - runtime.objects.btn_pause    pause button — DESTROYED in a match
 *
 * TWO-STAGE TIMER (match):
 *   Stage 1 (pre-game AFK, 45s): armed on the SDK's 'arcade:matchstart' event —
 *     i.e. when ARCADE_MATCH_START actually lands, which the RN host only sends
 *     AFTER the match is found and revealed. NEVER at runtime boot: the host
 *     mounts this WebView warm (with ?arcade=1) while the player is still in the
 *     matchmaking queue, and the queue wait is unbounded — a boot-armed timer
 *     would forfeit the seat before the match even starts. Covers the menu AND
 *     the TAP-TO-START screen; first real gameplay tap on the Game layout ends
 *     it. At 0:00 without a tap → forfeit (Arcade.onPlayerOut(0)). If the event
 *     never lands (fragile cross-origin path) there is NO adapter forfeit — the
 *     RN 50s AFK and the server 60s readyAfkSeconds backstop still cover the
 *     seat. Margins (all from ~match start): adapter 45s < RN 50s < server 60s.
 *   Stage 2 (active match, 5:00): starts on that first gameplay tap
 *     (Arcade.onStart() fires here — this is the true TAP-TO-START signal).
 *     Play/score freely until 0:00 → native game-over + final score lock; the
 *     server settles both-out on the higher locked score.
 * Practice: no stage-1 (no forfeit concept); stage-2 countdown runs per run and
 * re-arms on restart; zero Arcade traffic (SDK no-ops without a match).
 *
 * PAUSE PROTECTION (match): every tick, all btn_pause instances are destroyed
 * (destroy, not hide — C3 touch events still hit invisible sprites), so the
 * pause/restart/home panel is unreachable once a match starts. Practice keeps
 * its pause button.
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
                                // (0 = not armed: match not yet started, or practice)
  var stage2DeadlineAt = 0;     // epoch ms when the active run expires
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

  /* ── Pause button removal (match only) ─────────────────────────────────── */
  function killPauseButton() {
    try {
      var oc = rt.objects && rt.objects.btn_pause;
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
    playing = false;
    var finalScore = readScore();
    try { window.Arcade.onScore(finalScore); } catch (e) { /* noop */ }
    try { window.Arcade.onPlayerOut(finalScore); } catch (e) { /* noop */ }
    hideTimer();
    showBlocker();
  }

  function endRunByTimer() {
    playing = false;
    // Trigger the game's own game-over sequence (collapse + sound + panel) so
    // the 5:00 cutoff feels native. Guarded: the adapter's own lock below does
    // not depend on the event function existing.
    if (!readGameOver()) {
      try { rt.callFunction('gameover'); } catch (e) { /* noop */ }
    }
    if (isMatch()) { goOut(); } else { hideTimer(); }
  }

  /* ── Stage 2 start: the first REAL gameplay tap on the Game layout ─────── */
  function onFirstGameplayTap() {
    if (playing || out || frozen) return;
    if (layoutName() !== 'Game' || readGameOver()) return;
    playing = true;
    stage2DeadlineAt = Date.now() + STAGE2_SECONDS * 1000;
    showTimer();
    paintTimer(STAGE2_SECONDS * 1000, '');
    if (isMatch() && !started) {
      started = true;
      // True TAP-TO-START: ends stage 1 everywhere (RN clears its client AFK
      // on ARCADE_STARTED; the server backstop clears on the first SCORE).
      try { window.Arcade.onStart(); } catch (e) { /* noop */ }
    }
  }
  ['pointerdown', 'touchstart', 'mousedown'].forEach(function (t) {
    // Capture phase, BEFORE the input blocker's own guards: onFirstGameplayTap
    // no-ops unless the tap is a genuine live-run tap.
    window.addEventListener(t, onFirstGameplayTap, true);
  });

  /* ── Per-tick driver (official C3 tick event) ──────────────────────────── */
  function onTick() {
    /* PERF: telemetry gate — perf-core only counts FPS while actually playing */
    window.__c3Active = !!rt && !frozen && layoutName() === 'Game' && !readGameOver();
    if (!rt || frozen) return;

    var match = isMatch();
    if (match) killPauseButton();   // pause/restart/home must not exist in a match
    if (out) return;

    var inGame = layoutName() === 'Game';
    var over = readGameOver();

    if (!playing) {
      // Stage 1 (match): pre-game AFK countdown — menu + TAP-TO-START screen.
      // Only once armed by 'arcade:matchstart' (the WebView is mounted warm
      // during the unbounded matchmaking queue — never count down there).
      if (match && stage1DeadlineAt) {
        var s1Left = stage1DeadlineAt - Date.now();
        showTimer();
        paintTimer(s1Left, 'START IN');
        if (s1Left <= 0) { goOut(); }   // never tapped in → forfeit at 0
      } else {
        hideTimer();                    // practice / still queueing: no countdown
      }
      return;
    }

    // Stage 2 — a live, tapped-in run.
    if (!inGame) {                 // backed out to the menu mid-run
      playing = false;
      hideTimer();
      // In a match, leaving the run is final: lock the seat at the current score.
      if (match && started) goOut();
      return;
    }

    var left = stage2DeadlineAt - Date.now();
    paintTimer(left, '');

    if (over) {                    // native game over (tower collapsed)
      playing = false;
      if (match) { goOut(); } else { hideTimer(); }
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

  // Stage 1 arms ONLY when the match actually starts (ARCADE_MATCH_START lands →
  // the SDK dispatches 'arcade:matchstart'). RN re-sends MATCH_START until acked,
  // so the event can fire repeatedly — arm exactly once, and never after the
  // player has already tapped in or the seat is settled.
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
