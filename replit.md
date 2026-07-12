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

## User Preferences
- **NO design/UI work by the agent** (declared July 11, 2026): The user has permanently denied all design and UI overhaul tasks. Do NOT touch design or UI files (styles, themes, layouts, visual components, assets) unless the user explicitly reverses this. Agent scope is strictly logic and backend tasks.
