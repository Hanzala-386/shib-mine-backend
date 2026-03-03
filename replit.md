# SHIB Mine - Crypto Mining App

## Overview
A gold & neon orange glassmorphism React Native mobile app for mining SHIB cryptocurrency. Users earn SHIB tokens through 60-minute mining sessions and Power Tokens through a Knife Hit mini-game.

## Architecture
- **Frontend**: Expo Router (file-based routing), React Native
- **Backend**: Express.js on port 5000
- **Storage**: AsyncStorage (local persistence per user)
- **State**: React Context (Auth, Wallet, Mining)

## Key Features
1. **Auth Flow** — Email/password sign up & sign in, referral code on signup
2. **Mining** — 60-minute timer with booster options (2x/4x/6x/10x speed)
3. **Knife Hit Game** — Throw knives at rotating log, earn 3 PT per win
4. **Wallet** — SHIB balance & Power Token tracking with transaction history
5. **Invite** — Referral code sharing via native Share API
6. **Profile** — User stats and settings

## Navigation
5-tab layout: Home, Games, Invite, Wallet, Profile
- NativeTabs with liquid glass on iOS 26+
- Classic Tabs with BlurView for older iOS
- Ionicons for Android/Web

## Theme
Gold (#F4C430) + Neon Orange (#FF6B00) on deep dark (#0A0A0F)

## Screens
- `app/auth.tsx` — Login/Signup
- `app/(tabs)/index.tsx` — Home/Mining
- `app/(tabs)/games.tsx` — Knife Hit
- `app/(tabs)/invite.tsx` — Referral
- `app/(tabs)/wallet.tsx` — Wallet
- `app/(tabs)/profile.tsx` — Profile

## Contexts
- `context/AuthContext.tsx` — User auth + AsyncStorage
- `context/WalletContext.tsx` — SHIB + Power Token balances + transactions
- `context/MiningContext.tsx` — Mining session timer + state

## Ports
- Frontend (Expo): 8081
- Backend (Express): 5000

## Dependencies
- expo-clipboard (for referral code copy)
- expo-linear-gradient, expo-haptics, expo-blur, expo-glass-effect
- react-native-reanimated (animations)
- @expo/vector-icons (Ionicons, MaterialCommunityIcons)
