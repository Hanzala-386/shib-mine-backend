# SHIB Mine - Crypto Mining App

## Overview
A gold & neon orange glassmorphism React Native mobile app for mining SHIB cryptocurrency. Users earn SHIB tokens through 60-minute mining sessions and Power Tokens through a Knife Hit mini-game. Built with Firebase Auth + PocketBase backend and Expo Router.

## Architecture
- **Frontend**: Expo Router (file-based routing), React Native
- **Backend**: Express.js on port 5000 (server/routes.ts) + PocketBase at https://api.webcod.in
- **Auth**: Firebase Authentication (Email/Password) + Custom OTP email verification
- **State**: React Context (Auth, Wallet, Mining, Admin)

## Key Features
1. **Firebase Auth + OTP Verification** — Email/password signup/signin with 6-digit OTP gate; `POST /api/app/auth/send-otp` and `POST /api/app/auth/verify-otp`; verified via PB `is_verified` field
2. **OTP Screen** — 6 individual digit inputs, auto-advance, auto-submit, shake animation on error, 60s countdown for resend, Forgot Password link
3. **Mining** — 60-minute timer, server-persisted start/claim with booster_multiplier stored in session; 24 PT entry fee
4. **Speed Boosters** — 2x/4x/6x/10x, time-limited 1 hour, single active at a time, countdown timer on active card; decoupled from mining start
5. **Server-Side Claim Verification** — Server computes expected reward from rate × 3600 × booster_multiplier; client reward validated within 5% tolerance
6. **Rolling Counter** — Smooth animated SHIB balance display during mining
7. **Knife Hit Game** — Tap-to-throw game, win 3 PT per round
8. **Admin Panel** — Restricted to hanzala386@gmail.com, controls all economic settings
9. **Wallet** — SHIB balance & Power Token tracking (BEP-20 + Binance Email withdrawal)
10. **Invite** — Referral code sharing, 10% server-side commission
11. **Profile** — User stats, settings, admin access button

## PocketBase Schema (https://api.webcod.in)
### users collection
- `firebase_uid`, `email`, `display_name`, `referral_code`, `referred_by`
- `shib_balance`, `power_tokens`, `total_claims`, `total_wins`
- `is_verified` (bool) — OTP-based email verification gate
- `otp_code`, `otp_expires` — temp OTP storage
- `active_booster_multiplier` (number), `booster_expires` (text) — booster state

### mining_sessions collection
- `user_id`, `start_time`, `duration_ms`, `status`, `expected_reward`
- `booster_multiplier` (number) — stored at mine start, used at claim

### settings collection
- All admin-configurable values: mining rates, booster costs, ad IDs, withdrawal tiers

## Auth Flow
1. New user → Firebase signup → save pending data in AsyncStorage → `sendOtp(email)` → OTP screen
2. Existing user login → Firebase signin → `getUser(firebaseUid)` → if `is_verified=true` → tabs; else → `sendOtp(email)` → OTP screen
3. OTP verification → `verifyOtp(email, code)` → PB patches `is_verified=true` → `syncWithServer()` → tabs shown

## Key Bug Fixed
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
- `app/(tabs)/games.tsx` — Knife Hit game
- `app/(tabs)/invite.tsx` — Referral system
- `app/(tabs)/wallet.tsx` — Wallet with BEP-20 + Binance Email withdrawal
- `app/(tabs)/profile.tsx` — Profile with admin access
- `server/routes.ts` — All Express routes including OTP, boosters, mining

## Ports
- Frontend (Expo): 8081
- Backend (Express): 5000
