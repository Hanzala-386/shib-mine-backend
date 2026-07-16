---
name: Referral commission pipeline
description: How the 10% mining referral commission actually flows in prod, the ID-vs-code referred_by trap, and PB rule constraints on cross-user reads
---

# Referral commission pipeline (10% of mining claims ONLY)

- **The production path is CLIENT-side**: `pbClaimMining` (MiningContext) → claimer writes `referral_earnings_log` → referrer's device runs `processPendingReferralEarnings` on login and self-credits `referral_balance`/`referral_earnings`. The Express `/api/app/mine/claim` commission block exists but the APK claims PB-direct, so it never runs in prod (that's why `referral_history` has zero `source=mining_claim` rows).
- **`users.referred_by` holds EITHER the referrer's record ID (~98% of referees) OR their referral_code.** Any lookup that filters only `referral_code="<referred_by>"` silently fails for ID-form referees → commission never paid. Always resolve with `id="X" || referral_code="X"`.
- **Why:** signup paths diverged historically; live sample Jul 2026: 492/500 referees ID-form.
- **How to apply:** any new code resolving a referrer from `referred_by` (client or server) must match both forms; server route already does id-then-code.
- **PB rule trap:** `users.viewRule = "@request.auth.id = id"` — under a USER token, `getOne(otherUserId)` is 403/404. Cross-user resolution must go through a filtered LIST query (`listRule = @request.auth.id != ""`). Validate any "fix" under a real user token, not the admin token.
- **Game rewards are excluded by design** (server comment blocks re-adding). Historic `source=game_reward` rows in `referral_history` (stopped 2026-06-30) came from an old deployed backend — current code cannot produce them; don't treat them as an active leak.
- **Open economic decision:** retroactive backfill of years of missed commissions for ID-form referees was deliberately NOT done without user approval.
- Live-validation recipe: `.local/referral_validation.mjs` — auth as both test users with real user tokens (password pattern documented in replit.md), exercise the exact client logic, before/after snapshots.
