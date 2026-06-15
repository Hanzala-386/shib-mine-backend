---
name: Daily Rewards System
description: 7-day streak daily reward — floating widget + auto-popup architecture, server-time security, APK fallback
---

## Architecture (final)
- NO nav tab. The entire feature lives in `components/DailyRewardWidget.tsx`, mounted globally in `app/_layout.tsx` alongside SupportWidget and TournamentBannerPopup.
- `app/(tabs)/daily.tsx` exists only as a `<Redirect href="/(tabs)" />` (Expo Router requires a file if referenced by layout; hidden via `href: null` in Tabs.Screen).
- Widget states: `hidden` → `float` → `popup` (auto-triggered when canClaim=true, 1.6s delay on mount).

## Security: server-time only
- `canClaim` flag is fetched from server (`api.getDailyStatus` → Express → PB); the popup ONLY auto-shows when the server confirms it.
- Countdown display uses `serverOffset = serverTime - Date.now()` for visual accuracy, but popup re-trigger on countdown=0 re-fetches from server — never unlocks on device clock alone.
- APK direct `claimDirect` fallback: creates a `daily_claims` PB record FIRST → reads `record.created` (server-generated) → uses that ISO string as `last_daily_claim`. Device clock is never written to PB.

## UX flow
1. Mount → float → after 1.6s fetch status → if canClaim: auto-popup with spring animation
2. Claim → success toast inside popup → 2.2s → popup slides away → float badge cleared
3. Float tap → popup opens (CLAIM button hidden when !canClaim, timer shown instead)
4. Poll every 5 min → re-popup if newly claimable
5. Countdown=0 → server re-fetch → popup if canClaim

## Day imagery
- ShibStack: gradient gold coin circles, `count` prop (1→2→3) for stacking effect, size increases by day pair
- PTStack: overlapping Ionicons flash bolts at decreasing opacity for non-center bolts
- Day 7 grand card: both icons + amounts in a wide row layout with ⭐ GRAND REWARD badge

## Floating icon
- PanResponder drag, snaps to nearest screen edge on release (same pattern as SupportWidget)
- Pulsing scale animation (`Animated.loop`) when floatReady=true (reward available)
- Orange badge dot (!) shown on float when reward ready

**Why no nav tab:** User explicitly requires premium UX — floating widget avoids cluttering the tab bar.
