;(function () {
  'use strict';

  /* =============================================================
   *  SHIB Mine — Construct 3 Bridge
   *
   *  Messages OUT → React Native:
   *    BRIDGE_READY
   *    SCORE_UPDATE   { score }
   *    GAME_OVER      { score, collected_tomatoes, pb_id, elapsed_ms, reason }
   *    DOUBLE_REWARD  { score, collected_tomatoes, pb_id, elapsed_ms }
   *    INJECT_DONE    { state }
   *
   *  Messages IN ← React Native:
   *    INJECT_VARS    { pbId, appVersion, powerTokens, collectedTomatoes, lastSessionScore, totalScore }
   *    TIME_UP
   *    RESUME_NAVIGATION
   *    RELOAD_GAME
   * ============================================================= */

  /* ── Step 1: Kill LocalStorage game keys — server is source of truth ─── */
  (function clearLocalGameStorage() {
    var KEYS = ['score', 'highScore', 'hscore', 'tomatoes', 'level',
                'c3save', 'c3_save', 'c3_autosave', 'save'];
    var cleared = [];
    try {
      KEYS.forEach(function (k) {
        if (localStorage.getItem(k) !== null) { localStorage.removeItem(k); cleared.push(k); }
      });
      Object.keys(localStorage).forEach(function (k) {
        if (/^c3|^weapon|^shib/i.test(k)) { localStorage.removeItem(k); cleared.push(k); }
      });
    } catch (e) { /* blocked in some envs */ }
    if (cleared.length) console.log('[Bridge] Cleared LocalStorage:', cleared.join(', '));
    else               console.log('[Bridge] LocalStorage: no stale keys');
  })();

  var lastLayout  = '';
  var bridgeReady = false;
  var navBlocked  = false;
  var pendingNav  = null;

  /* ── WebSocket — server-side score validation ─────────────────────────────
   *  After INJECT_VARS is received, opens a WebSocket to the Railway server
   *  and sends GAME_OVER with the final validated score so the server can
   *  store last_session_score.  Gracefully no-ops if WS is unavailable.
   * ──────────────────────────────────────────────────────────────────────── */
  var wsApiUrl = '';
  var wsConn   = null;
  var wsReady  = false;

  /* ── Match-gate overlay ─────────────────────────────────────────────────
   *  HARD GATE: the game must NOT start until the server confirms the match
   *  row is written in the database (SESSION_READY). Until then a full-screen
   *  blocker eats all input. On ERROR/timeout it shows a Retry screen.
   * ──────────────────────────────────────────────────────────────────────── */
  var sessionReady = false;
  var gateTimer    = null;

  function gateEl() {
    var el = document.getElementById('shib-match-gate');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'shib-match-gate';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
      'background:rgba(6,6,10,0.94);display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;font-family:sans-serif;color:#F4C430;text-align:center;padding:24px;';
    el.innerHTML =
      '<div id="shib-gate-msg" style="font-size:18px;font-weight:bold;margin-bottom:18px;max-width:280px;">Connecting…</div>' +
      '<div id="shib-gate-btn" style="display:none;background:#FF6B00;color:#fff;font-weight:bold;' +
      'padding:12px 36px;border-radius:24px;font-size:16px;cursor:pointer;">Retry</div>';
    el.querySelector('#shib-gate-btn').addEventListener('click', function () { window.location.reload(); });
    (document.body || document.documentElement).appendChild(el);
    return el;
  }
  function gateShow(msg, retry) {
    try {
      var el = gateEl();
      el.style.display = 'flex';
      el.querySelector('#shib-gate-msg').textContent = msg;
      el.querySelector('#shib-gate-btn').style.display = retry ? 'block' : 'none';
    } catch (e) {}
  }
  function gateHide() {
    try {
      var el = document.getElementById('shib-match-gate');
      if (el) el.style.display = 'none';
    } catch (e) {}
    /* Gate just lifted — start the init grace clock NOW so any C3
     * initialisation jitter in the first 1.5 s can't fire a false GAME_OVER. */
    if (gameReadyAt === 0) gameReadyAt = Date.now();
  }
  function gateFail() {
    if (!gateArmed || sessionReady) return;
    console.warn('[Bridge] MATCH GATE FAILED — game blocked until retry');
    gateShow('Connection failed — the match could not be verified. Please retry.', true);
  }

  /* ── VERSION-AWARE gating ────────────────────────────────────────────
   *  This bridge.js is SHARED by ALL APK versions (hosted on webcod.in).
   *  The gate is ARMED only when the RN app injects appVersion >= 1.0.3
   *  via INJECT_VARS. Legacy apps (1.0.2 and older inject NO appVersion)
   *  NEVER see the gate — no overlay, no timers, no "Connecting…" hang;
   *  they play exactly as before the hard gate existed. */
  var gateArmed  = false;
  var appVersion = '';
  function verAtLeast(v, min) {
    if (typeof v !== 'string' || !v) return false;
    var a = v.split('.'), b = min.split('.');
    for (var i = 0; i < 3; i++) {
      var x = parseInt(a[i], 10), y = parseInt(b[i], 10) || 0;
      if (isNaN(x)) return false;
      if (x > y) return true;
      if (x < y) return false;
    }
    return true;
  }

  function wsOpen(pbId) {
    if (!wsApiUrl || wsConn) return;
    if (gateArmed) {
      if (gateTimer) clearTimeout(gateTimer);
      gateTimer = setTimeout(gateFail, 12000);
    }
    try {
      var base = wsApiUrl.replace(/\/+$/, '').replace(/^https?:\/\//, '');
      var url  = 'wss://' + base + '/api/ws/game';
      wsConn = new WebSocket(url);
      wsConn.onopen = function () {
        wsReady = true;
        /* appVersion drives server-side routing: >=1.0.3 → strict hard
         * gate; absent/older (legacy APKs) → old immediate-start logic. */
        wsConn.send(JSON.stringify({ type: 'GAME_START', pbId: pbId, v: 2, appVersion: appVersion }));
        console.log('[Bridge] WS connected → GAME_START sent (appVersion=' + (appVersion || 'legacy') + ')');
      };
      wsConn.onmessage = function (e) {
        try {
          console.log('[Bridge] WS <<<', e.data);
          var m = JSON.parse(e.data);
          /* Relay server messages the RN app needs:
           *   COMMITTED — carries matchId (server replay-attack guard for reward claims)
           *   HIT_ACK   — feeds the RN auto-clicker monitor
           * Server GAME_OVER / SESSION_READY are NOT relayed — their payload shape
           * would collide with the bridge's own GAME_OVER handling in the app. */
          if (m && (m.type === 'COMMITTED' || m.type === 'HIT_ACK')) post(m.type, m);
          /* MATCH GATE: server confirmed the match row is in the database —
           * unlock the game. Until this message arrives, input is blocked. */
          if (m && m.type === 'SESSION_READY') {
            sessionReady = true;
            if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
            gateHide();
            console.log('[Bridge] SESSION_READY — match row confirmed, game unlocked');
          }
          if (m && m.type === 'ERROR' && m.reason === 'match_create_failed') {
            gateFail();
          }
        } catch (err) {}
      };
      wsConn.onerror = function () { wsReady = false; wsConn = null; if (!sessionReady) gateFail(); };
      wsConn.onclose = function () { wsReady = false; wsConn = null; if (!sessionReady) gateFail(); };
      console.log('[Bridge] WS opening:', url);
    } catch (err) {
      console.warn('[Bridge] WS open failed:', err);
      wsConn = null;
    }
  }

  function wsSend(type, extra) {
    if (!wsReady || !wsConn) return;
    try {
      wsConn.send(JSON.stringify(Object.assign({ type: type }, extra || {})));
      console.log('[Bridge] WS >>>', type, JSON.stringify(extra || {}));
    } catch (err) { wsReady = false; }
  }

  /* ── Score integrity guards ──────────────────────────────────────────────
   *  MAX_DELTA_PER_TICK  – max points allowed per 100ms polling tick.
   *  ABSOLUTE_MAX_SCORE  – hard cap for a single session (2000 pts rule).
   * ──────────────────────────────────────────────────────────────────────── */
  var MAX_DELTA_PER_TICK = 15;     /* fallback only: max 3 hits × 5 pts per 100ms tick */
  var ABSOLUTE_MAX_SCORE = 2000;   /* 2000-point session cap */
  var lastTrackedScore   = 0;
  var lastPostedScore    = -1;
  var sessionStartMs     = 0;
  var gameOverSent       = false;
  var lastServerScore    = 0;
  var pendingHits        = 0;
  var localPT            = 0;      /* STRICTLY ADDITIVE — never resets on score drop */
  var scoreVarHooked     = false;

  /* ── Init grace period ────────────────────────────────────────────────
   *  On low-end Android devices the Construct 3 runtime initialises
   *  slowly. During those first frames the layout manager may briefly
   *  sit on the "death" layout, or the score hook may fire a 0→X→0
   *  transition as C3 resets variables. Either event would instantly
   *  fire GAME_OVER with 0 PT before the player even touches the screen.
   *
   *  Fix: track `gameReadyAt` (set when the match gate lifts / bridge
   *  becomes ready) and suppress all GAME_OVER signals for INIT_GRACE_MS
   *  after that moment — except for TIME_UP which must always go through.
   * ─────────────────────────────────────────────────────────────────── */
  var INIT_GRACE_MS = 1500;   /* ms to ignore GAME_OVER after game ready */
  var gameReadyAt   = 0;      /* 0 = not ready yet; set on gate-lift/bridge-ready */

  function isInitGrace() {
    /* Still in grace when: not ready yet OR < INIT_GRACE_MS since ready */
    return gameReadyAt === 0 || (Date.now() - gameReadyAt) < INIT_GRACE_MS;
  }

  /* ── Runtime accessor ────────────────────────────────────────────────── */
  function rt() {
    try {
      var ri = window['c3_runtimeInterface'];
      if (!ri) return null;
      if (typeof ri._GetLocalRuntime === 'function') {
        var lr = ri._GetLocalRuntime();
        if (lr) return lr;
      }
      if (ri._localRuntime) return ri._localRuntime;
      if (ri._iRuntime)     return ri._iRuntime;
      return null;
    } catch (e) { return null; }
  }

  /* ── Layout name reader ───────────────────────────────────────────────── */
  function layoutName(runtime) {
    try {
      var lm = runtime._layoutManager;
      if (!lm) return '';
      var l = typeof lm.GetMainRunningLayout === 'function'
            ? lm.GetMainRunningLayout() : null;
      if (!l) return '';
      return typeof l.GetName === 'function' ? l.GetName() : (l._name || l.name || '');
    } catch (e) { return ''; }
  }

  /* ── Read a C3 global variable ──────────────────────────────────────── */
  function readGlobal(runtime, name) {
    try {
      var esm = runtime._eventSheetManager;
      if (!esm) { console.warn('[Bridge] readGlobal: no _eventSheetManager'); return 0; }

      var globals = esm._allGlobalVars;
      if (Array.isArray(globals)) {
        for (var i = 0; i < globals.length; i++) {
          var v = globals[i];
          if (v && v._name === name) {
            var val = typeof v.GetValue === 'function' ? v.GetValue() : v._value;
            return +val || 0;
          }
        }
      }

      var locals = esm._allLocalVars;
      if (Array.isArray(locals)) {
        for (var i = 0; i < locals.length; i++) {
          var v = locals[i];
          if (v && v._name === name) {
            var val2 = 0;
            if (v._hasSingleValue) {
              val2 = +v._value || 0;
            } else {
              try {
                if (typeof v.GetValue === 'function') val2 = +v.GetValue() || 0;
              } catch (e2) {}
            }
            return val2;
          }
        }
      }

      console.warn('[Bridge] [ERROR] Var "' + name + '" not found');
    } catch (e) { console.warn('[Bridge] readGlobal error:', e); }
    return 0;
  }

  /* ── Write a C3 global variable ──────────────────────────────────────── */
  function writeGlobal(runtime, name, value) {
    try {
      var num = Number(value) || 0;
      var esm = runtime._eventSheetManager;
      if (!esm) { console.warn('[Bridge] writeGlobal: no _eventSheetManager'); return false; }

      var entry = null;

      var globals = esm._allGlobalVars;
      if (Array.isArray(globals)) {
        for (var i = 0; i < globals.length; i++) {
          if (globals[i] && globals[i]._name === name) { entry = globals[i]; break; }
        }
      }

      if (!entry) {
        var locals = esm._allLocalVars;
        if (Array.isArray(locals)) {
          for (var i = 0; i < locals.length; i++) {
            if (locals[i] && locals[i]._name === name) { entry = locals[i]; break; }
          }
        }
      }

      if (!entry) { console.warn('[Bridge] writeGlobal: var not found:', name); return false; }

      if (typeof entry.SetValue === 'function') {
        entry.SetValue(num);
      } else if (entry._hasSingleValue) {
        entry._value = num;
      } else {
        console.warn('[Bridge] writeGlobal: cannot set var:', name);
        return false;
      }

      console.log('[Bridge] writeGlobal', name, '=', num);
      return true;
    } catch (e) { console.warn('[Bridge] writeGlobal error:', e); return false; }
  }

  /* ── Event-driven score hook ─────────────────────────────────────────
   *  Overrides C3's internal SetValue() on the 'score' global var.
   *  Fires at the exact animation frame of each hit — no poll lag.
   *  Each positive delta = 1 hit. Capped at 4 hits per call.
   *  Falls back to polling if the hook cannot be installed.
   * ──────────────────────────────────────────────────────────────────── */
  function hookScoreVar(runtime) {
    try {
      var esm = runtime._eventSheetManager;
      if (!esm) return false;
      var globals = esm._allGlobalVars;
      if (!Array.isArray(globals)) return false;

      for (var i = 0; i < globals.length; i++) {
        var v = globals[i];
        if (!v || v._name !== 'score') continue;
        if (v.__shibHooked) return true;
        if (typeof v.SetValue !== 'function') return false;

        var origSetValue = v.SetValue.bind(v);
        v.SetValue = function (newVal) {
          var prev = typeof v.GetValue === 'function' ? v.GetValue() : v._value;
          origSetValue(newVal);
          var delta = newVal - prev;
          if (delta > 0 && !gameOverSent) {
            var newHits = Math.max(1, Math.min(Math.round(delta / 5), 4));
            for (var h = 0; h < newHits; h++) {
              localPT += 5;
              pendingHits++;
            }
            console.log('[Bridge] HOOK +' + delta + 'pts →' + newHits +
              ' hit(s) queued | localPT=' + localPT + ' pending=' + pendingHits);
          }
          /* ── Score-reset-to-zero guard ─────────────────────────────────
           *  If score is forcibly reset to 0 mid-session it signals a
           *  RestartLayout / back-button exploit. Fire GAME_OVER immediately.
           *  Guard: skip during init grace — C3 resets globals to 0 while
           *  loading assets on slow devices, not an exploit.
           * ────────────────────────────────────────────────────────────── */
          if (newVal === 0 && prev > 0 && localPT > 0 && !gameOverSent && !isInitGrace()) {
            console.warn('[Bridge] HOOK: score reset 0 mid-session (prev=' + prev +
              ' localPT=' + localPT + ') → GAME_OVER (exploit blocked)');
            setTimeout(function () { if (!gameOverSent) fireGameOver(rt(), 'back_button'); }, 0);
          }
        };
        v.__shibHooked = true;
        console.log('[Bridge] Score SetValue hooked ✓ (event-driven mode active)');
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[Bridge] hookScoreVar failed:', e);
      return false;
    }
  }

  /* ── Dump all global vars (debug) ───────────────────────────────────── */
  function dumpAllVars(runtime) {
    try {
      var esm = runtime._eventSheetManager;
      if (!esm) return;
      var globals = esm._allGlobalVars || [];
      console.log('[Bridge] _allGlobalVars (' + globals.length + '):',
        globals.map(function(v) { return v._name + '=' + v._value; }).join(', '));
    } catch (e) { console.warn('[Bridge] dumpAllVars error:', e); }
  }

  /* ── postMessage OUT ─────────────────────────────────────────────────── */
  function post(type, extra) {
    var json = JSON.stringify(Object.assign({ type: type }, extra || {}));
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(json);
    } else {
      window.parent.postMessage(json, '*');
    }
    console.log('[Bridge] >>>OUT', json);
  }

  /* ── Shared helper: build & send a GAME_OVER message ────────────────── */
  function fireGameOver(runtime, reason) {
    if (gameOverSent) return;
    /* Init grace: suppress GAME_OVER for INIT_GRACE_MS after game becomes
     * ready. TIME_UP always bypasses the grace — server timer is authoritative. */
    if (reason !== 'time_limit' && isInitGrace()) {
      console.warn('[Bridge] GAME_OVER("' + reason + '") suppressed — init grace (' +
        (gameReadyAt ? (Date.now() - gameReadyAt) + 'ms since ready' : 'not ready yet') + ')');
      return;
    }
    gameOverSent = true;

    var score = Math.min(localPT, ABSOLUTE_MAX_SCORE);
    var elapsedMs = sessionStartMs > 0 ? (Date.now() - sessionStartMs) : 0;

    var prevTomatoes = (window.__shibGameState && typeof window.__shibGameState.collectedTomatoes === 'number')
      ? window.__shibGameState.collectedTomatoes : 0;
    var newTomatoes = prevTomatoes + score;
    if (window.__shibGameState) window.__shibGameState.collectedTomatoes = newTomatoes;

    console.log('[Bridge] GAME_OVER reason=' + reason + ' localPT=' + score +
      ' tomatoes=' + newTomatoes + ' elapsed=' + Math.round(elapsedMs / 1000) + 's');

    navBlocked = true;

    post('GAME_OVER', {
      score:              score,
      collected_tomatoes: newTomatoes,
      pb_id:              (window.__shibGameState && window.__shibGameState.pbId) || '',
      elapsed_ms:         elapsedMs,
      reason:             reason || 'death',
    });
    wsSend('GAME_OVER', { score: score, elapsed_ms: elapsedMs });

    sessionStartMs   = Date.now();
    lastTrackedScore = 0;
    lastPostedScore  = -1;
    localPT          = 0;
    lastServerScore  = 0;
    pendingHits      = 0;
  }

  /* ── Hook C3 navigation ──────────────────────────────────────────────
   *  GoToLayoutByName → DOUBLE_REWARD modal
   *  GoToLayout / RestartLayout / startLayout / _startLayout → GAME_OVER
   *
   *  During an active session (localPT > 0, !gameOverSent), ANY layout
   *  change = exploit attempt → GAME_OVER immediately.
   *  When navBlocked=true (post-death), navigation is queued.
   * ─────────────────────────────────────────────────────────────────── */
  function hookNavigation(runtime) {
    var lm = runtime._layoutManager;
    if (!lm) { console.warn('[Bridge] No _layoutManager — nav blocking unavailable'); return; }

    if (typeof lm.GoToLayoutByName === 'function') {
      var origGTLBN = lm.GoToLayoutByName.bind(lm);
      lm.GoToLayoutByName = function () {
        if (navBlocked) {
          console.log('[Bridge] Nav BLOCKED (GoToLayoutByName → "' + arguments[0] + '") → DOUBLE_REWARD');
          pendingNav = { fn: origGTLBN, args: Array.prototype.slice.call(arguments) };
          var score2x   = Math.min(localPT, ABSOLUTE_MAX_SCORE);
          var elapsed2x = sessionStartMs > 0 ? (Date.now() - sessionStartMs) : 0;
          var prevTomatoes = (window.__shibGameState &&
            typeof window.__shibGameState.collectedTomatoes === 'number')
            ? window.__shibGameState.collectedTomatoes : 0;
          post('DOUBLE_REWARD', {
            score:              score2x,
            collected_tomatoes: prevTomatoes + score2x,
            pb_id:              (window.__shibGameState && window.__shibGameState.pbId) || '',
            elapsed_ms:         elapsed2x,
          });
          return;
        }
        if (!gameOverSent && localPT > 0) {
          console.log('[Bridge] GoToLayoutByName mid-session → GAME_OVER (exploit blocked)');
          fireGameOver(rt(), 'back_button');
          return;
        }
        return origGTLBN.apply(lm, arguments);
      };
      console.log('[Bridge] Hooked GoToLayoutByName');
    }

    ['GoToLayout', 'RestartLayout', 'startLayout', '_startLayout'].forEach(function (method) {
      if (typeof lm[method] !== 'function') return;
      var orig = lm[method].bind(lm);
      lm[method] = function () {
        if (navBlocked) {
          console.log('[Bridge] Nav BLOCKED (' + method + ') — queued');
          pendingNav = { fn: orig, args: Array.prototype.slice.call(arguments) };
          return;
        }
        if (!gameOverSent && localPT > 0) {
          console.log('[Bridge] ' + method + ' mid-session → GAME_OVER (exploit blocked)');
          fireGameOver(rt(), 'back_button');
          return;
        }
        return orig.apply(lm, arguments);
      };
      console.log('[Bridge] Hooked', method);
    });
  }

  /* ── Inject server data into C3 globals ─────────────────────────────── */
  var injectQueue = null;

  function applyInject(runtime, vars) {
    var ok = 0;
    var hsVal = vars.totalScore !== undefined ? vars.totalScore
              : vars.lastSessionScore !== undefined ? vars.lastSessionScore : 0;
    if (writeGlobal(runtime, 'hscore', hsVal)) ok++;

    window.__shibGameState = {
      pbId:              vars.pbId              || '',
      powerTokens:       vars.powerTokens       || 0,
      collectedTomatoes: vars.collectedTomatoes || 0,
      lastSessionScore:  vars.lastSessionScore  || 0,
      totalScore:        vars.totalScore        || 0,
    };
    console.log('[Bridge] Injected state:', JSON.stringify(window.__shibGameState), '| C3 writes:', ok);
    dumpAllVars(runtime);
    post('INJECT_DONE', window.__shibGameState);
  }

  /* ── Handle messages FROM React Native ──────────────────────────────── */
  window.addEventListener('message', function (e) {
    var msg;
    try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }
    catch (err) { return; }
    if (!msg || !msg.type) return;
    console.log('[Bridge] <<<IN', JSON.stringify(msg));

    var runtime = rt();

    if (msg.type === 'INJECT_VARS') {
      if (runtime) applyInject(runtime, msg);
      else         injectQueue = msg;
      wsApiUrl   = msg.apiUrl || '';
      appVersion = msg.appVersion || '';
      /* Arm the match gate ONLY for 1.0.3+ apps. 1.0.2 sends no
       * appVersion → gate stays disarmed → no overlay, no hang. */
      if (verAtLeast(appVersion, '1.0.3')) {
        gateArmed = true;
        if (!sessionReady) {
          gateShow('Connecting…', false);
          /* Backstop: if wsOpen never runs (missing apiUrl/pbId), the
           * 12s post-WS timer never starts — fail to the Retry screen
           * after 20s instead of hanging on "Connecting…" forever. */
          if (gateTimer) clearTimeout(gateTimer);
          gateTimer = setTimeout(gateFail, 20000);
        }
      }
      if (wsApiUrl && msg.pbId) wsOpen(msg.pbId);
    }

    if (msg.type === 'TIME_UP') {
      console.log('[Bridge] TIME_UP received — forcing GAME_OVER');
      fireGameOver(runtime, 'time_limit');
    }

    if (msg.type === 'RESUME_NAVIGATION') {
      navBlocked = false;
      if (pendingNav) { var nav = pendingNav; pendingNav = null; nav.fn.apply(null, nav.args); }
    }

    if (msg.type === 'RELOAD_GAME') {
      navBlocked = false; pendingNav = null;
      window.location.reload();
    }
  });

  /* ── Main loop — 100ms tick ──────────────────────────────────────────
   *  PRIMARY: drain pendingHits queue + layout change detection.
   *  Score HIT DETECTION is event-driven via the SetValue hook.
   *  Polling fallback activates only when hook install fails.
   * ──────────────────────────────────────────────────────────────────── */
  function tick() {
    var runtime = rt();
    if (!runtime) { setTimeout(tick, 100); return; }

    if (!bridgeReady) {
      bridgeReady      = true;
      sessionStartMs   = Date.now();
      lastTrackedScore = 0;
      lastPostedScore  = -1;
      gameOverSent     = false;
      hookNavigation(runtime);
      scoreVarHooked = hookScoreVar(runtime);
      if (injectQueue) { applyInject(runtime, injectQueue); injectQueue = null; }
      post('BRIDGE_READY', {});
      console.log('[Bridge] Ready | hook=' + scoreVarHooked);
      dumpAllVars(runtime);
      /* For legacy / non-gated apps (gate never armed → gateHide never called),
       * start the init grace clock here so C3 init jitter is still suppressed. */
      if (!gateArmed && gameReadyAt === 0) gameReadyAt = Date.now();
    }

    /* ── Retry hook install if it failed on first ready tick ──────────── */
    if (!scoreVarHooked) {
      scoreVarHooked = hookScoreVar(runtime);
    }

    /* ── FALLBACK polling hit-detection (only when hook not installed) ── */
    if (!scoreVarHooked) {
      var currentScore = readGlobal(runtime, 'score');
      if (currentScore > lastTrackedScore) {
        var delta = currentScore - lastTrackedScore;
        if (delta > MAX_DELTA_PER_TICK) {
          var cappedScore = lastTrackedScore + MAX_DELTA_PER_TICK;
          console.warn('[Bridge] Fallback spike: ' + lastTrackedScore +
            ' → ' + currentScore + '. Capping to ' + cappedScore);
          writeGlobal(runtime, 'score', cappedScore);
          currentScore = cappedScore;
          delta = MAX_DELTA_PER_TICK;
        }
        lastTrackedScore = currentScore;
        if (!gameOverSent && currentScore > lastServerScore) {
          var fallbackHits = Math.max(1, Math.min(Math.round(delta / 5), 3));
          for (var fh = 0; fh < fallbackHits; fh++) {
            localPT += 5;
            pendingHits++;
          }
          lastServerScore = currentScore;
          console.log('[Bridge] POLL +' + delta + 'pts →' + fallbackHits +
            ' hit(s) | localPT=' + localPT);
        }
      } else if (currentScore < lastTrackedScore) {
        lastTrackedScore = currentScore;
        lastPostedScore  = -1;
      }
    }

    /* ── Drain one queued hit per tick → WebSocket, rate-limited ──────── */
    if (pendingHits > 0 && !gameOverSent) {
      pendingHits--;
      wsSend('KNIFE_HIT', {});
    }

    /* ── PT cap: 2000 points → force GAME_OVER ────────────────────────── */
    if (!gameOverSent && localPT >= ABSOLUTE_MAX_SCORE) {
      console.log('[Bridge] localPT cap reached (' + localPT + ') — firing GAME_OVER');
      fireGameOver(runtime, 'score_limit');
      setTimeout(tick, 100);
      return;
    }

    /* ── Broadcast SCORE_UPDATE — localPT never drops mid-game ─────────── */
    if (!gameOverSent && localPT !== lastPostedScore) {
      post('SCORE_UPDATE', { score: localPT });
      lastPostedScore = localPT;
    }

    /* ── Layout change detection ──────────────────────────────────────── */
    var name = layoutName(runtime);
    if (name !== lastLayout) {
      console.log('[Bridge] Layout: "' + lastLayout + '" → "' + name + '"');
      lastLayout = name;

      if (name.toLowerCase() === 'death') {
        /* Init grace: on slow devices C3 may briefly land on the death
         * layout during initialisation. Skip — do not fire a false GAME_OVER. */
        if (isInitGrace()) {
          console.warn('[Bridge] Death layout detected but init grace active — suppressed');
          setTimeout(tick, 100);
          return;
        }

        var score     = Math.min(localPT, ABSOLUTE_MAX_SCORE);
        var elapsedMs = sessionStartMs > 0 ? (Date.now() - sessionStartMs) : 0;

        if (score === 0) {
          console.warn('[Bridge] DEATH with 0 localPT — no hits recorded this session');
        }

        var prevTomatoes = (window.__shibGameState &&
          typeof window.__shibGameState.collectedTomatoes === 'number')
          ? window.__shibGameState.collectedTomatoes : 0;
        var newTomatoes = prevTomatoes + score;
        if (window.__shibGameState) window.__shibGameState.collectedTomatoes = newTomatoes;

        console.log('[Bridge] DEATH — localPT=' + score +
          ' tomatoes=' + newTomatoes + ' elapsed=' + Math.round(elapsedMs / 1000) + 's');

        if (!gameOverSent) {
          gameOverSent = true;
          navBlocked   = true;

          post('GAME_OVER', {
            score:              score,
            collected_tomatoes: newTomatoes,
            pb_id:              (window.__shibGameState && window.__shibGameState.pbId) || '',
            elapsed_ms:         elapsedMs,
            reason:             'death',
          });
          wsSend('GAME_OVER', { score: score, elapsed_ms: elapsedMs });

          /* Reset ALL hit tracking for the next round */
          sessionStartMs   = Date.now();
          lastTrackedScore = 0;
          lastPostedScore  = -1;
          localPT          = 0;
          lastServerScore  = 0;
          pendingHits      = 0;
        }

      } else if (navBlocked && name.toLowerCase() !== 'death') {
        /* Player re-entered game from menu — genuine new session */
        navBlocked      = false;
        gameOverSent    = false;
        lastPostedScore = -1;
        localPT         = 0;
        lastServerScore = 0;
        pendingHits     = 0;
      }
    }

    setTimeout(tick, 100);
  }

  /* Start polling after page loads */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tick, 1500); });
  } else {
    setTimeout(tick, 1500);
  }

  window.__shibBridge = { post: post, writeGlobal: writeGlobal, readGlobal: readGlobal, rt: rt };
  console.log('[Bridge] Script loaded — waiting for C3 runtime…');
})();
