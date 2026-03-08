;(function () {
  'use strict';

  /* =========================================================
   *  SHIB Mine — Construct 3 Bridge  (server-sync version)
   *
   *  Capabilities:
   *  • Poll layout name → send GAME_OVER {score} on "death"
   *  • Accept INJECT_VARS {powerTokens, collectedTomatoes}
   *    from React Native → write values into C3 global vars
   *  • Block C3 layout navigation while RN controls the flow
   *  • Accept RESUME_NAVIGATION / RELOAD_GAME from RN
   * ========================================================= */

  var lastLayout   = '';
  var bridgeReady  = false;
  var navBlocked   = false;
  var pendingNav   = null;   // { fn, args }

  // ── Runtime accessor ─────────────────────────────────────────────────────
  function rt() {
    try { return window.c3_runtimeInterface && window.c3_runtimeInterface._iRuntime; }
    catch (e) { return null; }
  }

  // ── Read active layout name ───────────────────────────────────────────────
  function layoutName(runtime) {
    try {
      var lm = runtime._layoutManager;
      if (!lm) return '';
      var l = typeof lm.GetMainRunningLayout === 'function' ? lm.GetMainRunningLayout() : null;
      if (!l) return '';
      return typeof l.GetName === 'function' ? l.GetName() : (l._name || l.name || '');
    } catch (e) { return ''; }
  }

  // ── Read a C3 global variable → number ───────────────────────────────────
  function readGlobal(runtime, name) {
    try {
      var esm = runtime._eventSheetManager;
      if (!esm) return 0;
      // Map (modern C3)
      if (esm._globalVarsByName && typeof esm._globalVarsByName.get === 'function') {
        var e = esm._globalVarsByName.get(name);
        if (e != null) return +(typeof e.GetValue === 'function' ? e.GetValue() : e._value) || 0;
      }
      // Plain object
      if (esm._globalVarsByName && esm._globalVarsByName[name] != null) {
        var e2 = esm._globalVarsByName[name];
        return +(typeof e2.GetValue === 'function' ? e2.GetValue() : e2._value) || 0;
      }
      // Array scan
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
      // Map
      if (esm._globalVarsByName && typeof esm._globalVarsByName.get === 'function') {
        entry = esm._globalVarsByName.get(name);
      }
      // Plain object
      if (!entry && esm._globalVarsByName && esm._globalVarsByName[name] != null) {
        entry = esm._globalVarsByName[name];
      }
      // Array scan
      if (!entry) {
        var vars = esm._globalVars || [];
        if (vars.values) vars = Array.from(vars.values());
        for (var i = 0; i < vars.length; i++) {
          if (vars[i] && (vars[i]._name === name || vars[i].name === name)) {
            entry = vars[i]; break;
          }
        }
      }

      if (!entry) { console.warn('[Bridge] Global var not found:', name); return false; }

      if (typeof entry.SetValue === 'function') { entry.SetValue(num); }
      else if (entry._value !== undefined)       { entry._value = num;  }
      else { console.warn('[Bridge] Cannot set var:', name); return false; }

      console.log('[Bridge] writeGlobal', name, '=', num);
      return true;
    } catch (e) { console.warn('[Bridge] writeGlobal error:', e); return false; }
  }

  // ── postMessage to React Native or parent iframe ──────────────────────────
  function post(type, extra) {
    var json = JSON.stringify(Object.assign({ type: type }, extra || {}));
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(json);
    } else {
      window.parent.postMessage(json, '*');
    }
    console.log('[Bridge] >>>OUT', json);
  }

  // ── Block C3 layout navigation while RN owns the flow ────────────────────
  function hookNavigation(runtime) {
    var lm = runtime._layoutManager;
    if (!lm) { console.warn('[Bridge] No _layoutManager — nav blocking unavailable'); return; }

    function wrap(obj, method) {
      if (typeof obj[method] !== 'function') return;
      var orig = obj[method].bind(obj);
      obj[method] = function () {
        if (navBlocked) {
          console.log('[Bridge] Nav BLOCKED (' + method + ')');
          pendingNav = { fn: orig, args: Array.prototype.slice.call(arguments) };
          return;
        }
        return orig.apply(obj, arguments);
      };
      console.log('[Bridge] Hooked', method);
    }
    wrap(lm, 'GoToLayout');
    wrap(lm, 'GoToLayoutByName');
  }

  // ── Inject initial game state into C3 global variables ───────────────────
  var injectQueue = null;  // held until runtime is available

  function applyInject(runtime, vars) {
    var ok = 0;
    // score  → we don't overwrite — C3 owns this
    // hscore → we can set to the user's best (last_session_score or total)
    if (vars.lastSessionScore !== undefined) {
      if (writeGlobal(runtime, 'hscore', vars.lastSessionScore)) ok++;
    }
    // No "tomato" or "powerTokens" global exists in this C3 project,
    // so we store them in JS window vars for reference by bridge/RN only.
    window.__shibGameState = {
      powerTokens:       vars.powerTokens       || 0,
      collectedTomatoes: vars.collectedTomatoes || 0,
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

    // ── Inject C3 globals from server data ─────────────────────────────
    if (msg.type === 'INJECT_VARS') {
      if (runtime) { applyInject(runtime, msg); }
      else          { injectQueue = msg; /* will run on first tick */ }
    }

    // ── Resume blocked C3 navigation ───────────────────────────────────
    if (msg.type === 'RESUME_NAVIGATION' && pendingNav) {
      navBlocked = false;
      var nav = pendingNav; pendingNav = null;
      nav.fn.apply(null, nav.args);
    }

    // ── Hard-reload the game ────────────────────────────────────────────
    if (msg.type === 'RELOAD_GAME') {
      navBlocked = false; pendingNav = null;
      window.location.reload();
    }
  });

  // ── Main polling loop ─────────────────────────────────────────────────────
  function tick() {
    var runtime = rt();
    if (!runtime) { setTimeout(tick, 500); return; }

    if (!bridgeReady) {
      bridgeReady = true;
      hookNavigation(runtime);
      // Apply any queued injection that arrived before runtime was ready
      if (injectQueue) { applyInject(runtime, injectQueue); injectQueue = null; }
      post('BRIDGE_READY', {});
      console.log('[Bridge] Ready');
    }

    var name = layoutName(runtime);
    if (name !== lastLayout) {
      console.log('[Bridge] Layout:', '"' + lastLayout + '" → "' + name + '"');
      lastLayout = name;

      if (name.toLowerCase() === 'death') {
        var score = readGlobal(runtime, 'score');
        console.log('[Bridge] GAME OVER — score=' + score);
        navBlocked = true;   // block in-game Retry/Back from auto-navigating
        post('GAME_OVER', { score: score });
      } else if (navBlocked && name.toLowerCase() !== 'death') {
        navBlocked = false;   // left death screen normally
      }
    }

    setTimeout(tick, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tick, 1000); });
  } else {
    setTimeout(tick, 1000);
  }

  window.__shibBridge = { post: post, writeGlobal: writeGlobal, readGlobal: readGlobal };
  console.log('[Bridge] Script loaded');
})();
