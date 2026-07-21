# Shiba Hit - Crypto Mining App

## Overview
A gold & neon orange glassmorphism React Native mobile app for mining SHIB cryptocurrency. Users earn SHIB tokens through 60-minute mining sessions and Power Tokens through a Knife Hit mini-game and six arcade PvP games. Built with Firebase Auth + PocketBase backend and Expo Router.

## Architecture
- **Frontend**: Expo Router (file-based routing), React Native
- **Backend**: Express.js on port 5000 (server/routes.ts) + PocketBase at https://api.webcod.in
- **Auth**: Firebase Authentication (Email/Password) + Firebase native email verification link
- **State**: React Context (Auth, Wallet, Mining, Admin, Tournament)

## Key Features
1. **Firebase Email Verification** — Signup → `sendEmailVerification()` → verify-email screen; Sign-in checks `firebaseUser.emailVerified`; `POST /api/app/auth/confirm-verified` syncs verified status to PB
2. **Mining** — 60-minute timer, server-persisted start/claim with booster_multiplier stored in session; 24 PT entry fee
3. **Speed Boosters** — 2x/4x/6x/10x whitelist; time-limited 1 hour, single active at a time, countdown timer on active card
4. **Server-Side Claim Verification** — Server computes expected reward from rate × 3600 × booster_multiplier; client reward validated within 5% tolerance; forged multiplier → 400 + `[SECURITY]` log
5. **Rolling Counter** — Smooth animated SHIB balance display during mining
6. **Knife Hit / Weapon Master** — Vanilla JS knife-throw game at `public/game/Knife hit Template/index.html`, served from Express at `/game/index.html`. Per-hit WS signals, server counts hits, anti-cheat (min 300ms between hits, burst detection), HMAC-signed match IDs, server-only score commitment
7. **Arcade PvP Games (6)** — Flappy Bounce, Fruit Cut, Stack Builder, 2048, Ice Block, Color Rush. Hosted on `https://webcod.in/<game>/index.html`. Server-authoritative scoring via WebSocket bridge. HMAC-signed match IDs. Game specs in `shared/arcade.ts`.
8. **Ad Integration** — AdMob-only (`react-native-google-mobile-ads`). `context/AdContext.tsx` preloads interstitial+rewarded; banners via `StickyBannerAd.tsx`. Native behavior APK-only; dev simulates gracefully.
9. **Admin Panel** — Restricted to hanzala386@gmail.com, controls all economic settings
10. **Wallet** — SHIB balance & Power Token tracking (BEP-20 + Binance Email withdrawal)
11. **Invite** — Referral code sharing, 10% commission via server-processed `referral_earnings_log` pipeline
12. **Profile** — User stats, settings, admin access button
13. **KYC System** — Account verification form → admin approve/reject → gates multiplayer hub + wallet withdrawal
14. **Tournament** — Weekly cycle, server-computed points from mining_sessions

## PocketBase Schema (https://api.webcod.in)

### Security Model
- **Server-only money writes**: `users` updateRule uses `:isset = false` guards on every money/progression field (`shib_balance`, `power_tokens`, `vip_level`, `referral_balance`, `referral_earnings`, `active_booster_multiplier`, `booster_expires`, `current_mining_session`, `hit_tickets`, `daily_streak`, `last_daily_claim`, `weekly_tournament_points`, `total_claims`, `total_wins`, `is_blacklist_1`, `is_blacklist_2`). Client direct PB SDK cannot modify these.
- **`users.createRule`**: signup can only start with exact starter values (shib=100, pt=500).
- **`mining_sessions` + `referral_earnings_log`**: create/update rules = null (admin/server token only).
- **`game_score`**: all API rules null (server/admin-token only writes).
- **`settings`**: `listRule/viewRule = ""` (public read for ad IDs, brevo key).
- **`otp_codes`**: users manage their own via `user = @request.auth.id`.

### users collection
- `firebase_uid`, `email`, `display_name`, `referral_code`, `referred_by`
- `shib_balance`, `power_tokens`, `total_claims`, `total_wins`
- `is_verified` (bool)
- `active_booster_multiplier` (number), `booster_expires` (text)
- `vip_level` (number), `kyc_status` (text), `kyc_full_name`, `kyc_country`, `kyc_country_code`, `kyc_phone`, `kyc_binance_email`, `kyc_bep20_address`
- `is_blacklist_1`, `is_blacklist_2`, `blacklist_1_notified`, `blacklist_1_notified_at`
- `session_token` (text), `submission_count` (number)

### mining_sessions collection
- `user` (relation to users), `start_time` (date), `claimed_amount` (number), `booster_multiplier` (number), `is_verified` (bool), `ip_address` (text)
- Status derived from `claimed_amount === 0`; voided sessions have `claimed_amount = -1`

### referral_earnings_log collection
- `referrer_id` (text), `claimer_id` (text), `amount` (number), `processed` (bool)
- Server-only writes; referrer reads via `referrer_id = @request.auth.id`

### settings collection
- All admin-configurable values: mining rates, booster costs, ad IDs, withdrawal tiers
- `brevo_api_key` (REST key `xkeysib-...`) — app sends Delete Account OTP emails directly
- `strict_match_enforcement` (bool, default false) — solo game claim strictness

### game_score collection
- `user` (relation→users), `user_id` (text), `match_id` (text), `raw_score` (number), `final_tokens` (number), `is_double` (bool), `match_status` (text: active/started/completed/expired/blacklisted)

### verification_requests collection
- `user` (relation→users), `full_name`, `country`, `country_code`, `phone`, `binance_email`, `bep20_address`, `status` (SELECT: 'Under Review'|'Verified'|'Rejected'), `reject_reason`

## Auth Flow
1. New user → Firebase signup → `sendEmailVerification()` → verify-email screen
2. Existing user login → Firebase signin → `getUser(firebaseUid)` → if `is_verified=true` → tabs; else → verify-email screen
3. OTP verification → `verifyOtp(email, code)` → PB patches `is_verified=true` → `syncWithServer()` → tabs shown
4. Sign Out → `router.replace('/auth')`

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
- Controls: Mining rate, entry fee, booster costs, AdMob IDs, withdrawal tiers, KYC approvals

## Theme
Gold (#F4C430) + Neon Orange (#FF6B00) on deep dark (#0A0A0F)

## File Structure
- `lib/firebase.ts` — Firebase SDK init
- `lib/api.ts` — API calls + types; **fail-closed**: money routes have NO PB direct-write fallback
- `lib/query-client.ts` — QueryClient + `getApiUrl()`
- `context/AuthContext.tsx` — Firebase + PB auth; server-only referral processing
- `context/WalletContext.tsx` — Balances + transactions; fail-closed (no PB fallback)
- `context/MiningContext.tsx` — Mining timer + boosters; fail-closed (no PB fallback)
- `context/AdminContext.tsx` — Admin settings fetch
- `context/TournamentContext.tsx` — Tournament state
- `app/auth.tsx` — Login/Signup
- `app/verify-email.tsx` — Email verification + OTP
- `app/admin.tsx` — Admin control panel
- `app/verify-account.tsx` — KYC submission form
- `app/(tabs)/index.tsx` — Home/Mining
- `app/(tabs)/games.tsx` — Games hub
- `app/solo-play.tsx` — Knife Hit / Weapon Master solo game
- `app/hub/index.tsx` — Arcade PvP hub (6 games)
- `app/hub/arcade-lobby.tsx`, `app/hub/arcade-match.tsx` — Arcade matchmaking
- `public/game/Knife hit Template/` — Knife Hit assets
- `public/{flappy,fruitcut,stack,2048,iceblock,color}/` — Arcade game exports
- `server/routes.ts` + `shib-mine-backend/server/routes.ts` — Express routes (byte-mirrored)

## CRITICAL: Backend Architecture
- **Express (port 5000)** runs in Replit dev; production = VPS/Railway at `backend.webcod.in`.
- **Fail-closed security model**: All money-modifying operations (mining start/claim, booster activate, VIP upgrade, referral claim, withdrawal create, PT spend/add, daily reward, tournament prize) are **Express-only**. The client has **NO PocketBase SDK fallback** for these. If the backend is unreachable, the action fails with a retry message.
- **PB rules lockdown**: The backend boot sequence auto-patches PB collection rules to server-only for money fields (see Security Model above). This runs on every start.
- **Delete Account OTP** — app generates OTP → stores in PB `otp_codes` via SDK → fetches `brevo_api_key` from PB `settings` → calls `api.brevo.com/v3/smtp/email` directly. Verification reads `otp_codes` directly. No Express route involved.
- **Settings read** — `AdminContext.tsx` tries Express first → falls back to `pb.collection('settings').getList()` (read-only, safe).
- **PB password pattern**: `SHIB_${firebaseUid}_SECURE` — used for direct PB auth token refresh
- **Auth flow**: Firebase → `confirmAndLoadUser` → Express first; PB direct login only for auth token management (non-money)

## Tab Bar Layout
- Custom tabBar in `app/(tabs)/_layout.tsx` renders banner ABOVE tab buttons
- Layout from bottom up: `[safe area] [tab buttons ~56px] [banner ~50px] [screen content]`
- `StickyBannerAd.tsx` exports `InlineBannerAd` and `BANNER_HEIGHT=50`

## Anti-Cheat
- **Accessibility auto-clicker block (Android, APK-only)**: Expo module `modules/auto-clicker-detector/` scans enabled accessibility services + installed packages against blacklist. `SecurityContext.tsx` freezes mining UI when block active. Untestable in sandbox.
- **Solo game server-authoritative scoring**: HMAC-signed match IDs (`uuid.hmac16`) bind match to owner. Claim routes verify signature + row ownership + score ≤ 2× committed. Impossible scores → match blacklisted + account flagged.
- **Referral soft anti-cheat**: 3-tier blacklist (`is_blacklist_1` / `is_blacklist_2`) on suspicious patterns; non-blocking (claim always proceeds).

## Arcade Games (6)
All hosted on `https://webcod.in/<game>/index.html` with `arcade-sdk.js` bridge:
- **Flappy Bounce** — `public/flappy/`, lives null, maxScore 99999, scoreDelta {1,500}, timerSeconds null, readyAfkSeconds 45
- **Fruit Cut** — `public/fruitcut/`, lives 3, maxScore 99999, scoreDelta {120,500}, timerSeconds null, readyAfkSeconds 47
- **Stack Builder** — `public/stack/`, lives 1, maxScore 999, scoreDelta {5,500}, timerSeconds 300, readyAfkSeconds 60
- **2048** — `public/2048/`, lives 1, maxScore 20000, scoreDelta {1024,500}, timerSeconds 300, readyAfkSeconds 60
- **Ice Block** — `public/iceblock/`, lives 1, maxScore 9999, scoreDelta {150,500}, timerSeconds 300, readyAfkSeconds 60
- **Color Rush** — `public/color/`, lives 1, maxScore 5000, scoreDelta {5,500}, timerSeconds null (ENDLESS), readyAfkSeconds 60

**Clock ordering invariant** (~match start): adapter stage-1 45s < RN afkMs 50s < server readyAfkSeconds 60s.

**Deploy**: zip `public/<game>/` → manual upload to webcod.in; Railway redeploy when specs change.

## KYC System
- **Gating**: Unverified users blocked from Multiplayer Hub + Wallet withdrawal; `KycGateModal` on entry
- **Flow**: `verify-account.tsx` form → server submit → admin approve/reject/unverify
- **Withdrawal**: Amount-only form; destination read-only from KYC record; Binance Email only when `kycCountry === 'India'`
- **Limits**: 3 submission attempts max; per-field duplicate detection (Phone/Binance Email/BEP20)
- **Status sync**: `/api/app/verification/status/:pbId` self-heals `users.kyc_status` from latest request row

## Security Invariants (Post-Lockdown)
- Booster multiplier whitelist: `[1, 2, 4, 6, 10]`. Anything else → 400 + `[SECURITY]` log.
- VIP upgrade server-verified: route recomputes requirements and writes with admin token.
- Referral claiming server-only: client shows pending sum read-only; server processes `referral_earnings_log` entries atomically.
- Tournament points: server-computed from `mining_sessions`; client mirrors to `tournament_participants` (cosmetic only).
- `SESSION_SECRET` required for HMAC match signing. Boot warns if unset.

## User Preferences
- **NO design/UI work by the agent** (declared July 11, 2026): Do NOT touch design or UI files unless user explicitly reverses this. Agent scope is strictly logic and backend tasks.

## Deploy Notes
- **VPS**: `scripts/build-vps.sh` → `dist/shib-backend-vps.zip` (esbuild single-file bundle). Cutover: VPS setup → TLS → lower TTL → DNS flip → verify → kill Railway.
- **Railway**: `git push github main` auto-deploys (legacy path).
- **Arcade games**: Manual zip upload to webcod.in after any `public/<game>/` change.
- **APK-only features**: Native ads, auto-clicker detector — verify in EAS build.
