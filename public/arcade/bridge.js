r(rt(), 'back_button');
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
