# SHIB Mine - Crypto Mining App

## Overview
A gold & neon orange glassmorphism React Native mobile app for mining SHIB cryptocurrency. Users earn SHIB tokens through 60-minute mining sessions and Power Tokens through a Knife Hit mini-game. Built with Firebase Auth and Expo Router.

## Architecture
- **Frontend**: Expo Router (file-based routing), React Native
- **Backend**: Express.js on port 5000
- **Auth**: Firebase Authentication (Email/Password + Email Verification)
- **Storage**: AsyncStorage (local persistence per Firebase UID)
- **State**: React Context (Auth, Wallet, Mining, Admin)

## Key Features
1. **Firebase Auth** — Email/password signup/signin with email OTP verification
2. **Verify Email Flow** — Dedicated screen with resend/check verification
3. **Mining** — 60-minute timer with 2x/4x/6x/10x booster options, server-persisted start time
4. **Rolling Counter** — Smooth animated SHIB balance display
5. **Knife Hit Game** — Tap-to-throw game, win 3 PT per round
6. **Admin Panel** — Restricted to hanzala386@gmail.com, controls all economic settings
7. **Wallet** — SHIB balance & Power Token tracking with transaction history
8. **Invite** — Referral code sharing via native Share API, 10% commission logic
9. **Profile** — User stats, settings, admin access button for admin user

## Firebase Config
- Project: shib-mine
- Auth: Email/Password with email verification required

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
- `context/AuthContext.tsx` — Firebase auth state management
- `context/WalletContext.tsx` — SHIB + Power Token balances + transactions
- `context/MiningContext.tsx` — Mining session timer + state
- `context/AdminContext.tsx` — Admin settings (fetched from AsyncStorage)
- `app/auth.tsx` — Login/Signup with Firebase
- `app/verify-email.tsx` — Email verification screen
- `app/admin.tsx` — Admin control panel
- `app/(tabs)/index.tsx` — Home/Mining with rolling counter
- `app/(tabs)/games.tsx` — Knife Hit game
- `app/(tabs)/invite.tsx` — Referral system
- `app/(tabs)/wallet.tsx` — Wallet with transactions
- `app/(tabs)/profile.tsx` — Profile with admin access

## Ports
- Frontend (Expo): 8081
- Backend (Express): 5000

## Ad Placeholders
- AdMob Banner: shown as placeholder at bottom of home screen
- Unity Interstitial: triggered before mining start (UI only - native SDK needed)
- AdMob Rewarded: doubling tokens in game (UI only - native SDK needed)
