/**
 * arcade-sdk.js — Universal drop-in bridge between a plain HTML5/Canvas game
 * and the React Native "Arcade PvP" host (WebView) OR the web-preview host (iframe).
 *
 * The game only ever calls these methods and never touches the network:
 *   window.Arcade.onScore(n)      // on every authoritative score change
 *   window.Arcade.onPlayerOut(n)  // once, when the player is fully out
 *   window.Arcade.onFreeze(cb)    // register a handler the host calls to end the game
 *   window.Arcade.isMatch()       // true only inside a live PvP match
 *   window.Arcade.maxLives(def)   // effective max lives (PvP = server value, else def)
 *
 * Transport (game → host): ALWAYS delivered, whichever host is present —
 *   • Native  : window.ReactNativeWebView.postMessage(json)   (react-native-webview)
 *   • Web     : window.parent.postMessage(json, '*')          (iframe → RN web host)
 * The host holds the authenticated match token and relays scores to the
 * authoritative socket server. The game never sees the token and never writes DB.
 *
 * Transport (host → game): the host delivers ARCADE_MATCH_START / ARCADE_FREEZE /
 * ARCADE_END via ANY of:
 *   • window.__arcadeHostMessage(json)   (native injectJavaScript — primary)
 *   • window 'message' event             (web iframe postMessage)
 *   • document 'message' event           (older react-native-webview quirk)
 *
 * Offline / practice / plain-browser: when the host never sends
 * ARCADE_MATCH_START, `inMatch` stays false and onScore/onPlayerOut are no-ops
 * → ZERO database writes and ZERO token awards, exactly as required.
 */
(function () {
  'use strict';

  var inMatch = false;   // true only after the host confirms a live PvP match
  var freezeCb = null;
  var lastScore = -1;
  var matchLives = 1;    // server-defined lives for the live PvP match (sudden death = 1)

  // Instant, handshake-independent match detection. The RN host loads the game
  // with "?arcade=1" for a live PvP match (practice / plain browser omit it), so
  // the game KNOWS it is a match at page load. This makes the 1-life HUD, the
  // no-local-replay guard, and score posting NO LONGER depend on the
  // ARCADE_MATCH_START postMessage — which a cross-origin iframe or a stale/cached
  // build can silently drop (the exact failure that left the header stuck at 0,
  // showed 3 hearts, and popped the local "Play Again" on death).
  try {
    var _p = new URLSearchParams((typeof location !== 'undefined' && location.search) || '');
    if (_p.get('arcade') === '1') { inMatch = true; }
  } catch (e) { /* noop — falls back to the postMessage handshake */ }

  // Resolve the transport at CALL TIME (not load time) so a late-injected
  // ReactNativeWebView is always picked up, and so the same build works whether
  // it runs inside a native WebView or a web iframe.
  function postRN(msg) {
    var payload;
    try { payload = JSON.stringify(msg); } catch (e) { return; }

    // 1) Native react-native-webview.
    try {
      var rn = (typeof window !== 'undefined') && window.ReactNativeWebView;
      if (rn && typeof rn.postMessage === 'function') {
        rn.postMessage(payload);
        return;
      }
    } catch (e) { /* fall through to web */ }

    // 2) Web iframe → parent (RN web host listens on window 'message').
    try {
      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
    } catch (e) { /* noop */ }
  }

  // Messages coming FROM the host.
  function handleHostMessage(raw) {
    var data;
    try { data = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (!data || !data.type) return;
    switch (data.type) {
      case 'ARCADE_MATCH_START':
        inMatch = true;
        lastScore = -1;
        // PvP lives come from the authoritative server (default sudden-death 1).
        matchLives = (Number(data.lives) > 0) ? Number(data.lives) : 1;
        // Tell the game to re-sync its visible lives/HUD to the match value:
        // resetGame() already ran at page load with the OFFLINE default (3), so
        // without this the hearts HUD would keep showing 3 until the first hit.
        try {
          window.dispatchEvent(new CustomEvent('arcade:matchstart', { detail: { lives: matchLives } }));
        } catch (e) { /* noop */ }
        break;
      case 'ARCADE_FREEZE':
        if (typeof freezeCb === 'function') { try { freezeCb(); } catch (e) { /* noop */ } }
        break;
      case 'ARCADE_END':
        // Freeze a still-alive game at settlement (forfeit/timeout) BEFORE clearing
        // inMatch — so the game's freeze handler still sees isMatch()===true and
        // suppresses the local Game Over / "Play Again" overlay. The RN host shows
        // the authoritative match result.
        if (typeof freezeCb === 'function') { try { freezeCb(); } catch (e) { /* noop */ } }
        inMatch = false;
        break;
    }
  }

  // Robust host→game channel (all three delivery paths).
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
    // Effective max lives: PvP uses the server value (sudden-death 1); offline
    // uses the game's own default so practice mode stays 3 lives.
    maxLives: function (offlineDefault) {
      return inMatch ? matchLives : (Number(offlineDefault) > 0 ? Number(offlineDefault) : matchLives);
    },
  };

  // Announce load so the host knows the WebView/iframe is ready to receive a match.
  postRN({ type: 'ARCADE_READY' });
})();
