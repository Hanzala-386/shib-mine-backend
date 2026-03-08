(function () {
  'use strict';

  var lastLayout = '';
  var reportedThisRound = false;
  var bridgeReady = false;

  function getRuntime() {
    return (
      window.c3_runtimeInterface &&
      window.c3_runtimeInterface._iRuntime
    );
  }

  function getLayoutName(rt) {
    try {
      var lm = rt._layoutManager || rt;
      var layout =
        (lm.GetMainRunningLayout && lm.GetMainRunningLayout()) ||
        (rt.GetMainRunningLayout && rt.GetMainRunningLayout());
      if (!layout) return '';
      return (
        (layout.GetName && layout.GetName()) ||
        layout._name ||
        layout.name ||
        ''
      );
    } catch (e) {
      return '';
    }
  }

  function getGlobalVar(rt, varName) {
    try {
      var esm = rt._eventSheetManager;
      if (!esm) return 0;

      // Path 1: _globalVarsByName (Map)
      if (esm._globalVarsByName && esm._globalVarsByName.get) {
        var gv = esm._globalVarsByName.get(varName);
        if (gv !== undefined) {
          return (gv.GetValue && gv.GetValue()) != null
            ? gv.GetValue()
            : gv._value != null ? gv._value : gv;
        }
      }

      // Path 2: _globalVarsByName (plain object)
      if (esm._globalVarsByName && esm._globalVarsByName[varName] != null) {
        var gv2 = esm._globalVarsByName[varName];
        return (gv2.GetValue && gv2.GetValue()) != null
          ? gv2.GetValue()
          : gv2._value != null ? gv2._value : gv2;
      }

      // Path 3: _globalVars array
      if (esm._globalVars) {
        var arr = Array.isArray(esm._globalVars)
          ? esm._globalVars
          : (esm._globalVars.values ? Array.from(esm._globalVars.values()) : []);
        for (var i = 0; i < arr.length; i++) {
          var v = arr[i];
          if (v && (v._name === varName || v.name === varName)) {
            return (v.GetValue && v.GetValue()) != null
              ? v.GetValue()
              : v._value != null ? v._value : 0;
          }
        }
      }
    } catch (e) {
      console.warn('[Bridge] getGlobalVar error:', e);
    }
    return 0;
  }

  function postToRN(type, payload) {
    var msg = JSON.stringify(Object.assign({ type: type }, payload));
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(msg);
    } else if (window.parent !== window) {
      window.parent.postMessage(JSON.parse(msg), '*');
    }
    console.log('[Bridge] >', msg);
  }

  function onGameOver(rt) {
    if (reportedThisRound) return;
    reportedThisRound = true;
    setTimeout(function () {
      var score = getGlobalVar(rt, 'score');
      var hscore = getGlobalVar(rt, 'hscore');
      postToRN('GAME_OVER', { score: Number(score) || 0, hscore: Number(hscore) || 0 });
    }, 350);
  }

  function poll() {
    var rt = getRuntime();
    if (!rt) {
      setTimeout(poll, 400);
      return;
    }

    if (!bridgeReady) {
      bridgeReady = true;
      postToRN('BRIDGE_READY', {});
      console.log('[Bridge] Runtime detected');
    }

    var layout = getLayoutName(rt);

    if (layout !== lastLayout) {
      console.log('[Bridge] Layout:', layout);
      var lower = layout.toLowerCase();

      if (lower === 'death') {
        onGameOver(rt);
      } else if (lower.indexOf('level') === 0 || lower === 'main menu' || lower === 'main') {
        reportedThisRound = false;
      }

      lastLayout = layout;
    }

    setTimeout(poll, 300);
  }

  // Listen for messages from React Native (mute/unmute, etc.)
  window.addEventListener('message', function (e) {
    try {
      var data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (!data || !data.type) return;

      var rt = getRuntime();

      if (data.type === 'SET_MUTE') {
        // Try to mute/unmute C3 Audio plugin
        if (rt) {
          try {
            var audio = rt._objectClassMap && rt._objectClassMap.get
              ? rt._objectClassMap.get('Audio')
              : null;
            if (!audio) {
              // fallback: find by iterating object classes
              if (rt._objectClasses) {
                var classes = Array.isArray(rt._objectClasses)
                  ? rt._objectClasses
                  : Array.from(rt._objectClasses.values ? rt._objectClasses.values() : []);
                audio = classes.find(function (c) { return c.GetName && c.GetName() === 'Audio'; });
              }
            }
            if (audio && audio._plugin && audio._plugin.SetMasterVolume) {
              audio._plugin.SetMasterVolume(data.muted ? -100 : 0);
            }
          } catch (err) {
            console.warn('[Bridge] mute error:', err);
          }
        }
      }
    } catch (err) { /* ignore */ }
  });

  // Start polling
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(poll, 800); });
  } else {
    setTimeout(poll, 800);
  }

  window.__c3Bridge = { postToRN: postToRN };
})();
