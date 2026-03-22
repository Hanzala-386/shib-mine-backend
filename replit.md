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
7. **Weapon Master Game (Construct 3)** — Full HTML5 game hosted at `/arcade/`, rendered via WebView (iOS/Android) or iframe (web). bridge.js reads C3 score via `esm._allGlobalVars[]` (each var has `._name` / `._value`). On "death" layout: GAME_OVER postMessage with score & tomatoes → syncScore API. 1 score = 1 PT. "Double My Tokens" rewarded ad (2x).
8. **Professional Ad Integration** — `react-native-google-mobile-ads` SDK (requires custom EAS build for real ads; simulates gracefully in Expo Go). Architecture:
   - `context/AdContext.tsx`: SDK init + fetches all unit IDs from PocketBase settings; exposes `showInterstitial()` / `showRewarded()` with loading state
   - `components/StickyBannerAd.tsx`: Persistent banner above tab bar, 30s auto-refresh via key remount
   - `lib/nativeAds.ts`: SDK wrapper with `createForAdRequest` → LOADED → show → CLOSED/EARNED_REWARD callbacks; graceful fallback to simulation when native module not available
   - `metro.config.js`: Web stub for `react-native-google-mobile-ads` + @iabtcf ESM `.js` extension resolver fix
   - PocketBase settings fields: `admob_unit_id` (interstitial), `admob_banner_unit_id`, `admob_rewarded_id`, `unity_game_id`, `unity_rewarded_id`, `applovin_sdk_key`, `applovin_rewarded_id`
   - Mediation waterfall: AdMob primary → Unity Ads → AppLovin MAX (configured via AdMob dashboard mediation groups)
   - app.json plugin: `react-native-google-mobile-ads` with test App IDs (update to production IDs before release)
8. **Admin Panel** — Restricted to hanzala386@gmail.com, controls all economic settings
9. **Wallet** — SHIB balance & Power Token tracking (BEP-20 + Binance Email withdrawal)
10. **Invite** — Referral code sharing, 10% server-side commission
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

### settings collection
- All admin-configurable values: mining rates, booster costs, ad IDs, withdrawal tiers

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
- **Game** (`/arcade/index.html`) is now LIVE at `https://api.webcod.in/arcade/index.html` (uploaded to pb_public via SFTP).
- `games.tsx` fetches game stats and syncs scores **directly via PocketBase SDK** (`pb.collection('users')`) — no Express dependency.
- Referral count is queried directly via `pb.collection('users').getList(filter: referred_by = "CODE")` as fallback.
- **PB password pattern**: `SHIB_${firebaseUid}_SECURE` — used for direct PB auth
- **Auth flow**: Firebase → `confirmAndLoadUser` tries Express → falls back to `pbDirectLogin` → saves PB token to AsyncStorage → restored on next startup
- **Mining flow**: `startMining`/`claimReward`/`activateBooster`/`startMiningWithBooster` try Express → fall back to direct PB SDK calls

## Tab Bar Layout
- **Custom tabBar** in `app/(tabs)/_layout.tsx` renders banner ABOVE tab buttons in one absolutely-positioned container
- Layout from bottom up: `[safe area] [tab buttons ~56px] [banner ~50px] [screen content]`
- React Navigation measures the combined height and applies correct screen content paddingBottom automatically
- `StickyBannerAd.tsx` exports `InlineBannerAd` (inline, no absolute positioning) and `BANNER_HEIGHT=50`

## Ports
- Frontend (Expo): 8081
- Backend (Express): 5000
