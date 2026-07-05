/**
 * arcade-sdk.js — Universal drop-in bridge between a plain HTML5/Canvas game
 * and the React Native "Arcade PvP" host (WebView).
 *
 * The game only ever calls three methods and never touches the network:
 *   window.Arcade.onScore(n)      // on every authoritative score change
 *   window.Arcade.onPlayerOut(n)  // once, when the player is fully out
 *   window.Arcade.onFreeze(cb)    // register a handler the host calls to end the game
 *
 * Transport: this SDK talks ONLY to the RN host via postMessage. The RN app
 * holds the authenticated match token and relays scores to the authoritative
 * socket server. The game never sees the token and never writes to PocketBase.
 *
 * Offline / practice / plain-browser: when the host never sends
 * ARCADE_MATCH_START, `inMatch` stays false and onScore/onPlayerOut are no-ops
 * → ZERO database writes and ZERO token awards, exactly as required.
 */
(function () {
  'use strict';

  var RN = (typeof window !== 'undefined') && window.ReactNativeWebView;
  var inMatch = false;   // true only after the RN host confirms a live PvP match
  var freezeCb = null;
  var lastScore = -1;

  function postRN(msg) {
    if (RN && RN.postMessage) {
      try { RN.postMessage(JSON.stringify(msg)); } catch (e) { /* noop */ }
    }
  }

  // Messages coming FROM the RN host (injected via injectJavaScript).
  function handleHostMessage(raw) {
    var data;
    try { data = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (!data || !data.type) return;
    switch (data.type) {
      case 'ARCADE_MATCH_START':
        inMatch = true;
        lastScore = -1;
        break;
      case 'ARCADE_FREEZE':
        if (typeof freezeCb === 'function') { try { freezeCb(); } catch (e) { /* noop */ } }
        break;
      case 'ARCADE_END':
        inMatch = false;
        break;
    }
  }

  // Robust host→game channel: RN can either call window.__arcadeHostMessage(json)
  // directly, or dispatch a window/document 'message' event.
  window.__arcadeHostMessage = handleHostMessage;
  window.addEventListener('message', function (e) { handleHostMessage(e.data); });
  document.addEventListener('message', function (e) { handleHostMessage(e.data); });

  window.Arcade = {
    ready: function () { postRN({ type: 'ARCADE_READY' }); },
    onScore: function (score) {
      if (!inMatch) return;                 // offline / practice → no DB writes
      var s = Number(score) || 0;
      if (s === lastScore) return;          // only emit genuine changes
      lastScore = s;
      postRN({ type: 'ARCADE_SCORE', score: s });
    },
    onPlayerOut: function (score) {
      if (!inMatch) return;                 // offline / practice → no DB writes
      postRN({ type: 'ARCADE_OUT', score: Number(score) || 0 });
    },
    onFreeze: function (cb) { freezeCb = cb; },
    isMatch: function () { return inMatch; },
  };

  // Announce load so the host knows the WebView is ready to receive a match.
  postRN({ type: 'ARCADE_READY' });
})();
