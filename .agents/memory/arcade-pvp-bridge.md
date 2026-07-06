---
name: Arcade PvP game ↔ React Native bridge (Flappy Bounce, Fruit Cut)
description: How HTML5 arcade games talk to the RN WebView host for real-money PvP, and the non-obvious gotchas (external hosting, lives-HUD re-sync, no local replay in-match, AFK margin rule).
---

# Arcade PvP game ↔ RN bridge

The arcade PvP games (Flappy Bounce, Fruit Cut) are plain HTML5/canvas games embedded in
the RN app via a WebView (native) / iframe (web). RN side is `app/hub/arcade-match.tsx`
(per-game GAME_HOSTS map); game side is `arcade-sdk.js` (the drop-in bridge, byte-identical
across games) + the game's own JS. The server relays scores over a socket and is
authoritative for the result. Adding a game = register spec in `shared/arcade.ts` (BOTH
backend copies), add GAME_HOSTS + lobby GAME_META entries, inject the SDK adapter into the
game's start/score/death/exit hooks.

## CRITICAL: the live game is NOT served from this repo
- The game runs from shared hosting: `GAME_URL = https://webcod.in/flappy/index.html`.
- Editing `public/flappy/**` in this repo has **zero effect on the live app** until the
  user manually re-uploads the changed files to `webcod.in/flappy/`. The repo copy is the
  source of truth to hand the user; it is not auto-deployed anywhere.
- **Why:** symptoms that look like "my code fix didn't work" are usually just a stale
  hosted copy. Always re-upload BOTH `arcade-sdk.js` and `assets/script.js` and re-test.

## Bridge protocol
- game → host: `ARCADE_READY`, `ARCADE_SCORE{score}`, `ARCADE_OUT{score}`.
- host → game: `ARCADE_MATCH_START{lives}`, `ARCADE_FREEZE`, `ARCADE_END`.
- RN re-sends `ARCADE_MATCH_START` ~12×/500ms until the game acks (first score/out),
  because `onLoadEnd` can fire before `window.__arcadeHostMessage` exists.

## Match detection must NOT depend solely on the postMessage handshake
- On the WEB path the game is a **cross-origin** iframe (Expo web on riker.replit.dev →
  webcod.in). `ARCADE_MATCH_START` can fail to land there (stale cached JS, timing), and
  when it does ALL three symptoms appear together: live score stuck at 0-0, 3 hearts
  instead of 1, and the local Game Over/Play Again modal on death.
- **Fix pattern:** RN loads online matches as `GAME_URL?v=N&arcade=1`; the SDK reads
  `location.search` on load and sets `inMatch=true` immediately when `arcade=1`. The
  postMessage handshake still runs as a refinement. This makes 1-life HUD, no-local-replay,
  and score posting independent of the handshake landing. **Why:** cross-origin iframes are
  the fragile link; a URL flag is delivered atomically with the page load.
- `?v=N` on BOTH the iframe/WebView URL and the game's `<script src>` tags busts
  shared-hosting caches. Bump N whenever you re-upload; otherwise the old JS is served.

## Practice-mid-flow must REMOUNT the game (goPractice gotcha)
- Once online mode loads the game with `?arcade=1`, switching to practice (goPractice from
  the search/error screens) must **remount** the iframe/WebView WITHOUT `arcade=1`, or the
  user gets a stranded 1-life session stuck on the waiting overlay (no Play Again while
  `isMatch()`). Derive `gameSrc` from a runtime practice flag (`mode==='practice'`) and bump
  `wvKey` (used as React `key` on BOTH the web iframe and native WebView) in goPractice so
  it reloads clean. **Why:** a src derived only from the immutable mount param never reloads.

## Transport must be dual-path (both directions)
- game → host: try `window.ReactNativeWebView.postMessage` (native) **resolved at call
  time**, else `window.parent.postMessage(json,'*')` (web iframe). Capturing
  `ReactNativeWebView` once at load is fragile.
- host → game: RN delivers via `window.__arcadeHostMessage(json)` (native
  injectJavaScript) OR `iframe.contentWindow.postMessage` → game listens on
  `window.__arcadeHostMessage` + `window`/`document` 'message' events.

## In-match invariants the GAME must enforce (else money bugs)
- `inMatch` (set by `ARCADE_MATCH_START`) gates every score/out emit → offline/practice
  writes nothing.
- Sudden death = 1 life in PvP; practice keeps its own default (3). `handleHit` checks
  `Arcade.isMatch()` live, so death logic is correct even if the HUD is wrong.
- **Lives-HUD gotcha:** `resetGame()` runs once at page load, BEFORE `ARCADE_MATCH_START`,
  so it sets the offline default (3 hearts) and nothing re-syncs it. The SDK dispatches a
  `arcade:matchstart` CustomEvent on match start; the game listens and re-sets
  `lives = Arcade.maxLives(...)` + `updateLivesDisplay()`. Without this the hearts HUD
  lies (shows 3) even though sudden death is enforced.
- **No local Game Over / replay in a match:** `setGameOver()` must early-return (skip the
  overlay) when `isMatch()`, and `doRestart()` must be a no-op when `isMatch()`. The RN
  host renders the authoritative result.
- On `ARCADE_END` the SDK calls the freeze callback BEFORE clearing `inMatch`, so a
  still-alive game (forfeit/timeout settlement) freezes without popping the local overlay.

## AFK margin rule (client timer MUST be well under the server backstop)
- The server (arcadehub) arms a per-seat TAP-TO-START AFK backstop (`spec.readyAfkSeconds`)
  and clears it only on the first relayed SCORE/OUT — `ARCADE_STARTED` is engagement-only
  and never reaches the server's AFK timer.
- **Why:** a player who taps at the last client second still needs several seconds to land
  a first score (spawn delay + action + report throttle). If client afkMs ≈ server window,
  an engaged player gets server-forfeited at 0 mid-play. Keep a wide gap like Flappy
  (client 30s < server 45s; Fruit Cut client 40s < server 47s).
- Games with menu screens (CTL templates like Fruit Cut) skip the menu in-match
  (preloader → gotoGame) and treat their help/tutorial panel tap as TAP-TO-START →
  `Arcade.onStart()`.
- Score reporting for burst-scoring games: throttle cumulative-score reports to >
  the server's `scoreDelta.minIntervalMs` (e.g. 600ms vs 500ms) so every report lands in a
  fresh server window; size `maxIncrement` off honest peak rate per report, not per event.
