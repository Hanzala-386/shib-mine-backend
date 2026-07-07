/* 2048-arcade.js — Arcade PvP adapter for "2048" (Construct 3).
 *
 * Same wrapper strategy as Tower Stack: scripts/main.js is patched to
 * useWorker:false (main-thread runtime) and this module observes the game
 * through the OFFICIAL Construct 3 scripting API (self.runOnStartup → IRuntime):
 *   - runtime.globalVars.Score      cumulative score (authoritative)
 *   - runtime.globalVars.GameOver   native game-over flag (board full)
 *   - runtime.layout.name           'Game' = the board is active
 *   - runtime.objects.BtnReset      reset button (top-right) — DESTROYED in a match
 *
 * SINGLE-STAGE TIMER (match only — practice is untimed free play):
 *   2048 has no menu / Play screen — the board is immediately playable — so the
 *   5:00 MATCH timer arms on the SDK 'arcade:matchstart' event (i.e. the moment
 *   the match is found + revealed), NOT on a Play tap. NEVER at boot: the RN
 *   host mounts this WebView warm (with ?arcade=1) during the unbounded
 *   matchmaking queue. The countdown shows immediately so both seats race the
 *   same clock. At 0:00 (or on a natural board-full loss) the seat is frozen +
 *   the final score locked; the server settles both-out on the higher score.
 *
 * AFK: there is no pre-game adapter stage — a seat that never moves is covered
 *   by the RN 50s AFK and the server 60s readyAfkSeconds backstop. On the first
 *   genuine move the adapter fires Arcade.onStart() (cancels RN AFK) and
 *   Arcade.onScore(0) (clears the server AFK, which releases only on a SCORE);
 *   acceptScore ignores the non-increase, so it only clears the timer.
 *
 * Reset (BtnReset) is destroyed every tick in a match so the seat cannot be
 * reset to fish for a better run. Practice keeps Reset and has no timer.
 */
(function () {
  'use strict';

  var MATCH_SECONDS = 300;      // active-match play window (5 minutes)
  var REPORT_MS = 600;          // server scoreDelta.minIntervalMs is 500
  var WARN_AT_S = 10;           // countdown turns red for the final seconds

  var rt = null;                // C3 IRuntime (set by runOnStartup)
  var started = false;          // onStart / onScore(0) sent (once, first move)
  var out = false;              // match: Arcade.onPlayerOut already sent (once)
  var frozen = false;           // host froze us (settlement) — stop everything
  var matchDeadlineAt = 0;      // epoch ms when the 5:00 match window expires
                                // (0 = not armed: not a match, or match not started)
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

  /* ── Reset button removal (match only) ─────────────────────────────────── */
  function killResetButton() {
    try {
      var oc = rt.objects && rt.objects.BtnReset;
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

  /* ── First genuine move: cancel RN AFK + clear server AFK ──────────────── */
  function onFirstMove() {
    if (started || out || frozen) return;
    if (!isMatch()) return;               // practice: nothing to signal
    if (layoutName() !== 'Game' || readGameOver()) return;
    started = true;
    try { window.Arcade.onStart(); } catch (e) { /* noop */ }
    try { window.Arcade.onScore(0); } catch (e) { /* noop */ }
  }
  ['pointerdown', 'touchstart', 'mousedown'].forEach(function (t) {
    window.addEventListener(t, onFirstMove, true);
  });

  /* ── Per-tick driver (official C3 tick event) ──────────────────────────── */
  function onTick() {
    if (!rt || frozen) return;

    var match = isMatch();
    if (!match) { hideTimer(); return; } // practice: no timer, keep Reset
    killResetButton();                    // reset must not exist in a match
    if (out) return;
    if (!matchDeadlineAt) return;         // safety: arms on 'arcade:matchstart'

    var left = matchDeadlineAt - Date.now();
    showTimer();
    paintTimer(left, '');

    if (readGameOver()) { goOut(); return; }  // natural loss (board full)
    if (left <= 0) { goOut(); return; }       // 5:00 cutoff → freeze + lock

    if (layoutName() === 'Game') reportScore(false);
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */
  if (window.Arcade) {
    window.Arcade.onFreeze(function () {
      frozen = true;
      hideTimer();
      if (isMatch()) showBlocker();
    });
  }

  // The 5:00 match clock arms exactly once, when the match is found + revealed
  // (RN may re-send MATCH_START until acked — arm once, never after settle).
  window.addEventListener('arcade:matchstart', function () {
    if (!matchDeadlineAt && !out && !frozen) {
      matchDeadlineAt = Date.now() + MATCH_SECONDS * 1000;
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
