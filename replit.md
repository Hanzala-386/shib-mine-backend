# Shiba Hit - Crypto Mining App

## Overview
A gold & neon orange glassmorphism React Native mobile app for mining SHIB cryptocurrency. Users earn SHIB tokens through 60-minute mining sessions and Power Tokens through a Knife Hit mini-game. Built with Firebase Auth + PocketBase backend and Expo Router.

## Architecture
- **Frontend**: Expo Router (file-based routing), React Native
- **Backend**: Express.js on port 5000 (server/routes.ts) + PocketBase at https://api.webcod.in
- **Auth**: Firebase Authentication (Email/Password) + Firebase native email verification link (free, zero cost)
- **State**: React Context (Auth, Wallet, Mining, Admin)

## Key Features
1. **Firebase Email Verification** — Signup → `sendEmailVerification()` → verify-email screen (no OTP inputs, just "check inbox" UI); Sign-in checks `firebaseUser.emailVerified`; `POST /api/app/auth/confirm-verified` syncs verified status to PB
2. **Verify Email Screen** — "Check inbox" screen: tap to check status (polls Firebase), resend button with 60s cooldown, sign out link
3. **Mining** — 60-minute timer, server-persisted start/claim with booster_multiplier stored in session; 24 PT entry fee
4. **Speed Boosters** — 2x/4x/6x/10x, time-limited 1 hour, single active at a time, countdown timer on active card; decoupled from mining start
5. **Server-Side Claim Verification** — Server computes expected reward from rate × 3600 × booster_multiplier; client reward validated within 5% tolerance
6. **Rolling Counter** — Smooth animated SHIB balance display during mining
7. **Knife Hit Game — Server-Authoritative WebSocket Scoring** — Vanilla JS knife-throw game at `public/game/Knife hit Template/index.html`, served from the Express server at `/game/index.html`. Anti-cheat architecture:
   - **Per-hit WebSocket signals**: On each valid knife hit, game sends `KNIFE_HIT` to `wss://[server]/api/ws/game`
   - **Server counts hits**: 5 PT per validated hit, 2000 PT cap, 3-minute hard timer — all enforced server-side
   - **Anti-cheat checks**: min 300ms between hits (knife physics minimum), burst detection (max 15 hits per 5-second window)
   - **Session flow**: game sends `BRIDGE_READY` → RN sends `INJECT_VARS {pbId, apiUrl}` → game connects WebSocket → `GAME_START` → `SESSION_READY {sessionId}` → per-hit `HIT_ACK {serverPT}` → `GAME_OVER` → `COMMITTED {finalPT}`
   - **Commit strategy**: on game over, server stores `last_session_score = serverPT` in PocketBase; existing claim/double flow reads this
   - **Reward validation**: `/api/app/game/reward` validates `amount ≤ last_session_score × 2` (×2 for ad double reward)
   - **Game URL**: dynamically built from `getApiUrl()` so WebSocket always points to the correct Railway host
   - **Static serving**: `/game` and `/arcade` served before Metro proxy in dev; Metro pathFilter excludes them
   - **WebSocket setup**: `WebSocketServer({noServer:true})` + `server.on('upgrade')` handler for `/api/ws/game`; Metro proxy pathFilter starts with `/api` so it doesn't intercept WS upgrades for this path
8. **Professional Ad Integration** — `react-native-google-mobile-ads` SDK (requires custom EAS build for real ads; simulates gracefully in Expo Go). Architecture:
   - `context/AdContext.tsx`: SDK init + fetches all unit IDs from PocketBase settings; exposes `showInterstitial()` / `showRewarded()` with loading state
   - `components/StickyBannerAd.tsx`: Persistent banner above tab bar, 30s auto-refresh via key remount
   - `lib/nativeAds.ts`: SDK wrapper with `createForAdRequest` → LOADED → show → CLOSED/EARNED_REWARD callbacks; graceful fallback to simulation when native module not available
   - `metro.config.js`: Web stub for `react-native-google-mobile-ads` + @iabtcf ESM `.js` extension resolver fix
   - PocketBase settings fields: `admob_unit_id` (interstitial), `admob_banner_unit_id`, `admob_rewarded_id`, `unity_game_id`, `unity_rewarded_id`, `applovin_sdk_key`, `applovin_rewarded_id`
   - Mediation waterfall: AdMob primary → Unity Ads → AppLovin MAX (configured via AdMob dashboard mediation groups)
   - app.json plugin: `react-native-google-mobile-ads` with test App IDs (update to production IDs before release)
   - **Direct Unity Ads fallback (ANDROID-ONLY)** — independent of AdMob mediation; remote `force_unity_only` bool toggle in PB `settings` (default false), surfaced as `forceUnityOnly` (settings mapper both servers + `lib/api.ts` AppSettings + `AdContext`/`AdminContext` + `admin.tsx` toggle):
     - **Phase A** (`force_unity_only=true`): Unity-only, AdMob fully bypassed.
     - **Phase B** (default false): AdMob first; if it can't PRESENT within `ADMOB_RACE_MS` (3s) or errors, instant Unity fallback; both networks preloaded. Race hinges on AdMob LOADED/present (NOT completion) so a normal AdMob ad watched >3s never triggers a second Unity ad.
     - iOS always AdMob (`isUnityAvailable()=false` off Android/native); on web/iOS/Expo Go all Unity helpers no-op so default-false behavior is unchanged.
     - Race-guard invariants in `_routeInterstitial`/`_routeRewarded`: `goUnity()` is idempotent (`fallbackStarted` + `adMobPresented` guards) so a late AdMob `ERROR` after the timeout can never start a 2nd Unity show; once AdMob has presented, a late error settles instead of falling back. Rewarded resolves true only on Unity COMPLETED.
     - `lib/unityAds.ts`: JS wrapper (Game ID `6061517`; placements `Shib_Interstitial_Android`/`Shib_Rewarded_Android`/`Shib_Banner_Android`; `UNITY_TEST_MODE=false`); `modules/unity-ads/` local Expo module (Kotlin, `unity-ads:4.13.0`, `requireOptionalNativeModule` → no-op off-device).
     - Banner (`components/StickyBannerAd.tsx`): Phase A → Unity banner; else AdMob banner that swaps to Unity on `onAdFailedToLoad`.
     - **APK-only verification**: native Unity SDK + Kotlin module + banner native view are UNTESTABLE in the Replit sandbox — only the JS Metro bundle is verifiable here (confirmed clean android+web). Verify real Unity behavior in an EAS build.
8. **Admin Panel** — Restricted to hanzala386@gmail.com, controls all economic settings
9. **Wallet** — SHIB balance & Power Token tracking (BEP-20 + Binance Email withdrawal)
10. **Invite** — Referral code sharing, 10% commission via deferred referral_earnings_log pipeline
11. **Profile** — User stats, settings, admin access button

## PocketBase Schema (https://api.webcod.in)
### users collection
- `firebase_uid`, `email`, `display_name`, `referral_code`, `referred_by`
- `shib_balance`, `power_tokens`, `total_claims`, `total_wins`
- `is_verified` (bool) — set to true via `POST /api/app/auth/confirm-verified` after Firebase email link verified
- `active_booster_multiplier` (number), `booster_expires` (text) — booster state

### mining_sessions collection
- `user` (relation to users), `start_time` (date), `claimed_amount` (number), `booster_multiplier` (number), `is_verified` (bool), `ip_address` (text)
- NO `status`, `duration`, or `reward` fields — status is derived from `claimed_amount === 0`

### referral_earnings_log collection
- `referrer_id` (text, required), `claimer_id` (text, required), `amount` (number), `processed` (bool)
- listRule/viewRule/updateRule: `referrer_id = @request.auth.id` — only referrer can read/update their own entries
- createRule: `@request.auth.id != ""` — any authenticated user (claimer) can write
- **Architecture**: Claimer writes entry on mining claim; referrer's client calls `processPendingReferralEarnings(pbId)` on login to credit their own balance (self-update, always allowed). Key bug fixed: was calling `pbRecord.id` (undefined) instead of `pbRecord.pbId`.

### settings collection
- All admin-configurable values: mining rates, booster costs, ad IDs, withdrawal tiers
- `brevo_api_key` (text) — Brevo **REST** API key (`xkeysib-...`) used by app to send Delete Account OTP emails directly. Admin sets this in PocketBase admin panel. **Note**: the SMTP key (`xsmtpsib-...`) stored here currently only works with nodemailer SMTP — a REST key (`xkeysib-...`) from Brevo dashboard → API Keys section is required for the direct REST call path.
- listRule/viewRule: `""` (public read — allows APK to fetch `brevo_api_key` without auth)

### otp_codes collection
- `user` (relation to users), `code` (text), `expires_at` (text)
- listRule/viewRule/createRule/deleteRule: `user = @request.auth.id` — users manage their own OTPs via PB SDK

## Auth Flow
1. New user → Firebase signup → save pending data in AsyncStorage → `sendOtp(email)` → OTP screen
2. Existing user login → Firebase signin → `getUser(firebaseUid)` → if `is_verified=true` → tabs; else → `sendOtp(email)` → OTP screen
3. OTP verification → `verifyOtp(email, code)` → PB patches `is_verified=true` → `syncWithServer()` → tabs shown

## Auth Fixes (Session 3)
- **Auth buttons unresponsive on web** — Root cause: Reanimated `entering` animations leave views invisible on web. Fixed by replacing with React Native built-in `Animated.timing` in auth.tsx and verify-email.tsx
- **LinearGradient pointer event blocking** — Moved `pointerEvents="none"` from prop to `style.pointerEvents` to prevent overlay blocking taps
- **Double OTP generation** — verify-email.tsx was calling `resendOtp` on mount via `useEffect`, overwriting the OTP from signUp/signIn. Fixed by removing auto-send on mount
- **Double submit prevention** — Added `verifyAttemptedRef` to prevent the OTP form from submitting twice
- **Post-verification navigation** — Added `router.replace('/(tabs)')` in `syncWithServer()` after successful auth, and `router.replace('/auth')` in `signOut()`
- **Auth errors now inline** — Replaced `Alert.alert` with inline red error boxes in auth.tsx for better visibility and testability
- **Sign Out no longer needs confirmation** — Removed Alert.alert confirmation from Sign Out button; direct immediate sign-out
- **Dev OTP endpoint** — Added `GET /api/dev/peek-otp/:email` for development/testing only (not available in production)

## Key Bug Fixed (Session 2)
- `formatUser()` previously only returned `isVerified` but client code checked `is_verified`; now both are returned

## Firebase Config
- Project: shib-mine
- API Key: AIzaSyDQnt9_QENqlHtMprocQnJVQkB-4IyBgjg

## Navigation
5-tab layout: Home, Games, Invite, Wallet, Profile
- NativeTabs with liquid glass on iOS 26+
- Classic Tabs with BlurView for older iOS
- Ionicons for Android/Web

## Admin Controls
- Email: hanzala386@gmail.com
- Controls: Mining rate, entry fee, booster costs, AdMob IDs, Unity IDs, withdrawal tiers

## Theme
Gold (#F4C430) + Neon Orange (#FF6B00) on deep dark (#0A0A0F)

## File Structure
- `lib/firebase.ts` — Firebase SDK init and exports
- `lib/api.ts` — All API calls + PBUser/AppSettings types
- `context/AuthContext.tsx` — Firebase + OTP auth state management
- `context/WalletContext.tsx` — SHIB + Power Token balances + transactions
- `context/MiningContext.tsx` — Mining session timer, booster state
- `context/AdminContext.tsx` — Admin settings
- `app/auth.tsx` — Login/Signup with Forgot Password
- `app/verify-email.tsx` — 6-digit OTP input screen
- `app/admin.tsx` — Admin control panel
- `app/(tabs)/index.tsx` — Home/Mining with rolling counter + booster cards
- `app/(tabs)/games.tsx` — Knife Hit game (native React Native, canvas-style with Animated API)
- `public/game/Knife hit Template/` — All game assets: backgrounds, knives, bosses, sounds
- Express `/game` route → maps to `public/game/Knife hit Template/` (server/index.ts line 202)
- **CRITICAL**: Asset BASE in code = `${getApiUrl()}/game/` (NOT `/game/Knife hit Template/`)
- URL encoding required: spaces → `%20` e.g. `GamePlay%20Screen/CrossKnife.png`, `item%20knife-01.png`
- `components/KnifeShop.tsx` — Knife skin shop (10 skins, 200PT sequential unlock, syncs to PocketBase)
- `app/(tabs)/invite.tsx` — Referral system
- `app/(tabs)/wallet.tsx` — Wallet with BEP-20 + Binance Email withdrawal
- `app/(tabs)/profile.tsx` — Profile with admin access
- `server/routes.ts` — All Express routes including OTP, boosters, mining

## CRITICAL: Backend Architecture
- **Express (port 5000)** runs ONLY in Replit dev environment. `api.webcod.in` hosts PocketBase ONLY.
- All `/api/app/*` routes return 404 on the published APK. Every Express call MUST have a PocketBase SDK fallback.
- **Delete Account OTP** — fully direct, no Railway: app generates OTP on-device → stores in PB `otp_codes` via SDK → fetches `brevo_api_key` from PB `settings` → calls `api.brevo.com/v3/smtp/email` directly. Verification: app reads `otp_codes` directly from PB. `api.confirmDelete` (Railway route) is no longer called. In-memory OTP (`localOtp`) is the final fallback if PB is temporarily unreachable.
- **Game** is now LIVE at `https://webcod.in/arcade/index.html` (shared hosting — different domain from PocketBase API).
- `GAME_URL` in `games.tsx` is hardcoded to `https://webcod.in/arcade/index.html` (NOT constructed from `getApiUrl()`).
- `games.tsx` fetches game stats and syncs scores **directly via PocketBase SDK** (`pb.collection('users')`) — no Express dependency.
- The game's JS files do NOT call PocketBase — all bridge logic (score sync, PT awards, AdMob) is in the RN app.
- Referral count is queried directly via `pb.collection('users').getList(filter: referred_by = "CODE")` as fallback.
- **Settings** (`AdminContext.tsx`) now tries Express first → falls back to `pb.collection('settings').getList()` with `formatPbSettings()` mapper (snake_case → camelCase). Mining rates, boost costs, and ad IDs all load from PocketBase directly on device.
- **Dead code removed**: `PocketBaseAPI` class and `PBMiningSession`/`PBSettings`/`PBTransaction` interfaces removed from `lib/pocketbase.ts` (all used wrong field names and were unused).
- **PB password pattern**: `SHIB_${firebaseUid}_SECURE` — used for direct PB auth
- **Auth flow**: Firebase → `confirmAndLoadUser` tries Express → falls back to `pbDirectLogin` → saves PB token to AsyncStorage → restored on next startup
- **Mining flow**: `startMining`/`claimReward`/`activateBooster`/`startMiningWithBooster` try Express → fall back to direct PB SDK calls

## Tab Bar Layout
- **Custom tabBar** in `app/(tabs)/_layout.tsx` renders banner ABOVE tab buttons in one absolutely-positioned container
- Layout from bottom up: `[safe area] [tab buttons ~56px] [banner ~50px] [screen content]`
- React Navigation measures the combined height and applies correct screen content paddingBottom automatically
- `StickyBannerAd.tsx` exports `InlineBannerAd` (inline, no absolute positioning) and `BANNER_HEIGHT=50`

## Anti-Cheat (Session 4)
### PART 1 — Accessibility auto-clicker block (app-entry, Android)
- Local Expo module `modules/auto-clicker-detector/` (Kotlin) — `getEnabledAccessibilityServices()` via `AccessibilityManager.getEnabledAccessibilityServiceList` (NO `QUERY_ALL_PACKAGES`, Play-compliant). `index.ts` uses `requireOptionalNativeModule` → safe no-op on web/iOS/Expo Go.
- `SecurityContext.tsx` — new `'accessibility'` block type. `checkAccessibilityAutoClicker()` flags any enabled service whose package/id/label/description contains a SUSPICIOUS string (`clicker/auto/tapping/macro/touch/automation`) or matches BLACKLIST package. A dedicated `useEffect` runs OUTSIDE the `__DEV__` guard but gated by `Platform.OS==='android' && isAutoClickerDetectorAvailable()`; scans on launch + every 5s; `setBlockType(prev => prev ?? 'accessibility')` (never clobbers higher-severity block); auto-clears when service removed.
- `SecurityModal.tsx` — `'accessibility'` BLOCK_CONFIG (Hindi copy). "Open Settings" button → `Linking.sendIntent('android.settings.ACCESSIBILITY_SETTINGS')` + "Exit App". Non-cancelable: `onRequestClose` no-op + BackHandler suppression while any block active.
- **NOTE**: native module only verifiable in EAS/APK build — no-ops in this dev sandbox.

### PART 2 — Referral-claim 3-tier soft anti-cheat (non-blocking)
- `users` fields (both servers, `ensureBlacklistFields()` in init chain): `is_blacklist_1`, `is_blacklist_2`, `blacklist_1_notified` (bool), `blacklist_1_notified_at` (text).
- `profile.tsx` `detectReferralInfraction(uid)` runs BEFORE the referral→shib transfer: reads last 100 `referral_earnings_log` (`referrer_id=uid`, `-created`); flags if `amount>200` OR 5+ entries in the same exact minute (`created.slice(0,16)`). First offense → `is_blacklist_1`; offense while already tier-1 → `is_blacklist_2`. Wrapped in try/catch — **claim ALWAYS proceeds**.
- Withdrawal-approve route (both servers): on `status→completed`, if `is_blacklist_1 && !blacklist_1_notified` → latch `blacklist_1_notified`+`_at` FIRST (concurrency-safe), then create 2 warning notifications ONCE ("Fraud activity detected" / "Account ban notification.").
- `lib/api.ts` PBUser gains `isBlacklist1`/`isBlacklist2` (from `is_blacklist_1`/`_2`); `admin.tsx` VIP search card shows a red blacklist badge.

## Session 5 — Three Bug Fixes
### Bug 1 — Tournament points desync (`tournament_participants.points` stuck at 0)
- `tournament_participants.points` is now mirrored from the authoritative `users.weekly_tournament_points`. It is **cosmetic/admin-display only** — leaderboard + `runEndOfWeek` winner selection still read `weekly_tournament_points` (server-computed from `mining_sessions`).
- `tournament_participants.updateRule` relaxed `null → user_id = @request.auth.id` (self-update) so the client can mirror its own points. Safe because the field is non-authoritative. Applied to the shared PB on backend boot via `setupTournamentSchema` (create + else-branch patch of the existing collection). Confirm boot log: `tournament_participants.updateRule → self-update ✓`.
- Server: `syncUserTournamentPoints` patches the user's latest participant row after writing `weekly_tournament_points` (match by `user_id`; one row/user/week after the weekly wipe). Client: `TournamentContext.refreshUserStats` mirrors via PB SDK `getFirstListItem(user_id, sort:-created)` — guaranteed prod path.

### Bug 2 — Auto-clicker hardening
- Added installed-package detection: Kotlin `getInstalledBlacklistedPackages()` (`PackageManager.getPackageInfo`) + module `android/src/main/AndroidManifest.xml` `<queries>` declaring 4 known clicker package IDs (no `QUERY_ALL_PACKAGES` → Play-compliant). The `<queries>` list MUST stay in sync with `BLACKLISTED_AUTOCLICKER_PACKAGES` in `modules/auto-clicker-detector/index.ts`.
- `SecurityContext.checkAccessibilityAutoClicker` now flags an installed blacklisted package (check A) in addition to enabled accessibility services (check B); scans on launch + every 5s (covers gameplay).
- `MiningContext` consumes `useSecurity().blockType` and freezes all mining timers (interval/shib/drift) when any block is active. This is a **UI freeze** (claim is already blocked by `SecurityModal`), NOT a destructive server-side session abort — conservative to avoid false-positive harm. Inert in dev (`__DEV__` skips all security checks).
- Native pieces are **APK-only/untestable in the sandbox** — verify in an EAS build with a real auto-clicker (e.g. `com.truedevelopersstudio.automatictap.autoclicker`) installed.

### Bug 3 — `force_unity_only` ignored (still showed AdMob)
- `AdContext._routeInterstitial`/`_routeRewarded` now check `forceUnityOnly && Platform.OS === 'android'` **BEFORE** the `!isUnityAvailable()` AdMob bailout → route to Unity directly, AdMob fully bypassed. The old redundant `forceUnityOnly` block (which sat after the bailout) was removed. The early return exits before any AdMob race/timer state starts, so race guards are preserved.
- `StickyBannerAd` BannerSlot renders `<UnityBanner/>` under the same condition (no AdMob fallback).
- When the Unity native module is absent, forced-Unity no-ops → **NO ad shown** (intended "AdMob bypassed"), never AdMob. iOS is unchanged (always AdMob; Unity helpers no-op off Android).

## Session 6 — Fruit Cut Arcade PvP Game
- Second arcade PvP game (CTL "Katana Fruit" template) alongside Flappy Bounce; hub (`app/hub/index.tsx`) shows ONLY these two games.
- **gameId `fruitcut`** registered in `shared/arcade.ts` (BOTH backend copies, byte-identical): `{lives:3, maxScore:99999, scoreDelta:{maxIncrement:120, minIntervalMs:500}, timerSeconds:null, readyAfkSeconds:47}`. `GameSpec` gained required `readyAfkSeconds` (flappy 45); `server/arcadehub.ts` uses `readyAfkMs(spec)` per-game instead of the old shared const.
- **Client screens**: `arcade-lobby.tsx` GAME_META per-game (name/icon/hero/practice note), gameId from route param validated; `arcade-match.tsx` GAME_HOSTS map — fruitcut `https://webcod.in/fruitcut/index.html?v=1`, client AFK 40s (MUST stay well under server 47s backstop — server clears its AFK timer only on first SCORE; late tappers need seconds to land a first slice).
- **Game adapter** (`public/fruitcut/`): `arcade-sdk.js` (byte-identical to Flappy's) loads first in index.html (CRLF file — use sed, edit tool fails); `CMain._onRemovePreloader` skips menu → gotoGame in match; `CGame` — lives from `Arcade.maxLives(3)`, help-panel tap = TAP-TO-START → `Arcade.onStart()`, 600ms-throttled cumulative score reporter (beats server 500ms window; honest peak ~170pts/s vs 240 budget), match gameOver → `Arcade.onPlayerOut(_iScore)` once + no local end panel, onExit/`CInterface._onExit` early-return in match; `arcade:matchstart` listener resyncs lives only pre-start.
- **Deploy**: `dist/fruitcut-arcade.zip` must be manually uploaded to webcod.in so `/fruitcut/index.html` resolves; dev Express serves `/fruitcut` statically (Metro pathFilter excludes it). Railway prod backend needs redeploy for the new spec.

## Session 7 — Tower Stack (Construct 3) Arcade Game + UX Text Fixes
- Third arcade PvP game: "Stack Builder Skyscraper" (Construct 3 export) at `public/stack/`, gameId **`stack`** in `shared/arcade.ts` (BOTH backend copies byte-identical): `{lives:1, maxScore:999, scoreDelta:{maxIncrement:5, minIntervalMs:500}, timerSeconds:45, readyAfkSeconds:45}`. Server still has NO gameplay-timer enforcement — the 45s countdown is client-enforced; each client reports PLAYER_OUT at 0:00 and the normal both-out settle picks the higher score.
- **C3 wrapper recipe (differs from CTL games — engine is minified, logic in data.json)**: patch `scripts/main.js` `useWorker:!0→!1` (main-thread runtime); `stack-arcade.js` loaded as `type="module"` AFTER main.js calls official `self.runOnStartup(runtime => …)` → IRuntime; reads `runtime.globalVars.score/gameover` + `runtime.layout.name` on tick; `runtime.callFunction('gameover')` triggers the native game-over at 0:00. `register-sw.js` script tag REMOVED (SW offline cache would serve stale builds on webcod.in). arcade-sdk.js (byte-identical) loads first in `<head>`.
- Adapter behavior: 45s countdown overlay (top-center, red <10s) armed on entering the `Game` layout; runs in practice too (re-arms on restart); match extras — `Arcade.onStart()` on Game-layout entry (TAP-TO-START), 600ms-throttled cumulative score reports, once-only `onPlayerOut` on collapse/timeout/menu-exit, full-screen input blocker after out/freeze.
- Client: `GAME_HOSTS` stack `https://webcod.in/stack/index.html` v1 afkMs 35000 (< server 45s backstop); GAME_META in arcade-lobby; hub tile (3 games) + `assets/images/stack_icon.png`; `server/index.ts` `/stack` static (both blocks) + Metro pathFilter exclusion.
- **Deploy**: `dist/stack-arcade.zip` → manual upload to webcod.in `/stack/`; Railway backend redeploy needed for the new spec.
- Text fixes: hub subtitle → "Power Match 1v1 Challenges"; redeem success → "Success! … SHIB … has been added to your wallet." (redeem credits instantly — old "pending review" copy was wrong).

## Session 8 — Frame-Rate Independence + Stack Two-Stage Timer + Pause Kill
- **Fixed-timestep accumulators** (game speed = wall-clock on every device; constants untouched): Flappy `gameLoop` steps `update()` at 1000/60ms (cap 5 steps, kick off via `requestAnimationFrame(gameLoop)` for a real ts); Fruit Cut `CMain._update` steps `_oGame.update()` at `FPS_TIME` (cap 4), pinning global `s_iTimeElaps = FPS_TIME` per step (CGame time accumulators would double-count otherwise) and restoring after. Stack is C3 = already dt-based, no physics change.
- **Stack two-stage timer** (`stack-arcade.js` full rewrite): Stage 1 = 45s pre-game AFK, armed on the SDK's `arcade:matchstart` event (NEVER at boot — the WebView mounts warm during the unbounded matchmaking queue; if the event never lands, adapter never forfeits and RN/server backstops cover the seat). Covers menu + TAP-TO-START; 0:00 → forfeit `onPlayerOut(0)`, "START IN m:ss" overlay. Stage 2 = 300s armed on first pointerdown while `layout==='Game' && !gameover` — `Arcade.onStart()` now fires THERE (not on layout entry); 0:00 → `callFunction('gameover')` → lock score; both-out settle picks higher score. Practice: no stage 1; stage 2 re-arms per run.
- **Stack pause kill**: all `rt.objects.btn_pause` instances DESTROYED every tick in match (destroy, not hide — invisible C3 sprites still take touches). Practice keeps pause.
- **Spec** (both `shared/arcade.ts` copies, byte-identical): stack `timerSeconds` 45→300, `readyAfkSeconds` 45→60. **Ordering invariant (all clocks ~match start): adapter 45s < RN afkMs 50s < server 60s.**
- **RN**: GAME_HOSTS — flappy v7, fruitcut v2, stack v3 + afkMs 50000. Script tags bumped: flappy ?v=8, fruitcut ?v=2, stack stack-arcade.js?v=3.
- **Deploy**: `dist/{flappy,fruitcut,stack}-arcade.zip` → manual upload to webcod.in (all three changed); Railway backend redeploy for the new stack spec.

## Session 9 — Three New Arcade Games (2048, Ice Block, Color Rush) → 6 total
- Added ALONGSIDE the existing 3 (Flappy, Fruit Cut, Stack); hub now shows 6 tiles. App-handled ad architecture preserved (RN renders all ads; games render none; game UI never blocks the webview overlay).
- **Specs** (both `shared/arcade.ts` copies, byte-identical): `2048`{lives:1, maxScore:20000, scoreDelta:{1024,500}, timerSeconds:300, readyAfkSeconds:60}, `iceblock`{1, 9999, {150,500}, 300, 60}, `color`{1, 5000, {5,500}, timerSeconds:null (ENDLESS), 60}. Ordering invariant (all clocks ~match start): adapter stage-1 45s < RN afkMs 50s < server readyAfkSeconds 60s.
- **2048** (`public/2048/`, Construct 3): single 5-min timer FROM MATCH START (armed on `arcade:matchstart`), freeze at 0:00, `BtnReset` destroyed every tick in match. No adapter stage-1 AFK (RN 50s + server 60s cover the seat). Worker patched `useWorker=false`; `2048-arcade.js` loaded `type="module"` via `self.runOnStartup`; register-sw.js removed. Reads `runtime.globalVars.Score/GameOver`.
- **Ice Block** (`public/iceblock/`, Construct 3): two-stage (45s pre-game AFK + 5-min match), Stack pattern; `BtnReset`+`BtnHome` destroyed in match. Same C3 wrapper recipe. **maxIncrement 150 is a GUESS — validate honest clear-combo peak in a practice run before real stakes.**
- **Color Rush** (`public/color/`, CreateJS): 45s AFK + ENDLESS (no gameplay timer); only 'Exit' removed from Settings (Music/Sound/Display kept). Match-guarded button hiding in `js/game.js`+`js/canvas.js`. **CRITICAL: `playerData`/`gameData` are top-level `const` in game.js (global LEXICAL bindings, NOT on window) → `color-arcade.js` reads score via BARE `playerData.score`; `window.playerData` is undefined.**
- **Registration**: `arcade-match.tsx` GAME_HOSTS (v:1, afkMs:50000, `https://webcod.in/<id>/index.html`); `arcade-lobby.tsx` GAME_META + hero copy; `hub/index.tsx` tiles. Icons `assets/images/{2048,iceblock,color}_icon.png` (AI-generated, gold/neon theme). `server/index.ts` both static blocks + Metro pathFilter + log string updated. All 6 `arcade-sdk.js` byte-identical.
- **Deploy**: `dist/{2048,iceblock,color}-arcade.zip` → manual upload to webcod.in (`/2048/`, `/iceblock/`, `/color/`); Railway backend redeploy needed for the 3 new specs (until then JOIN_QUEUE for the new gameIds has no prod spec). All timers/button-removal are MATCH-ONLY (practice = free play). APK/real-match smoke test still pending (sandbox can only verify static serving + JS bundle).

## Ports
- Frontend (Expo): 8081
- Backend (Express): 5000

## Session 10 — Lobby room-card art swap
- `arcade-lobby.tsx` "SELECT A ROOM": the 5 tier boxes are now full-card baked-text images `assets/images/room_{1000,5000,10000,50000,100000}.png` (677x369) via `ROOM_IMAGES` keyed by entryPT; Pressable afford/disabled/testID/needMore logic untouched. Baked ticket/SHIB numbers match the economy (winnerTickets = entryPT×0.018) — regenerate all 5 PNGs if PT_PER_TICKET, COMMISSION_RATE, or the tier list changes. `pool-lobby.tsx` (8-Ball) intentionally keeps the old text boxes.
- RN-web quirk: static-asset `Image` needs `height:'auto'` in style or the asset's intrinsic height (inline) beats CSS aspect-ratio; harmless on native (auto = yoga default).

## Session 11 — Zero-Tolerance Network Guard (geo + VPN/proxy/datacenter blocking)
- **`server/networkGuard.ts`** (BOTH backend copies, MUST stay byte-identical): two-layer IP guard on every `/api/app/*` request + `/api/ws/*` WebSocket upgrades.
  - **Layer 1 — X4BNet CIDR lists** (vpn + hosting, ~30k merged ranges, 24h refresh): sorted+MERGED intervals, binary-search lookup. Merging is mandatory — raw lists have ~10% nested overlaps.
  - **Layer 2 — proxycheck.io** (`vpn=3&asn=1&risk=1`): blocks geo (IR,KP,SY,CU,AF,VE,YE,SO,SD,ZW + Crimea/Donetsk/Luhansk/Sevastopol region keywords), proxy/VPN, hosting. Keyless = 100 queries/day; set `PROXYCHECK_API_KEY` (Replit secret + Railway env) for production volume.
  - **Fail-open everywhere**: provider error → clean verdict cached 5 min; clean verdicts fetched before CIDR lists load also get the 5-min TTL (full 6h only once lists are ready or verdict is blocked). Private/localhost IPs always allowed. Verdict cache 6h / 20k cap, in-flight dedupe.
  - **Kill-switch**: PB `settings.network_guard_enabled` (bool, DEFAULT OFF) — admin panel "Network Guard" toggle; cached 60s. Env overrides: `NETWORK_GUARD_FORCE=1` / `NETWORK_GUARD_DISABLED=1`.
  - Blocked response: 403 `{blocked:true, code:'NETWORK_BLOCKED', reason, error:"Access Restricted: …disable any VPN or proxy services to continue."}`. `GET /api/app/security/network-check` is whitelisted (returns verdict with 200).
- **Client**: `lib/api.ts` intercepts 403 NETWORK_BLOCKED in `request()`/`robustPost()` → `SecurityContext` `'network'` block type (poll at boot+10s, every 60s, and on app-foreground; auto-clears when verdict clears; never clobbers root/emulator/integrity/accessibility blocks; `__DEV__` skips all). `SecurityModal` full-screen "Access Restricted" overlay with Retry. ToS sections 4+8 updated.
- **Known limits**: direct PocketBase SDK fallback paths bypass the guard (PB lives on api.webcod.in, separate host); Railway redeploy required to activate in prod.
- **proxycheck.io key rotation** (PB `proxy_api` collection — ALL rules null/admin-only, keys are secrets): `{api_key, is_active, usage_count, last_used}`; 2 keys seeded. Rotation manager in `server/routes.ts` (both copies): serve first active key with `usage_count < 900`; when exhausted rotate to next; if ALL exhausted reuse last-served key (no downtime, proxycheck just soft-fails → guard fail-open). 60s key-cache refresh; daily UTC reset (`last_used` on a previous UTC day → usage_count reset to 0 — proxycheck limits are per-day). `networkGuard.ts` gained `setNetworkGuardKeyProvider` (provider key → env `PROXYCHECK_API_KEY` → keyless); `reportUse` after every fetch (atomic PB `"usage_count+":1` — verified supported), `reportExhausted` on status=denied. Boot log: `[proxy_api] collection present ✓`; serving log on first guard lookup. Admin adds/deletes keys directly in PB admin UI.

## Session 12 — UI Scroll/Grid Fixes + Deep Cleanup + Pool Client Removal
- **games.tsx scroll fix** (user-requested; UI ban explicitly waived): custom tab bar is absolutely positioned, so scroll content needs `paddingBottom` clearance `insets.bottom + BANNER_HEIGHT + 90` on native (profile.tsx pattern) — was only 32, hiding the redeem pill. Any NEW tab screen with a ScrollView needs the same clearance.
- **hub/index.tsx grid rewrite**: explicit pixel math (`useWindowDimensions`, gridW capped 560, `cellW = floor((gridW-14)/2)`, explicit width/height + margins) replaces %-width/aspectRatio/rowGap; game-name Text has `adjustsFontSizeToFit`/`maxFontSizeMultiplier 1.1` to survive OS font scaling.
- **8-Ball Pool CLIENT removed** (unreachable — no UI navigated to it): deleted `app/hub/pool-lobby.tsx`, `app/hub/pool-match.tsx`, `components/pool/`, `lib/poolSfx.ts`, `assets/pool/`, and the 2 Stack.Screen entries in `app/_layout.tsx`. **Server-side pool hub (`server/gamehub.ts`, `/api/ws/hub`, `shared/pool/*`) intentionally KEPT** — do not reintroduce client references.
- **Cleanup deleted** (all grep-verified unreferenced): `attached_assets/` (206MB), `shib-mine-backend/attached_assets/` (103MB), `dist/*.zip` (27MB — arcade deploy zips, regenerable by re-zipping `public/<game>/`), `shib-mine-backend/assets/` (25MB), `artifacts/mockup-sandbox/node_modules` (242MB, `npm install` regenerates), `.cache/typescript`. Workspace ~1.1GB → ~750MB (excl. node_modules/.git).
- **tsconfig.json**: `exclude: [node_modules, artifacts]` — mockup sandbox has its own tsconfig; root tsc must not check it.
- **Latent bugs fixed** (surfaced by full tsc): (1) `profile.tsx` avatar-upload re-auth used nonexistent `user.firebaseUid` → never fired; now `user.uid` (= fbUser.uid, matches `SHIB_${uid}_SECURE`). (2) `context/AuthContext.tsx` BOTH copies: pending referral commission was patched onto snake_case keys (`shib_balance`) that don't exist on camelCase PBUser → credited commission never showed in displayed balance until next refresh; now `shibBalance`/`referralBalance`/`referralEarnings` + explicit null guard before `pbToProfile`.
- Pre-existing tsc errors remain in unrelated files (e.g. `KnifeShop.tsx` uses `Colors.text` which doesn't exist) — cosmetic, Metro unaffected.
- **Railway redeploy still pending** for: network guard key rotation (Session 11) + the shib-mine-backend AuthContext fix.

## Session 13 — Weapon Master (Knife Hit solo) Server-Authoritative Match Security
- **match_id lifecycle in `game_logs`** (fields `match_id`, `start_time`, `match_status` added via `ensureGameLogsFields`, both server copies): WS `/api/ws/game` creates row `match_status="active"` at GAME_START → `wsCommitSession` at GAME_OVER writes server-validated score (`raw_score`+`final_tokens`) + status `"started"` (= awaiting claim) or `"blacklisted"` (impossible score: rawScore > maxForTime×1.2+20, elapsed clamped to serverElapsed+2000ms) → claim endpoints flip to `"completed"`. COMMITTED WS message now carries `matchId`; `public/arcade/bridge.js` relays it to RN (**manual webcod.in upload pending**).
- **Claim validation, `/api/app/game/reward` + `/api/app/ad/claim`** (byte-identical in both copies): Layer 1 = shared in-memory `claimedMatchIds` map (TOCTOU guard, slot set before async work, 6h TTL purge; slot RELEASED in outer catch when nothing was awarded — else a PB blip locks the player out of a legit retry). Layer 2 = DB row check: completed→403 duplicate, expired→403, blacklisted→403; strict-only: missing/unknown matchId→403, active(unfinished)→403. **Score authority: claim ≤ 2× row's WS-committed `final_tokens`** (2× = ad double); exceeding it → strict: blacklist match + 403, grace: cap. Wall-clock 5PT/s heuristic survives ONLY as a cap fallback when the row has no committed score (never blacklists — it undercounts legit ~15PT/s play). `/api/app/ad/token` binds matchId at issue time (client can't swap it at claim).
- **`strict_match_enforcement`** PB settings bool (auto-added, default FALSE = grace). Grace mode: legacy no-matchId claims work exactly as before (legacy caps + last_session_score×2 + analytics log record). **Flip to true ONLY after all three ship: bridge.js upload to webcod.in, Railway backend redeploy, new APK.**
- **Sweeper + archival** (both copies, boot chain after `ensureGameLogsFields`): 60s sweeper marks active/started rows older than 10min `"expired"` (safe vs 3-min game: commit bumps `updated`; dual dev+Railway sweepers idempotent). One-time boot archival marks legacy blank-match_id rows `"archived"` (read-ids-first, 2000/boot cap). Verified live in dev boot logs (swept 18 stale rows).
- **Client (`app/solo-play.tsx`)**: `claimLockRef` double-click lock on Claim/2× (unlocks on failure), Android back-nav blocked except reward/error/idle states; reward ("Play Again") modal has a secondary **Back** button (`router.back()`, testID `reward-back-btn`); `lib/api.ts` game reward/ad-token calls pass `matchId`.
- **E2E verified live** (July 13, throwaway PB user, dev server): GAME_START→row `active` w/ match_id+start_time → GAME_OVER→`started` raw/final committed → claim 200 + PT credited + `completed` → duplicate claim 403. game_logs has ~800k legacy rows; blank-field rows keep flooding in from the LIVE Railway backend (old code) until it's redeployed — N/A rows in PB admin are prod traffic, not a dev-code failure.
- **Known residual (accepted)**: dev Express + Railway share the PB but have separate in-memory maps — simultaneous claims to BOTH servers could double-pay (completed-flip is fire-and-forget); bounded by 10-min sweeper window, low practical risk.
- **Deploy checklist**: (1) upload `public/arcade/bridge.js` to webcod.in, (2) Railway backend redeploy (also carries Session 11/12 pending changes), (3) new APK build. Then flip `strict_match_enforcement=true` in PB admin.

## User Preferences
- **NO design/UI work by the agent** (declared July 11, 2026): The user has permanently denied all design and UI overhaul tasks. Do NOT touch design or UI files (styles, themes, layouts, visual components, assets) unless the user explicitly reverses this. Agent scope is strictly logic and backend tasks.

## Session 10 — game_logs "One Game = One Row" (Weapon Master)
- **GAME_START hard gate** (both `server/routes.ts` copies, WS handler): the game_logs row (`match_status:"active"`) is now `await`ed and CONFIRMED before `SESSION_READY` is sent; on write failure → `ERROR match_create_failed`, session never starts. `session.logId` always set → the fallback INSERT in `wsCommitSession` was deleted (INSERT exists ONLY at GAME_START).
- **Claim correlation (UPDATE, never INSERT)**: `/api/app/game/reward` + `/api/app/ad/claim` — if the claim has no matchId (old APK), the server finds the user's newest OPEN row (`match_status="started"||"active"`, sort=-created) and closes THAT row. The "legacy" INSERT fallback is deleted from both endpoints: no resolvable match → PT still paid (grace) but NOTHING written to game_logs.
- **bridge.js match gate**: full-screen `shib-match-gate` overlay from boot; unlocks ONLY on `SESSION_READY`; 20s boot / 12s post-WS deadlines, WS error/close or `match_create_failed` pre-ready → Retry screen (reload). Re-zipped to `dist/bridge-upload.zip` → manual upload to webcod.in `/arcade/`.
- Zero-score WS disconnect now patches the row to `expired` immediately (no sweeper wait).
- E2E verified 16/16 vs live dev backend (one row/game; no-matchId claim updates same row; replay writes nothing; 2x path updates same row `is_double`; matchId claim + duplicate-403 intact).
- **Deploy**: user runs `git push github main` (Railway auto-deploys); flip `strict_match_enforcement` in PB settings AFTER bridge.js upload + new APK ship.
- **Session 10b — VERSION-AWARE gate (P1 hotfix)**: old APKs (old bridge, no `v` in GAME_START) were blocked by the hard gate → "Connection failed". Legacy clients → SESSION_READY sent IMMEDIATELY (old behavior), match row created async best-effort; `wsCommitSession` has a **legacy-only** fallback INSERT if that write never lands; a late async insert landing after session end is DELETED (stray-duplicate race guard). Strict path unchanged; claim correlation unchanged (works for both).
- **Session 10c — routing re-keyed on APP VERSION (supersedes v:2 routing)**: bridge.js on webcod.in is SHARED by ALL APKs, so the `v:2` bridge flag could never separate 1.0.2 from 1.0.3 — once the new bridge shipped, 1.0.2 users would have been gated too. Now:
  - **RN app (1.0.3+)**: `app/solo-play.tsx` injects `appVersion` (from `Constants.expoConfig.version`) via INJECT_VARS; app.json bumped to **1.0.3**. 1.0.2 APKs inject nothing.
  - **bridge.js**: gate overlay + 12s timer armed ONLY when injected `appVersion >= 1.0.3` (`verAtLeast`, numeric per-segment). No boot-time gate at all. Legacy apps NEVER see "Connecting…". `GAME_START` forwards `{v:2, appVersion}`.
  - **Server (both routes.ts copies byte-mirrored)**: `strictClient = appVersionAtLeast(msg.appVersion, "1.0.3")` — absent/garbage/older → legacy path (immediate READY). `v:2` no longer drives routing.
  - **Claims already version-routed**: matchId present (1.0.3) → strict validation; absent (1.0.2) → correlation + grace. No change needed.
  - E2E 10/10 (no-version, empty, "1.0.2", garbage → legacy instant READY; "1.0.3", "1.0.10" → strict row-before-READY; one row per game both paths). bridge-upload.zip regenerated — re-upload to webcod.in `/arcade/` (safe for 1.0.2: gate disarmed without appVersion).
- **Session 10d — GAME_OVER score reconciliation (payout accuracy fix)**: user saw score 65 on screen but got paid 90 instead of 130 on the 2× claim (game_logs raw_score=45). Root causes: (1) bridge drains queued hits every ~100ms but server `WS_MIN_HIT_MS=280` rejects them as too_fast; (2) hits before WS handshake never arrive; (3) GAME_OVER handler IGNORED client score whenever `session.hits > 0`; (4) elapsed clamp `serverElapsed+2s` capped honest scores when the WS session started late relative to real gameplay. Fix (both routes.ts copies, byte-mirrored): GAME_OVER now ALWAYS reconciles — `serverPT = max(perHitTally, min(clientScore, WS_MAX_PT, maxForTime))`; elapsed = `max(clientElapsed, serverElapsed)` clamped to 185s (3-min session limit + tolerance); impossible-rate blacklist (15pts/s × 1.2 + 20) unchanged; per-hit tally is now fraud telemetry only. `strict_match_enforcement` confirmed false in live PB. E2E 11/11: legacy repro (server counted 35, displayed 65 → paid 65 → 2×=130), strict 1.0.3 reconciliation, impossible-score blacklist, elapsed-inflation cap. Server-only fix — Railway push deploys it; no bridge change needed.

## Session 10 — AdMob-Only Ad Stack (SUPERSEDES all Unity/Yodo1 ad sections above)
- **Yodo1 MAS + Unity Ads fully REMOVED**: deleted `modules/yodo1-mas`, `modules/unity-ads`, `lib/unityAds.ts`, `lib/native-ads.*`, `lib/nativeAds.ts`, `scripts/verify-android-config.js`. `plugins/withAndroidConfig.js` stripped to build-system pins (AGP 8.10.2/Gradle 8.13/NDK/cpp/subprojects/ADI) + deprecated-gradle-key filter; manual AdMob manifest injection removed — the `react-native-google-mobile-ads` Expo plugin in app.json (Google TEST App IDs) writes the App ID.
- **Ads = AdMob ONLY, official Google TEST unit IDs everywhere** (`lib/AdService.ts` ADMOB_TEST_IDS; admin-panel IDs stored but unused until release). `lib/admob.ts` = lazy-require SDK gateway (web stub via metro.config.js redirect → `lib/admobWebStub.ts`; Expo Go → simulation). `context/AdContext.tsx`: preloads interstitial+rewarded on init, show* waits ≤6s for load then proceeds WITHOUT ad (never blocks claims); rewarded resolves true only on EARNED_REWARD.
- **Banners** (`components/StickyBannerAd.tsx`): 60s HARD refresh (key remount), Active-Visibility gate (useIsFocused + AppState → blur/background destroys native view + clears timer). Hub + arcade-lobby have TOP + BOTTOM banners; bottom bars render only when `BANNERS_AVAILABLE`.
- **Server-authoritative game rewards (BOTH server copies)**: `/api/app/ad/token` reward basis = `game_logs.raw_score` by match_id (server-written at game over; `last_session_score` only legacy fallback); `/api/app/game/reward` SNAPS payout to exactly committedPT (1×) or committedPT×2 (2×, intent = amount > 1.5×committed); >2×committed → match blacklisted + 403. Claim/2× buttons share a client double-tap lock (`claimInFlightRef` + `actionsLocked` in solo-play.tsx).
- Interstitials fire only AFTER Claim/2× click — uniform across game modes.
- Native ad behavior (real banners/interstitials) is APK-only — verify in an EAS build; dev sandbox verifies JS bundle only.

## Session 11 — TOTAL RESET: `game_score` collection (SUPERSEDES all game_logs sections)
- **game_logs is RETIRED**: nothing reads or writes it anymore (collection + its ~811K legacy rows left untouched in PB — historic only). All solo-game persistence moved to the brand-new **`game_score`** collection: `user` (relation→users), `user_id` (text — plain-text mirror of the player's PB id, server-populated on every write incl. claim PATCHes; added Session 12, older rows blank), `match_id` (text), `raw_score` (number), `final_tokens` (number), `is_double` (bool), `match_status` (text). ALL API rules null (server/admin-token only). Created on boot by `ensureGameScoreCollection()` (both routes.ts copies).
- **Strict one-row lifecycle**: (1) GAME_START → ONE INSERT `{raw:0, final:0, double:false, status:"active"}` (strict 1.0.3+ clients: awaited before SESSION_READY); (2) game over → wsCommitSession PATCHes the SAME row (by logId, else PATCH-or-INSERT by match_id lookup; blind insert only for legacy clients with no row) `{raw_score:serverPT, final_tokens:serverPT, status:"started"}`; (3) claim → PATCH same row `{is_double, final_tokens, status:"completed"}` where **`final_tokens = is_double ? raw_score*2 : raw_score` STRICTLY**.
- **Payout math hardening**: `committedPT` now derives from `raw_score` ONLY (dropped the `|| final_tokens` fallback — that was how client-tainted values could leak into payout basis); double-intent check `safeAmount > committedPT*1.5` without rounding (committedPT=1 edge); grace wall-clock cap uses the row's PB `created` timestamp (game_score has no start_time field; parse with space→T replace).
- **Sweeper** re-pointed at game_score (age-gated via `updated`, SPACE-separator datetime filter). `ensureGameLogsCollection`/`ensureGameLogsFields`/`archiveBlankGameLogs` deleted from both copies.
- **Root cause of the user's 60/80 mismatch row**: the live pre-snap Railway build wrote the CLIENT-sent claim amount straight into `final_tokens` at claim time (60 raw → client sent 80). The new pipeline snaps to server raw_score, so that mismatch is impossible by construction.
- **E2E verified live (July 15, dummy PB user `sqdet1zgtsmubsy`)**: Game A — 16 real WS hits → COMMITTED 80 → 1× claim → row `raw=80 final=80 double=false completed`, exactly 1 row; duplicate claim → 403. Game B — 80 → ad token (reward 160) → 2× claim → same row `raw=80 final=160 double=true completed`, 1 row. Balance 240 = 80 + 160 exact.
- **Deploy**: `git push github main` → Railway redeploy required (old build still writes game_logs until then). Both server copies byte-mirrored on the game sections; both `npm run server:build` pass.

## Session 12 — Thin-Layer Security: HMAC-Signed Match IDs + Account Blacklist
- **Signed match ids**: `matchId = "uuid.hmac16"` — HMAC-SHA256(`SESSION_SECRET`, `uuid:pbId`) first 16 hex chars, generated at WS GAME_START (`signMatchId(pbId)`). Signature binds match AND owner: account B presenting account A's matchId fails verification. matchId stays an opaque string → ZERO client/bridge changes.
- **Hard Gate 0** in `/api/app/game/reward` + `/api/app/ad/token`: `matchSigState(matchId, pbId)` — `invalid` → 403 before ANY DB work (timingSafeEqual); `unsigned` (no dot = pre-deploy legacy) falls through to DB row validation. Rejection does NOT lock the in-memory claim slot.
- **Row-owner check (layer 2)** in both claim routes: `logRecord.user !== pbId` → release slot + 403 + flag caller's account (covers unsigned legacy ids too).
- **Account blacklist** `flagUserBlacklist(pbId, reason)`: tier 1 `is_blacklist_1` → tier 2 `is_blacklist_2` escalation (same convention as referral anti-cheat, shows in admin VIP search). Fire-and-forget, never blocks flow. Triggers: impossible WS score, claim > 2× committed (strict), cross-account claim.
- **SESSION_SECRET**: signing key; boot warns loudly if unset (falls back to a repo literal — forgeable). MUST be set on Railway. Rotating it hard-403s in-flight signed matches.
- **No PB stored procedures exist** — game_score all-rules-null (admin-token-only writes) IS the DB isolation layer.
- E2E verified live (Jul 15): signed format, honest 1× exact payout, forged sig 403 (real sig still claimable after), cross-account 403 + true owner still pays, duplicate 403, impossible score → PT 0 + match blacklisted + `is_blacklist_1` set. Both copies byte-mirrored on game sections; both builds pass.

## Session 13 — Railway → VPS Migration (Thin Gateway single-file bundle)
- **Root cause of Railway build failure**: 4 `package-firewall.replit.local` URLs in ROOT package-lock.json → sed-rewritten to registry.npmjs.org (integrity untouched). Lockfile now clean.
- **VPS package**: `scripts/build-vps.sh` → `dist/shib-backend-vps.zip` — esbuild FULL bundle (`--bundle --format=cjs --external:pg-native`, NO `--packages=external`) of `shib-mine-backend/server/index.ts` → single 2.5MB `server.cjs`; the VPS never runs a package manager. Zip = server.cjs + public/ + server/templates/ + app.json + deploy templates from `deploy/vps/` (.env.example, systemd unit, nginx conf w/ WS upgrade + `client_max_body_size 12m`, DEPLOY.md).
- **Bundle verified** in NODE_ENV=production: landing 200, /game 200, forged sig 403, full WS game E2E → COMMITTED signed matchId → claim 200 exact. Server honors SERVER_PORT over PORT.
- **Domain migration**: `backend.webcod.in` (user DNS, currently CNAME→Railway) is the cutover pivot — existing APKs already resolve it via getApiUrl() fallback, so DNS repoint = zero app rebuild. eas.json (both copies) EXPO_PUBLIC_DOMAIN → backend.webcod.in; lib/api.ts (both) submitTaskProof primary → backend.webcod.in.
- **getApiUrl() trailing-slash fix (both query-client.ts)**: `new URL().href` → `.origin` — href's trailing slash broke string-concat consumers (hubClient/arcadeClient `//api/ws/hub-arcade`, KnifeShop `//game/`) for any build where EXPO_PUBLIC_DOMAIN passes the filter (i.e. all future builds with backend.webcod.in baked).
- **Cutover order (DEPLOY.md)**: VPS setup → SAME SESSION_SECRET as Railway → systemd → pre-issue TLS via certbot DNS-01 BEFORE DNS flip → lower TTL → flip CNAME→A record → verify → only then kill Railway.

## Session 14 — KYC "User Verification & Dynamic Withdrawal" System
- **Spec**: non-verified users blocked from Multiplayer Hub + Wallet (KycGateModal popup → "Verify Now" → `/verify-account` form); admin approve / reject-with-reason / unverify; withdrawal is Amount-only (server holds destination).
- **Client**: `shared/kyc.ts` (KYC_COUNTRIES w/ dial codes + binance flags, Iran blocked, validators, KYC_REJECT_REASONS, KycStatus); `components/KycGate.tsx` (`KycGateModal` + `useKycGate()` — reads `pbUser.kycStatus === 'verified'`); `app/verify-account.tsx` (form: Full Name → Country dropdown → auto dial code → phone; Binance-supported country → Binance Email + BEP20, else BEP20-only; 409 dup → "Field already in use" + support mailto; status screens for under_review/rejected w/ resubmit).
- **Gating (ALL deep-linkable hub routes)**: `hub/index.tsx`, `hub/arcade-lobby.tsx` — mount guard `setShowKycGate(!isKycVerified)` in useEffect (MUST clear on flip: pbUser hydrates async on cold start, else gate latches open for verified users); onClose → `router.canGoBack() ? back() : replace('/(tabs)')`. `hub/arcade-match.tsx` — socket connect gated on `kycOk` which LATCHES true (transient pbUser re-hydration can never close a live match socket); practice stays ungated (offline, no stakes). `games.tsx` multiplayer entry + whole wallet tab also gated.
- **Wallet**: withdrawal form is Amount-only; destination shown read-only from KYC record; Binance Email method only when `kycCountry === 'India'`. `WalletContext.createWithdrawal(method, amount)`.
- **Backend** (BOTH server copies): PB `verification_requests` collection + `users` KYC fields auto-created on boot; routes `/api/app/verification/submit|status/:pbId` + `/api/app/admin/verification` (list/approve/reject-requires-reason/unverify). Server-side Iran 403, duplicate-field 409, resubmit-after-reject. E2E verified live (Jul 15): submit → under_review → reject w/ reason → resubmit → approve → verified → unverify → none.
- **Admin panel** (`admin.tsx`): "Verification Requests" section (pending list, approve w/ confirm, reject via KYC_REJECT_REASONS radio-picker modal, refresh); Unverify button in VIP search card when `kycStatus === 'verified'`. `profile.tsx`: KYC badge (verified/pending) or "Verify Account" CTA.
- **Deploy**: backend changes need VPS/Railway redeploy (both copies synced).

## Session 15 — KYC Hardening: JSON Crash Fix, 3-Attempt Limit, Notifications, Per-Field Dup UX
- **JSON crash fix** (`lib/api.ts`): `parseJsonSafe(res)` — reads text, tries JSON.parse; on HTML/non-JSON responses throws clean "The server is being updated. Please try again in a few minutes." (`err.nonJson=true`) instead of `Unexpected token '<'`. Used by both `request()` and `robustPost()`. Root cause of the prod crash: stale prod backend returning HTML 404 for `/api/app/verification/*` — **user must redeploy `dist/shib-backend-vps.zip`**.
- **Submission limit**: `users.submission_count` (number, auto-created on boot). Submit route 429 `{error:"You have reached the maximum limit for account verification.", limitReached:true}` when count ≥ 3; each successful submit increments; response carries `submissionsUsed`/`submissionsLimit`. Client shows Alert "Submission Limit Reached".
- **Notifications on decision** (both server copies): approve → "Account Verified ✓"; reject → "Verification Rejected" + reason (type personal, target_user). Reject reason also shown in `profile.tsx` red banner (testID `profile-kyc-reject-reason`) with resubmit hint.
- **Per-field dup UX** (`verify-account.tsx`): inline "This [Field] is already in use." under Phone/Binance Email/BEP20 (testIDs kyc-dup-phone/-binance-email/-bep20); Contact Support = gold bordered button → mailto support@shibahit.com, subject "Account Verification Dispute", body "User ID: [pbId], Name: [name], Email: [email]. I believe this account is mine."
- **Limit-bypass hardening** (architect finding, both copies): `users.updateRule` gained `@request.data.submission_count:isset = false` (client can't reset own counter via PB SDK); submit PATCH uses PB atomic modifier `"submission_count+": 1` (no read-modify-write race). Both verified live: self-PATCH of submission_count → 404 rule denial, normal field PATCH still 200.
- Submit stays EXPRESS-ONLY (cross-user dup checks would leak PII via PB rules). E2E verified live (Jul 15): fresh submit → count 1; count 3 → 429 exact copy; dup vs other user → 409 all 3 fields; reject → user rejected + reason + notification; approve → verified + notification. All test data cleaned up. `dist/shib-backend-vps.zip` rebuilt.

## Session 16 — verification_requests.status → PB SELECT + prod deploy
- **`verification_requests.status` is now a PB SELECT** with options exactly `'Under Review' | 'Verified' | 'Rejected'` (migrated live Jul 16). PB pre-v0.23 REFUSES in-place field type changes — `ensureKycStatusSelectField()` (both server copies) does a 3-phase swap: add temp select `status_select` → copy alias-mapped row values → one schema PATCH drops the old text field and renames the temp (same field id) to `status`. Idempotent (`status SELECT field OK ✓` on later boots, incl. Railway).
- **Server writes/reads labels** via `KYC_STATUS_UNDER_REVIEW/VERIFIED/REJECTED` constants + `toDbKycStatus()` alias mapper (accepts under_review/approved/rejected/unverified/pending → label). Admin list query still accepts `?status=under_review` (alias-mapped). Approve/reject gates compare via `toDbKycStatus(row.status)`. Unverify marks active rows `Rejected` + reject_reason "Released by admin (unverified)" ('unverified' is not a select option).
- **`users.kyc_status` intentionally KEEPS machine values** (`verified`/`under_review`/`rejected`/`none`) — client gating (AuthContext/WalletContext/profile) reads them; API JSON responses also stay machine-valued. Client never displays the row's raw label.
- E2E verified live (Jul 16): 3 accounts submitted; dup 409 flags all 3 fields; limit 429 at count≥3; approve→row `Verified`+user verified; unverify→row `Rejected`+note, user released; resubmit (count 2)→re-approve; reject w/ reason→row+user+reason; third left `Under Review`; double-action guard → "Request is already Rejected". Final states left in place per user request.
- **Prod fix**: "The server is being updated…" = stale Railway backend 404ing `/api/app/verification/*`. `git push github main` auto-deploys Railway (~2-4 min). Old prod code writes text statuses that the SELECT now rejects — push MUST carry this session's commit.

## Session 17 — KYC Status Sync (manual PB dashboard edits now reach the app)
- **Problem**: admin manually edits `verification_requests.status` in the PB dashboard → app kept showing the old badge because the UI reads `users.kyc_status`, which only the admin approve/reject API routes updated.
- **Server self-heal** (both copies, status route byte-identical): `GET /api/app/verification/status/:pbId` treats the LATEST request row as source of truth. If `normalizeKycStatus(row.status)` ≠ `users.kyc_status`, it patches the users record exactly like approve/reject would (verified → copies kyc_full_name/country/country_code/phone/binance_email/bep20_address + clears reason; rejected → sets reason from row; under_review → clears) and returns the derived status. Also repairs a half-completed approve (row patched, user patch failed).
- **Unverify guard**: heal is SKIPPED when `derived==='rejected' && row.reject_reason==="Released by admin (unverified)" && user is 'none'` — unverify's clean `none` state survives and its internal audit note never surfaces as a user-facing rejection banner. (Sentinel string must stay in sync with the unverify route.)
- **Client**: `AuthContext.refreshKycStatus()` — Express status endpoint first (triggers self-heal); APK fallback reads own latest `verification_requests` row via PB SDK (owner listRule) and updates state display-only (users updateRule blocks kyc_* self-writes). Updates both `pbUser` and `user` via functional setState with no-op guards (no render loops). Called from `profile.tsx` `useFocusEffect` (every tab focus) and `verify-account.tsx` mount.
- E2E live (Jul 16): Abu healed under_review→verified w/ field copy (his real pending manual edit); scratch user: all 3 manual transitions synced, approve→unverify→status stays `none`, manual re-verify after unverify still heals. Architect PASS.
- **Deploy**: Railway needs `git push github main` (carries this commit) for the APK path; dev Express verified working.

## Session 10 — Dynamic BEP-20 Fee + Country-Gated Withdrawal Visibility
- **Country gating** (was already live server+wallet): Binance Email withdrawal is India-only. NEW: `verify-account.tsx` also hides the Binance Email destination row for non-India KYC (`kycCountry==='India'` gate) — was the only leak.
- **Dynamic BEP-20 fee**: new numeric `bep20_fees` field in PB `settings` (auto-added + seeded 3680 by `ensureBrevoKeyInSettings` on backend boot — both server copies). Fee chain everywhere: `bep20_fees > 0 ? it : (legacy bep20_fee > 0 ? it : 3680)` — **0/unset always falls back to 3680** (deliberate: unseeded record must never make withdrawals free; a true 0 fee is impossible).
- Server (BOTH copies): withdrawal route subtracts dynamic fee from BEP-20 payout (Binance Email stays free); settings GET mapper exposes `bep20Fees`; admin update route maps `bep20Fees → bep20_fees` clamped `Math.max(0,…)`.
- Client: `AppSettings.bep20Fees` + AdminContext mapper/defaults; `wallet.tsx` fee display + net calc from `useAdmin()` settings (`DEFAULT_BEP20_FEE=3680` fallback); `WalletContext` PB-SDK fallback fetches fee from PB settings directly (APK path); `admin.tsx` "BEP-20 Network Fee (0 = default 3680)" field in Withdrawal Thresholds.
- Settings cache key NOT bumped — stale cache lacking `bep20Fees` → undefined → all readers fall back to 3680 (verified safe).
- **Deploy**: Railway needs `git push github main` for the prod fee deduction to go live; until then prod deducts legacy/3680 while client may display an admin-changed fee.

## Session 11 — Referral Commission Fix (ID-form referred_by) + Live Validation
- **Root cause found (LIVE DATA)**: `users.referred_by` holds the referrer's PB record ID for ~98% of referees (2504 total referred users; 492/500 sampled = ID-form), but the client claim path (`pbClaimMining` in `context/MiningContext.tsx`) looked the referrer up ONLY by `referral_code="<referred_by>"` → silent 404 → **no commission ever written** for ID-linked referees. Claims are PB-direct only (Express claim route unused by APK), so this was THE production path.
- **Fix (both app copies: root + shib-mine-backend/)**: single filtered lookup `id="X" || referral_code="X"` via `getFirstListItem`. CRITICAL: `users.viewRule = "@request.auth.id = id"` — `getOne()` on another user's record is FORBIDDEN under a user token; MUST use a list query (listRule = any authed user).
- **Game rewards NEVER pay referral** (server-enforced): `/api/app/game/reward` (both server copies) has no referral credit; hub 10% is house rake, not referral; grep-verified NO client game code writes `referral_earnings_log`. Historic `source=game_reward` rows in `referral_history` (281k rows, stopped 2026-06-30) came from an OLD deployed backend build — current code cannot produce them. `mining_claim` history rows = 0 because prod claims never hit Express.
- **Live E2E on real PB (Jul 16, test accounts khadijasilk2025 → kapadiasilk)**: fixed lookup resolves referrer; old lookup proven 404; log entry 11.39976 (exactly 10% of the referee's real 113.9976 claim that day) written under referee's USER token; referrer-side processing credited `referral_balance` 0 → 11.39976. Game reward +50 PT via dev Express produced ZERO new referral rows and referrer balances unchanged. Script: `.local/referral_validation.mjs`.
- **invite.tsx copy fix** (both copies): "10% … every SHIB claim and game reward" → mining-claim-only wording (game rewards explicitly excluded).
- **OPEN (user decision)**: retroactive backfill for missed commissions (~421 ID-form referees with 17k+ claims sampled) — NOT done; would be a large economic credit.
- **Deploy**: fix is CLIENT-side → ships with the next APK build; no Railway dependency. (Railway remains stale from Session 10 pending `git push github main`.)

## Session 12 — Android Build Fix: Kotlin Metadata 2.3.0 vs 2.1.0 (Google Mobile Ads)
- **Error**: EAS Android build failed with "Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.3.0, expected version is 2.1.0" — GMA SDK 25.4.0 (bundled by react-native-google-mobile-ads 16.4.0) is compiled with Kotlin 2.3.x; Expo SDK 54 default is Kotlin 2.1.20, and the Kotlin compiler can only read metadata ONE minor version ahead (2.1 reads ≤2.2).
- **Fix**: `expo-build-properties` android `"kotlinVersion": "2.2.20"` in app.json (BOTH copies: root + shib-mine-backend/). Kotlin 2.2 reads metadata ≤2.3 → mismatch resolved without touching the ads SDK version.
- **Why 2.2.20 exactly**: it is the HIGHEST key in Expo 54's KSP lookup table (expo-modules-autolinking `KSPLookup.kt` → `"2.2.20" to "2.2.20-2.0.3"`); an unlisted Kotlin version hard-fails with "Can't find KSP version". Chain verified: expo-build-properties writes gradle prop `android.kotlinVersion` → autolinking settings plugin maps it to version-catalog `kotlin` → ExpoRootProjectPlugin sets root ext `kotlinVersion` (RNGMA reads the same ext) + auto-picks KSP. KGP/KSP/compose-plugin 2.2.20 artifacts all confirmed live on Maven Central.
- **Verification limit**: sandbox cannot run EAS/prebuild — confirm in the next Android build. If a future Google lib ships Kotlin 2.4 metadata, an Expo SDK upgrade will be required (2.2.20 is the ceiling on SDK 54).
