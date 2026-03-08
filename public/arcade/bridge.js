;(function () {
  'use strict';

  /* =========================================================
   *  SHIB Mine — Construct 3 Bridge
   *  Strategy: poll the C3 runtime every 300 ms.
   *  When the active layout name becomes "death" →
   *    1. read score global variable
   *    2. postMessage GAME_OVER to React Native (or parent iframe)
   *    3. block C3's layout navigation so RN controls what happens next
   * ========================================================= */

  var lastLayout   = '';
  var bridgeReady  = false;
  var navBlocked   = false;   // true while death screen is "owned" by RN
  var pendingNav   = null;    // { fn, args } — blocked GoToLayout call

  // ── 1. Get the C3 runtime ────────────────────────────────────────────────
  function getRuntime() {
    try {
      return window.c3_runtimeInterface && window.c3_runtimeInterface._iRuntime
        ? window.c3_runtimeInterface._iRuntime
        : null;
    } catch (e) { return null; }
  }

  // ── 2. Read the current layout name ─────────────────────────────────────
  function getLayoutName(rt) {
    try {
      var lm = rt._layoutManager;
      if (!lm) return '';
      var layout = typeof lm.GetMainRunningLayout === 'function'
        ? lm.GetMainRunningLayout()
        : null;
      if (!layout) return '';
      return typeof layout.GetName === 'function'
        ? layout.GetName()
        : (layout._name || layout.name || '');
    } catch (e) { return ''; }
  }

  // ── 3. Read a C3 global variable ─────────────────────────────────────────
  function readGlobal(rt, varName) {
    try {
      var esm = rt._eventSheetManager;
      if (!esm) return 0;

      // Try Map (modern C3)
      if (esm._globalVarsByName && typeof esm._globalVarsByName.get === 'function') {
        var entry = esm._globalVarsByName.get(varName);
        if (entry != null) {
          return +(typeof entry.GetValue === 'function' ? entry.GetValue() : entry._value) || 0;
        }
      }

      // Try plain object key
      if (esm._globalVarsByName && esm._globalVarsByName[varName] != null) {
        var e2 = esm._globalVarsByName[varName];
        return +(typeof e2.GetValue === 'function' ? e2.GetValue() : e2._value) || 0;
      }

      // Try array scan
      var vars = esm._globalVars || [];
      if (vars.values) vars = Array.from(vars.values());
      for (var i = 0; i < vars.length; i++) {
        var v = vars[i];
        if (v && (v._name === varName || v.name === varName)) {
          return +(typeof v.GetValue === 'function' ? v.GetValue() : v._value) || 0;
        }
      }
    } catch (e) { console.warn('[Bridge] readGlobal error:', e); }
    return 0;
  }

  // ── 4. postMessage to React Native / parent window ───────────────────────
  function post(type, extra) {
    var payload = Object.assign({ type: type }, extra || {});
    var json = JSON.stringify(payload);
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(json);
    } else {
      window.parent.postMessage(json, '*');
    }
    console.log('[Bridge] >>>OUT', json);
  }

  // ── 5. Block C3 navigation from death screen ─────────────────────────────
  //   We hook both GoToLayout and GoToLayoutByName on the layout manager.
  //   If the hook fails (API mismatch) we fall back to the simpler approach
  //   where RN just reloads the WebView instead of resuming.
  function hookNav(rt) {
    var lm = rt._layoutManager;
    if (!lm) { console.warn('[Bridge] No _layoutManager — nav blocking unavailable'); return; }

    function wrapMethod(obj, name) {
      if (typeof obj[name] !== 'function') return;
      var original = obj[name].bind(obj);
      obj[name] = function () {
        var args = arguments;
        if (navBlocked) {
          console.log('[Bridge] Nav BLOCKED (' + name + '):', Array.prototype.slice.call(args));
          pendingNav = { fn: original, args: Array.prototype.slice.call(args) };
          return;
        }
        return original.apply(obj, args);
      };
      console.log('[Bridge] Hooked', name);
    }

    wrapMethod(lm, 'GoToLayout');
    wrapMethod(lm, 'GoToLayoutByName');
  }

  // ── 6. Handle messages FROM React Native ─────────────────────────────────
  window.addEventListener('message', function (e) {
    var raw = e.data;
    if (!raw) return;
    var msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (err) { return; }
    console.log('[Bridge] <<<IN', JSON.stringify(msg));

    if (msg.type === 'RESUME_NAVIGATION' && pendingNav) {
      console.log('[Bridge] Resuming nav');
      navBlocked = false;
      var nav = pendingNav;
      pendingNav = null;
      nav.fn.apply(null, nav.args);
    }

    if (msg.type === 'RELOAD_GAME') {
      navBlocked = false;
      pendingNav = null;
      window.location.reload();
    }
  });

  // ── 7. Main polling loop ──────────────────────────────────────────────────
  function tick() {
    var rt = getRuntime();
    if (!rt) { setTimeout(tick, 500); return; }

    if (!bridgeReady) {
      bridgeReady = true;
      hookNav(rt);
      post('BRIDGE_READY', {});
      console.log('[Bridge] Ready — runtime found');
    }

    var layout = getLayoutName(rt);

    if (layout !== lastLayout) {
      console.log('[Bridge] Layout change: "' + lastLayout + '" → "' + layout + '"');
      lastLayout = layout;

      if (layout.toLowerCase() === 'death') {
        var score = readGlobal(rt, 'score');
        console.log('[Bridge] GAME OVER — score=' + score);
        navBlocked = true;   // block C3 buttons from navigating away
        post('GAME_OVER', { score: score });
      } else {
        // Left death screen (after RN allowed it) — unblock
        navBlocked = false;
      }
    }

    setTimeout(tick, 300);
  }

  // Start after DOM + C3 have had time to boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tick, 1000); });
  } else {
    setTimeout(tick, 1000);
  }

  window.__shibBridge = { post: post };
  console.log('[Bridge] Script loaded');
})();
