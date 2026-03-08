;(function () {
  'use strict';

  /* =============================================================
   *  SHIB Mine — Construct 3 Bridge  (server-sync, fixed)
   *
   *  ROOT BUG FIX:
   *    c3_runtimeInterface._iRuntime was WRONG.
   *    Correct path: c3_runtimeInterface._GetLocalRuntime()
   *    (game compiled with useWorker:false so runtime is on DOM thread)
   *
   *  Button intent detection:
   *    GoToLayoutByName("level1…") → Sprite14 → RETRY_REQUEST
   *    GoToLayout("main menu")     → rstrt    → GAME_OVER (claim modal)
   *
   *  Messages OUT → React Native:
   *    BRIDGE_READY
   *    GAME_OVER   { score, collected_tomatoes, intent:"claim"|"retry" }
   *    RETRY_REQUEST { layout }   (sprite14 clicked — show interstitial then reload)
   *    INJECT_DONE { state }
   *
   *  Messages IN ← React Native:
   *    INJECT_VARS { pbId, powerTokens, collectedTomatoes, lastSessionScore, totalScore }
   *    RESUME_NAVIGATION
   *    RELOAD_GAME
   * ============================================================= */

  // ── Step 1: Kill LocalStorage game keys — server is source of truth ──────
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

  // ── Runtime accessor (FIXED: use _GetLocalRuntime) ───────────────────────
  // C3 compiled with useWorker:false — runtime lives on DOM thread.
  // Path: window['c3_runtimeInterface']._GetLocalRuntime()
  function rt() {
    try {
      var ri = window['c3_runtimeInterface'];
      if (!ri) return null;
      // Primary: non-worker API (this game uses useWorker:false)
      if (typeof ri._GetLocalRuntime === 'function') {
        var lr = ri._GetLocalRuntime();
        if (lr) return lr;
      }
      // Fallbacks for other C3 versions
      if (ri._localRuntime) return ri._localRuntime;
      if (ri._iRuntime)     return ri._iRuntime;
      return null;
    } catch (e) { return null; }
  }

  // ── Layout name reader ────────────────────────────────────────────────────
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

  // ── Read a C3 global variable ─────────────────────────────────────────────
  function readGlobal(runtime, name) {
    try {
      var esm = runtime._eventSheetManager;
      if (!esm) return 0;
      // Map lookup
      if (esm._globalVarsByName && typeof esm._globalVarsByName.get === 'function') {
        var e = esm._globalVarsByName.get(name);
        if (e != null) return +(typeof e.GetValue === 'function' ? e.GetValue() : e._value) || 0;
      }
      // Object lookup
      if (esm._globalVarsByName && esm._globalVarsByName[name] != null) {
        var e2 = esm._globalVarsByName[name];
        return +(typeof e2.GetValue === 'function' ? e2.GetValue() : e2._value) || 0;
      }
      // Array scan — C3 stores variable name in _name or .name
      var vars = esm._globalVars || [];
      if (vars.values) vars = Array.from(vars.values());
      for (var i = 0; i < vars.length; i++) {
        var v = vars[i];
        if (v && (v._name === name || v.name === name))
          return +(typeof v.GetValue === 'function' ? v.GetValue() : v._value) || 0;
      }
    } catch (e) { console.warn('[Bridge] readGlobal error:', e); }
    return 0;
  }

  // ── Write a C3 global variable ────────────────────────────────────────────
  function writeGlobal(runtime, name, value) {
    try {
      var num = Number(value) || 0;
      var esm = runtime._eventSheetManager;
      if (!esm) { console.warn('[Bridge] No eventSheetManager'); return false; }

      var entry = null;
      if (esm._globalVarsByName && typeof esm._globalVarsByName.get === 'function')
        entry = esm._globalVarsByName.get(name);
      if (!entry && esm._globalVarsByName && esm._globalVarsByName[name])
        entry = esm._globalVarsByName[name];
      if (!entry) {
        var vars = esm._globalVars || [];
        if (vars.values) vars = Array.from(vars.values());
        for (var i = 0; i < vars.length; i++) {
          if (vars[i] && (vars[i]._name === name || vars[i].name === name))
            { entry = vars[i]; break; }
        }
      }
      if (!entry) { console.warn('[Bridge] Global var not found:', name); return false; }

      if (typeof entry.SetValue === 'function') entry.SetValue(num);
      else if (entry._value !== undefined)      entry._value = num;
      else { console.warn('[Bridge] Cannot set var:', name); return false; }

      console.log('[Bridge] writeGlobal', name, '=', num);
      return true;
    } catch (e) { console.warn('[Bridge] writeGlobal error:', e); return false; }
  }

  // ── postMessage OUT ───────────────────────────────────────────────────────
  function post(type, extra) {
    var json = JSON.stringify(Object.assign({ type: type }, extra || {}));
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(json);
    } else {
      window.parent.postMessage(json, '*');
    }
    console.log('[Bridge] >>>OUT', json);
  }

  // ── Hook C3 navigation — detect WHICH button was pressed ─────────────────
  //  GoToLayoutByName("level1")   → Sprite14 → RETRY intent
  //  GoToLayout("main menu")      → rstrt    → CLAIM intent (GAME_OVER already sent)
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
          // Sprite14 (retry): send explicit RETRY_REQUEST so RN can show interstitial
          if (intent === 'retry') {
            post('RETRY_REQUEST', { layout: String(dest) });
          }
          // rstrt (claim/exit): GAME_OVER was already sent when death layout entered
          return;
        }
        return orig.apply(lm, arguments);
      };
      console.log('[Bridge] Hooked', method);
    }

    // GoToLayoutByName → Sprite14 (retry button)
    makeHook('GoToLayoutByName', function (dest) {
      return 'retry'; // always retry intent — sprite14 calls GoToLayoutByName("level1")
    });
    // GoToLayout → rstrt (exit/claim button)
    makeHook('GoToLayout', function (dest) {
      return 'claim'; // always claim intent — rstrt calls GoToLayout("main menu")
    });
  }

  // ── Inject server data into C3 globals ───────────────────────────────────
  var injectQueue = null;

  function applyInject(runtime, vars) {
    var ok = 0;
    // hscore ← total_accumulated_score from server (all-time high score)
    var hsVal = vars.totalScore !== undefined ? vars.totalScore
              : vars.lastSessionScore !== undefined ? vars.lastSessionScore : 0;
    if (writeGlobal(runtime, 'hscore', hsVal)) ok++;

    // Store full state in window for bridge reference
    window.__shibGameState = {
      pbId:              vars.pbId              || '',
      powerTokens:       vars.powerTokens       || 0,
      collectedTomatoes: vars.collectedTomatoes || 0,   // NUMBER — from PocketBase
      lastSessionScore:  vars.lastSessionScore  || 0,
      totalScore:        vars.totalScore        || 0,
    };
    console.log('[Bridge] Injected state:', JSON.stringify(window.__shibGameState), '| C3 writes:', ok);
    post('INJECT_DONE', window.__shibGameState);
  }

  // ── Handle messages FROM React Native ────────────────────────────────────
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

  // ── Main polling loop ─────────────────────────────────────────────────────
  function tick() {
    var runtime = rt();
    if (!runtime) { setTimeout(tick, 300); return; }

    if (!bridgeReady) {
      bridgeReady = true;
      hookNavigation(runtime);
      if (injectQueue) { applyInject(runtime, injectQueue); injectQueue = null; }
      post('BRIDGE_READY', {});
      console.log('[Bridge] Ready — runtime obtained via _GetLocalRuntime()');
    }

    var name = layoutName(runtime);
    if (name !== lastLayout) {
      console.log('[Bridge] Layout: "' + lastLayout + '" → "' + name + '"');
      lastLayout = name;

      if (name.toLowerCase() === 'death') {
        // Read score from C3 global
        var score = readGlobal(runtime, 'score');

        // Compute new collected_tomatoes (server baseline + this session)
        var prevTomatoes = (window.__shibGameState &&
          typeof window.__shibGameState.collectedTomatoes === 'number')
          ? window.__shibGameState.collectedTomatoes : 0;
        var newTomatoes = prevTomatoes + score;
        if (window.__shibGameState) window.__shibGameState.collectedTomatoes = newTomatoes;

        console.log('[Bridge] DEATH — score=' + score +
          ' collected_tomatoes=' + newTomatoes + ' (prev=' + prevTomatoes + ')');

        navBlocked = true;  // block both rstrt and Sprite14 from navigating

        // Send GAME_OVER with all data as numbers — NOT strings
        post('GAME_OVER', {
          score:              score,         // integer
          collected_tomatoes: newTomatoes,   // integer — ready for PocketBase
          pb_id:              (window.__shibGameState && window.__shibGameState.pbId) || ''
        });

      } else if (navBlocked && name.toLowerCase() !== 'death') {
        navBlocked = false;
      }
    }

    setTimeout(tick, 300);
  }

  // Start polling after page loads (wait for C3 to initialise)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tick, 1500); });
  } else {
    setTimeout(tick, 1500);
  }

  window.__shibBridge = { post: post, writeGlobal: writeGlobal, readGlobal: readGlobal, rt: rt };
  console.log('[Bridge] Script loaded — waiting for C3 runtime (_GetLocalRuntime)…');
})();
