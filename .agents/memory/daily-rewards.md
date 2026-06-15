---
name: Daily Rewards System
description: 7-day streak daily reward feature — schema, server routes, React Native screen, admin controls, APK fallback
---

## What was built
- `daily_streak` (number) + `last_daily_claim` (text) fields on users collection
- 8 settings fields: `daily_reward_day1_shib` … `daily_reward_day7_pt` (snake_case in PB, camelCase in AppSettings)
- `daily_claims` collection (audit log, admin-only rules, created via server admin token)
- `GET /api/app/daily/status/:pbId` — returns streak, activeDay, canClaim, nextClaimAt, serverTime, rewards
- `POST /api/app/daily/claim/:pbId` — server-authoritative claim: validates server time, applies reward, writes audit log
- `app/(tabs)/daily.tsx` — 3+3+1 grid (days 1-3, days 4-6, day 7 grand full-width); glow pulse via `Animated.loop` on `activeDay` change; countdown synced via `serverOffset = serverTime - Date.now()`
- Daily tab added to all three layout paths (ClassicTabLayout, NativeTabLayout, TAB_META dict)
- Admin panel "Daily Reward Amounts" section

## Streak logic (same on server + client)
- `diff >= 48h` OR no claim → reset to activeDay=1, canClaim=true (missed a day or first time)
- `streak >= 7 && diff >= 24h` → new cycle, activeDay=1, canClaim=true
- `streak >= 7 && diff < 24h` → all claimed, activeDay=7, canClaim=false (waiting for reset)
- `diff >= 24h` → canClaim=true, activeDay=streak+1
- `diff < 24h` → canClaim=false, activeDay=streak+1
- On successful claim: `newStreak = claimDay` (streak = number of consecutive days in current cycle)

## APK fallback
- Status: `fetchStatusDirect(pbId, fallbackRewards)` reads PB directly, computes status client-side using same logic
- Claim: `claimDirect(pbId, fallbackRewards)` reads user, validates timing, writes PB update, creates daily_claim record
- Client uses `serverOffset = serverTime - Date.now()` to adjust countdown timer for clock skew

**Why:** Express is dev-only; APK never reaches localhost:5000.

## Day card states
- `d < activeDay` → CLAIMED (faded, gold checkmark badge)
- `d === activeDay` → ACTIVE (gold/orange animated border glow, pulsing background)
- `d > activeDay` → LOCKED (dark bg, lock icon, reward shows "???")
