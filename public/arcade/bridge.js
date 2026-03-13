;(function () {
  'use strict';

  /* =============================================================
   *  SHIB Mine — Construct 3 Bridge
   *
   *  SCORE FIX (root cause):
   *    readGlobal() was searching esm._globalVarsByName / esm._globalVars
   *    → neither exists in this C3 build.
   *    Correct path: esm._allGlobalVars[] — each item has ._name and ._value
   *    Confirmed by reading c3runtime.js:
   *      t.IsGlobal() ? this._allGlobalVars.push(t) : this._allLocalVars.push(t)
   *
   *  URL FIX:
   *    Bridge posts GAME_OVER with the score. React Native side was hitting
   *    a double-slash URL (BASE ends in '/') → Express returns HTML 404.
   *    Fix: games.tsx now uses new URL(path, base) for all fetch calls.
   *
   *  Button mapping (confirmed from source images):
   *    sprite14 (circle/refresh icon) → GoToLayoutByName → DOUBLE_REWARD → 2× PT
   *    rstrt    (back-arrow icon)     → GoToLayout("main menu") → claim modal
   *
   *  Messages OUT → React Native:
   *    BRIDGE_READY
   *    GAME_OVER      { score, collected_tomatoes, pb_id }
   *    DOUBLE_REWARD  { score, collected_tomatoes, pb_id }   ← was RETRY_REQUEST
   *    INJECT_DONE    { state }
   *
   *  Messages IN ← React Native:
   *    INJECT_VARS    { pbId, powerTokens, collectedTomatoes, lastSessionScore, totalScore }
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

  /* ── Score integrity guards ──────────────────────────────────────────────
   *  The C3 collision system can fire the score-add event multiple times for
   *  the same knife hit before C3 sets the knife to "stuck", causing the score
   *  to jump hundreds of points in a single 300 ms tick.
   *
   *  MAX_DELTA_PER_TICK  – max points we allow per 300 ms polling tick.
   *                        10 pts × 2 knives/tick = 20 is already generous;
   *                        anything above this is a collision-debounce glitch.
   *  ABSOLUTE_MAX_SCORE  – hard cap for a single session score (sent to server).
   * ──────────────────────────────────────────────────────────────────────── */
  var MAX_DELTA_PER_TICK = 20;
  var ABSOLUTE_MAX_SCORE = 9999;
  var lastTrackedScore   = 0;   // last verified score value
  var sessionStartMs     = 0;   // set when bridge becomes ready

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

  /* ── Read a C3 global variable ─────────────────────────────────────────
   *  ROOT FIX: use _allGlobalVars (NOT _globalVarsByName or _globalVars).
   *  Confirmed from c3runtime.js:
   *    t.IsGlobal() ? this._allGlobalVars.push(t) : this._allLocalVars.push(t)
   *  Each var object has ._name (string) and ._value (current value).
   *  For global vars: _hasSingleValue = true → ._value holds the live value.
   * ─────────────────────────────────────────────────────────────────────── */
  function readGlobal(runtime, name) {
    try {
      var esm = runtime._eventSheetManager;
      if (!esm) { console.warn('[Bridge] readGlobal: no _eventSheetManager'); return 0; }

      /* PRIMARY: global vars */
      var globals = esm._allGlobalVars;
      if (Array.isArray(globals)) {
        for (var i = 0; i < globals.length; i++) {
          var v = globals[i];
          if (v && v._name === name) {
            var val = typeof v.GetValue === 'function' ? v.GetValue() : v._value;
            console.log('[Bridge] readGlobal (allGlobalVars) ' + name + ' = ' + val);
            return +val || 0;
          }
        }
      }

      /* FALLBACK: local vars (vars inside event blocks — _hasSingleValue may be true for statics) */
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
            console.log('[Bridge] readGlobal (allLocalVars) ' + name + ' = ' + val2);
            return val2;
          }
        }
      }

      console.warn('[Bridge] [ERROR] Score sync failed - Value is 0. Var "' + name + '" not found in _allGlobalVars or _allLocalVars');
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

      /* search _allGlobalVars */
      var globals = esm._allGlobalVars;
      if (Array.isArray(globals)) {
        for (var i = 0; i < globals.length; i++) {
          if (globals[i] && globals[i]._name === name) { entry = globals[i]; break; }
        }
      }

      /* fallback: _allLocalVars */
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
        console.warn('[Bridge] writeGlobal: cannot set var (no SetValue, not hasSingleValue):', name);
        return false;
      }

      console.log('[Bridge] writeGlobal', name, '=', num);
      return true;
    } catch (e) { console.warn('[Bridge] writeGlobal error:', e); return false; }
  }

  /* ── Dump all global vars (debug) ───────────────────────────────────── */
  function dumpAllVars(runtime) {
    try {
      var esm = runtime._eventSheetManager;
      if (!esm) return;
      var globals = esm._allGlobalVars || [];
      console.log('[Bridge] _allGlobalVars (' + globals.length + '):',
        globals.map(function(v) { return v._name + '=' + v._value; }).join(', '));
      var locals = esm._allLocalVars || [];
      console.log('[Bridge] _allLocalVars (' + locals.length + '):',
        locals.map(function(v) { return v._name; }).join(', '));
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

  /* ── Hook C3 navigation ──────────────────────────────────────────────
   *  sprite14 (circle/refresh icon) → GoToLayoutByName → DOUBLE_REWARD (2× PT)
   *  rstrt    (back-arrow icon)     → GoToLayout       → claim modal (GAME_OVER sent first)
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
            /* sprite14 clicked: trigger 2× reward in React Native */
            var score2x = Math.min(readGlobal(runtime, 'score'), ABSOLUTE_MAX_SCORE);
            var elapsed2x = sessionStartMs > 0 ? (Date.now() - sessionStartMs) : 0;
            if (elapsed2x > 0) {
              var maxForTime2x = Math.ceil((elapsed2x / 1000) * 15);
              if (score2x > maxForTime2x) score2x = maxForTime2x;
            }
            var prevTomatoes = (window.__shibGameState && typeof window.__shibGameState.collectedTomatoes === 'number')
              ? window.__shibGameState.collectedTomatoes : 0;
            post('DOUBLE_REWARD', {
              score:              score2x,
              collected_tomatoes: prevTomatoes + score2x,
              pb_id:              (window.__shibGameState && window.__shibGameState.pbId) || '',
              elapsed_ms:         elapsed2x,
            });
          }
          /* rstrt: GAME_OVER already sent when death layout entered — no extra message needed */
          return;
        }
        return orig.apply(lm, arguments);
      };
      console.log('[Bridge] Hooked', method);
    }

    /* GoToLayoutByName → sprite14 (circle/refresh = 2× Reward) */
    makeHook('GoToLayoutByName', function () { return 'double'; });
    /* GoToLayout → rstrt (back-arrow = Claim / exit to main menu) */
    makeHook('GoToLayout', function () { return 'claim'; });
  }

  /* ── Inject server data into C3 globals ─────────────────────────────── */
  var injectQueue = null;

  function applyInject(runtime, vars) {
    var ok = 0;
    /* Write hscore ← total_accumulated_score (all-time high score display in C3) */
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

  /* ── Main polling loop ───────────────────────────────────────────────── */
  function tick() {
    var runtime = rt();
    if (!runtime) { setTimeout(tick, 300); return; }

    if (!bridgeReady) {
      bridgeReady = true;
      sessionStartMs   = Date.now();
      lastTrackedScore = 0;
      hookNavigation(runtime);
      if (injectQueue) { applyInject(runtime, injectQueue); injectQueue = null; }
      post('BRIDGE_READY', {});
      console.log('[Bridge] Ready — runtime obtained via _GetLocalRuntime()');
      dumpAllVars(runtime);
    }

    /* ── Per-tick score integrity check ─────────────────────────────────────
     *  Read the live C3 score. If it jumped by more than MAX_DELTA_PER_TICK
     *  (20 pts per 300 ms) in this tick, the collision event fired multiple
     *  times for the same knife (C3 debounce failure). Write the capped value
     *  back into C3 immediately so the in-game display stays correct too.
     * ─────────────────────────────────────────────────────────────────────── */
    var currentScore = readGlobal(runtime, 'score');
    if (currentScore > lastTrackedScore) {
      var delta = currentScore - lastTrackedScore;
      if (delta > MAX_DELTA_PER_TICK) {
        var cappedScore = lastTrackedScore + MAX_DELTA_PER_TICK;
        console.warn('[Bridge] Score spike detected: ' + lastTrackedScore +
          ' → ' + currentScore + ' (delta=' + delta + '). Capping to ' + cappedScore);
        writeGlobal(runtime, 'score', cappedScore);
        currentScore = cappedScore;
      }
      lastTrackedScore = currentScore;
    } else if (currentScore < lastTrackedScore) {
      /* Game restarted or layout changed — reset tracker */
      lastTrackedScore = currentScore;
    }

    var name = layoutName(runtime);
    if (name !== lastLayout) {
      console.log('[Bridge] Layout: "' + lastLayout + '" → "' + name + '"');
      lastLayout = name;

      if (name.toLowerCase() === 'death') {
        /* Re-read after any per-tick correction, then apply the absolute cap */
        var score = Math.min(readGlobal(runtime, 'score'), ABSOLUTE_MAX_SCORE);
        var elapsedMs = sessionStartMs > 0 ? (Date.now() - sessionStartMs) : 0;

        /* Additional time-based sanity: clamp to max possible for elapsed time.
         * Allow 15 pts/sec absolute maximum (generous: 3 knives/sec × 5 pts). */
        if (elapsedMs > 0) {
          var maxForTime = Math.ceil((elapsedMs / 1000) * 15);
          if (score > maxForTime) {
            console.warn('[Bridge] Score ' + score + ' exceeds time-based max ' + maxForTime +
              ' for ' + Math.round(elapsedMs / 1000) + 's session. Capping.');
            score = maxForTime;
            writeGlobal(runtime, 'score', score);
          }
        }

        if (score === 0) {
          console.error('[Bridge] [ERROR] Score sync failed - Value is 0. Dumping all vars:');
          dumpAllVars(runtime);
        }

        /* Compute collected_tomatoes = server baseline + this session's score */
        var prevTomatoes = (window.__shibGameState &&
          typeof window.__shibGameState.collectedTomatoes === 'number')
          ? window.__shibGameState.collectedTomatoes : 0;
        var newTomatoes = prevTomatoes + score;
        if (window.__shibGameState) window.__shibGameState.collectedTomatoes = newTomatoes;

        console.log('[Bridge] DEATH — score=' + score +
          ' collected_tomatoes=' + newTomatoes + ' (prev=' + prevTomatoes + ')' +
          ' elapsed=' + Math.round(elapsedMs / 1000) + 's');

        navBlocked = true;

        /* Send GAME_OVER — all values as numbers, plus elapsed for server validation */
        post('GAME_OVER', {
          score:              score,
          collected_tomatoes: newTomatoes,
          pb_id:              (window.__shibGameState && window.__shibGameState.pbId) || '',
          elapsed_ms:         elapsedMs,
        });

        /* Reset session timer for the next game */
        sessionStartMs   = Date.now();
        lastTrackedScore = 0;

      } else if (navBlocked && name.toLowerCase() !== 'death') {
        navBlocked = false;
      }
    }

    setTimeout(tick, 300);
  }

  /* Start polling after page loads */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tick, 1500); });
  } else {
    setTimeout(tick, 1500);
  }

  window.__shibBridge = { post: post, writeGlobal: writeGlobal, readGlobal: readGlobal, rt: rt };
  console.log('[Bridge] Script loaded — waiting for C3 runtime (_GetLocalRuntime)…');
})();
