;(function () {
  'use strict';

  /* =============================================================
   *  SHIB Mine — Construct 3 Bridge
   *
   *  Messages OUT → React Native:
   *    BRIDGE_READY
   *    SCORE_UPDATE   { score }                              ← NEW: live score tick
   *    GAME_OVER      { score, collected_tomatoes, pb_id, elapsed_ms, reason }
   *    DOUBLE_REWARD  { score, collected_tomatoes, pb_id, elapsed_ms }
   *    INJECT_DONE    { state }
   *
   *  Messages IN ← React Native:
   *    INJECT_VARS    { pbId, powerTokens, collectedTomatoes, lastSessionScore, totalScore }
   *    TIME_UP                                               ← NEW: 2-min timer expired
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

  function wsOpen(pbId) {
    if (!wsApiUrl || wsConn) return;
    try {
      var base = wsApiUrl.replace(/\/+$/, '').replace(/^https?:\/\//, '');
      var url  = 'wss://' + base + '/api/ws/game';
      wsConn = new WebSocket(url);
      wsConn.onopen = function () {
        wsReady = true;
        wsConn.send(JSON.stringify({ type: 'GAME_START', pbId: pbId }));
        console.log('[Bridge] WS connected → GAME_START sent');
      };
      wsConn.onmessage = function (e) {
        try { console.log('[Bridge] WS <<<', e.data); } catch (err) {}
      };
      wsConn.onerror = function () { wsReady = false; wsConn = null; };
      wsConn.onclose = function () { wsReady = false; wsConn = null; };
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
   *  MAX_DELTA_PER_TICK  – max points we allow per 300 ms polling tick.
   *  ABSOLUTE_MAX_SCORE  – hard cap for a single session (2000 pts rule).
   *                        Any score above this triggers GAME_OVER automatically.
   * ──────────────────────────────────────────────────────────────────────── */
  var MAX_DELTA_PER_TICK = 15;  /* fallback only: max 3 hits × 5 pts per 100ms tick */
  var ABSOLUTE_MAX_SCORE = 2000;   /* ← 2000-point session cap */
  var lastTrackedScore   = 0;      /* last verified score value */
  var lastPostedScore    = -1;     /* last score sent via SCORE_UPDATE */
  var sessionStartMs     = 0;      /* set when bridge becomes ready */
  var gameOverSent       = false;  /* prevents double GAME_OVER per session */
  var lastServerScore    = 0;      /* last score the server was told about (for hit detection) */
  var pendingHits        = 0;      /* hits detected but not yet sent — drained one per tick */
  var localPT            = 0;      /* local mirror of serverPT — STRICTLY ADDITIVE, never resets on score drop */
  var scoreVarHooked     = false;  /* true once SetValue hook is installed on C3 score var */

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
   *  Override C3's internal SetValue() on the 'score' global var object.
   *  Fires at the exact animation frame of each hit (~16 ms) — no poll lag.
   *  Each positive SetValue call = 1 hit regardless of delta size.
   *  Capped at 4 hits per call to absorb legitimate multi-point bonuses.
   *  Falls back gracefully to polling if the hook cannot be installed.
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
        if (v.__shibHooked) return true;               /* already installed */
        if (typeof v.SetValue !== 'function') return false;

        /* Wrap SetValue — fires every time C3 modifies score */
        var origSetValue = v.SetValue.bind(v);
        v.SetValue = function (newVal) {
          /* Read current value BEFORE writing so we get the true delta */
          var prev = typeof v.GetValue === 'function' ? v.GetValue() : v._value;
          origSetValue(newVal);                          /* always write first */
          var delta = newVal - prev;
          if (delta > 0 && !gameOverSent) {
            /* Weapon Master awards 5 pts per hit; allow up to 4 hits per call
             * to handle genuine bonus-round scoring, but cap beyond that. */
            var newHits = Math.max(1, Math.min(Math.round(delta / 5), 4));
            for (var h = 0; h < newHits; h++) {
              localPT += 5;
              pendingHits++;
            }
            console.log('[Bridge] HOOK +' + delta + 'pts →' + newHits +
              ' hit(s) queued | localPT=' + localPT + ' pending=' + pendingHits);
          }
          /* Score decreases (level reset, death) are silently ignored —
           * localPT and pendingHits never decrease. */
        };
        v.__shibHooked = true;
        console.log('[Bridge] Score SetValue hooked ✓ (event-driven mode active)');
        return true;
      }
      return false;     /* var not found yet — caller will retry next tick */
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
    gameOverSent = true;

    /* localPT is the authoritative score — it only ever went up by +5 per hit,
     * so it is immune to C3's internal score resets and jumps.            */
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
    /* Notify server to commit session */
    wsSend('GAME_OVER', { score: score, elapsed_ms: elapsedMs });

    /* Reset ALL hit tracking for the next round */
    sessionStartMs   = Date.now();
    lastTrackedScore = 0;
    lastPostedScore  = -1;
    localPT          = 0;
    lastServerScore  = 0;
    pendingHits      = 0;
  }

  /* ── Hook C3 navigation ──────────────────────────────────────────────
   *  sprite14 (circle/refresh icon) → GoToLayoutByName → DOUBLE_REWARD (2× PT)
   *  rstrt    (back-arrow icon)     → GoToLayout       → claim modal (GAME_OVER)
   * ─────────────────────────────────────────────────────────────────── */
  function hookNavigation(runtime) {
    var lm = runtime._layoutManager;
    if (!lm) { console.warn('[Bridge] No _layoutManager — nav blocking unavailable'); return; }

    function makeHook(method, intentFn) {
      if (typeof lm[method] !== 'function') return;
      var orig = lm[method].bind(lm);
      lm[method] = function () {
        if (navBlocked) {
          var dest = arguments[0];
          var intent = intentFn(dest);
          console.log('[Bridge] Nav BLOCKED (' + method + ' → "' + dest + '") intent=' + intent);
          pendingNav = { fn: orig, args: Array.prototype.slice.call(arguments) };
          if (intent === 'double') {
            /* Use localPT — the only score that never reset during gameplay */
            var score2x   = Math.min(localPT, ABSOLUTE_MAX_SCORE);
            var elapsed2x = sessionStartMs > 0 ? (Date.now() - sessionStartMs) : 0;
            var prevTomatoes = (window.__shibGameState && typeof window.__shibGameState.collectedTomatoes === 'number')
              ? window.__shibGameState.collectedTomatoes : 0;
            post('DOUBLE_REWARD', {
              score:              score2x,
              collected_tomatoes: prevTomatoes + score2x,
              pb_id:              (window.__shibGameState && window.__shibGameState.pbId) || '',
              elapsed_ms:         elapsed2x,
            });
          }
          return;
        }
        /* ── Back button pressed during an active session (navBlocked=false) ──
         *  'claim' = GoToLayout (back/restart arrow).  Treat as GAME_OVER so
         *  the player cannot farm level 1 without penalty.  Score is locked at
         *  the current localPT and committed to the server immediately.
         * ─────────────────────────────────────────────────────────────────── */
        var liveIntent = intentFn(arguments[0]);
        if (liveIntent === 'claim' && !gameOverSent) {
          console.log('[Bridge] Back button mid-session → GAME_OVER (back_button exploit blocked)');
          fireGameOver(rt(), 'back_button');
          return;  /* navigation blocked — game ends here */
        }

        return orig.apply(lm, arguments);
      };
      console.log('[Bridge] Hooked', method);
    }

    makeHook('GoToLayoutByName', function () { return 'double'; });
    makeHook('GoToLayout', function () { return 'claim'; });
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
      /* Open server WS for score validation once we have pbId + apiUrl */
      wsApiUrl = msg.apiUrl || '';
      if (wsApiUrl && msg.pbId) wsOpen(msg.pbId);
    }

    /* TIME_UP — 2-minute timer from React Native expired */
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

  /* ── Main loop — 100ms tick ─────────────────────────────────────────
   *  PRIMARY role: drain pendingHits queue + layout change detection.
   *  Score HIT DETECTION is handled by the SetValue hook (event-driven).
   *  Polling fallback for hit detection activates only when hook fails.
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
        /* Clamp delta: max 15 pts per 100ms = 3 legitimate hits × 5 pts */
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

    /* ── PT cap: 2000 hit-based points → force GAME_OVER ─────────────── */
    if (!gameOverSent && localPT >= ABSOLUTE_MAX_SCORE) {
      console.log('[Bridge] localPT cap reached (' + localPT + ') — firing GAME_OVER');
      fireGameOver(runtime, 'score_limit');
      setTimeout(tick, 100);
      return;
    }

    /* ── Broadcast SCORE_UPDATE using localPT (never drops mid-game) ─── */
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
        /* Use localPT — the validated, additive count that never reset during gameplay */
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

          /* ── Reset ALL hit tracking for the NEXT round ── */
          sessionStartMs   = Date.now();
          lastTrackedScore = 0;
          lastPostedScore  = -1;
          localPT          = 0;
          lastServerScore  = 0;
          pendingHits      = 0;
        }

      } else if (navBlocked && name.toLowerCase() !== 'death') {
        /* Player re-entered the game from the menu — genuine new session */
        navBlocked      = false;
        gameOverSent    = false;
        lastPostedScore = -1;
        localPT         = 0;   // fresh round
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
