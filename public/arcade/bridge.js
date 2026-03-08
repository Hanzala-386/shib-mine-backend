(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  var currentLayout  = '';
  var bridgeReady    = false;
  var navHooked      = false;
  var pendingNav     = null; // { lm, method, arg } — blocked C3 navigation

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getRuntime() {
    return window.c3_runtimeInterface && window.c3_runtimeInterface._iRuntime;
  }

  function getLayoutName(rt) {
    try {
      var lm = rt._layoutManager;
      var layout = lm && (lm.GetMainRunningLayout ? lm.GetMainRunningLayout() : null)
                || (rt.GetMainRunningLayout ? rt.GetMainRunningLayout() : null);
      return layout ? (layout.GetName ? layout.GetName() : layout._name || '') : '';
    } catch (e) { return ''; }
  }

  function getGlobalVar(rt, name) {
    try {
      var esm = rt._eventSheetManager;
      if (!esm) return 0;
      // Path 1: Map
      if (esm._globalVarsByName && esm._globalVarsByName.get) {
        var g = esm._globalVarsByName.get(name);
        if (g != null) return +(g.GetValue ? g.GetValue() : g._value) || 0;
      }
      // Path 2: plain object
      if (esm._globalVarsByName && esm._globalVarsByName[name] != null) {
        var g2 = esm._globalVarsByName[name];
        return +(g2.GetValue ? g2.GetValue() : g2._value) || 0;
      }
      // Path 3: array
      if (esm._globalVars) {
        var arr = Array.isArray(esm._globalVars)
          ? esm._globalVars
          : (esm._globalVars.values ? Array.from(esm._globalVars.values()) : []);
        for (var i = 0; i < arr.length; i++) {
          var v = arr[i];
          if (v && (v._name === name || v.name === name))
            return +(v.GetValue ? v.GetValue() : v._value) || 0;
        }
      }
    } catch (e) { console.warn('[Bridge] getGlobalVar:', e); }
    return 0;
  }

  function postToRN(type, payload) {
    var msg = JSON.stringify(Object.assign({ type: type }, payload || {}));
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(msg);
    } else if (window.parent !== window) {
      window.parent.postMessage(JSON.parse(msg), '*');
    }
    console.log('[Bridge] >', msg);
  }

  // ── Hook C3 layout navigation ─────────────────────────────────────────────
  // Intercepts GoToLayout / GoToLayoutByName calls that originate from the
  // "death" layout so React Native can show ads / collect modal first.
  function hookNavigation(rt) {
    if (navHooked) return;
    navHooked = true;

    var lm = rt._layoutManager;
    if (!lm) { console.warn('[Bridge] No _layoutManager'); return; }

    // ── GoToLayout (used by rstrt → "main menu" = the BACK/EXIT button) ────
    if (typeof lm.GoToLayout === 'function') {
      var origGoTo = lm.GoToLayout.bind(lm);
      lm.GoToLayout = function (layoutRef) {
        var cur = getLayoutName(rt).toLowerCase();
        if (cur === 'death') {
          var score = getGlobalVar(rt, 'score');
          // rstrt navigates to "main menu" → EXIT action
          pendingNav = { lm: lm, method: 'GoToLayout', arg: layoutRef, orig: origGoTo };
          postToRN('EXIT_GAME', { score: score });
          return; // block C3 navigation until RESUME received
        }
        return origGoTo.call(lm, layoutRef);
      };
      console.log('[Bridge] Hooked GoToLayout');
    }

    // ── GoToLayoutByName (used by Sprite14 → "level"+N = RETRY button) ─────
    if (typeof lm.GoToLayoutByName === 'function') {
      var origGoToN = lm.GoToLayoutByName.bind(lm);
      lm.GoToLayoutByName = function (name) {
        var cur = getLayoutName(rt).toLowerCase();
        if (cur === 'death') {
          var score = getGlobalVar(rt, 'score');
          // Sprite14 navigates to level → RETRY action (no tokens)
          pendingNav = { lm: lm, method: 'GoToLayoutByName', arg: name, orig: origGoToN };
          postToRN('RETRY_GAME', { score: score });
          return; // block until RESUME
        }
        return origGoToN.call(lm, name);
      };
      console.log('[Bridge] Hooked GoToLayoutByName');
    }
  }

  // ── Handle messages FROM React Native ─────────────────────────────────────
  window.addEventListener('message', function (e) {
    try {
      var data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (!data || !data.type) return;

      var rt = getRuntime();

      // ── Resume blocked C3 navigation (after ad shown) ──────────────────
      if (data.type === 'RESUME_NAVIGATION') {
        if (pendingNav) {
          var nav = pendingNav;
          pendingNav = null;
          try { nav.orig.call(nav.lm, nav.arg); }
          catch (err) { console.warn('[Bridge] resume error:', err); }
        }
      }

      // ── Mute / unmute game audio ────────────────────────────────────────
      if (data.type === 'SET_MUTE' && rt) {
        try {
          var classes = rt._objectClasses
            ? (Array.isArray(rt._objectClasses)
               ? rt._objectClasses
               : Array.from(rt._objectClasses.values ? rt._objectClasses.values() : []))
            : [];
          var audio = classes.find(function (c) { return c.GetName && c.GetName() === 'Audio'; });
          if (audio && audio._plugin && audio._plugin.SetMasterVolume) {
            audio._plugin.SetMasterVolume(data.muted ? -100 : 0);
          }
        } catch (err) { console.warn('[Bridge] mute error:', err); }
      }
    } catch (err) { /* ignore */ }
  });

  // ── Polling loop ──────────────────────────────────────────────────────────
  function poll() {
    var rt = getRuntime();
    if (!rt) { setTimeout(poll, 400); return; }

    if (!bridgeReady) {
      bridgeReady = true;
      hookNavigation(rt);
      postToRN('BRIDGE_READY', {});
      console.log('[Bridge] Ready');
    }

    var layout = getLayoutName(rt);
    if (layout !== currentLayout) {
      console.log('[Bridge] Layout:', layout);
      currentLayout = layout;
    }

    setTimeout(poll, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(poll, 800); });
  } else {
    setTimeout(poll, 800);
  }

  window.__c3Bridge = { postToRN: postToRN };
})();
