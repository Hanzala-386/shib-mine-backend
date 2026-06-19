---
name: VIP wallet lock & refIncome metric
description: Design rules for the VIP tier wallet-lock and the refIncome upgrade metric — what is gated, what is not, and where every new withdrawal path must enforce the lock.
---

# VIP wallet lock & refIncome metric

## refIncome (5th VIP upgrade metric)
- Sourced from `users.referral_earnings` as `Number(referral_earnings) || 0`; lives in `shared/vip.ts` (`VipRequirement`/`VipMetrics`/`VIP_REQUIREMENTS`).
- It is a **hard upgrade gate** (checked in `meetsVipRequirements`/`unmetVipRequirements`) and must be populated in ALL THREE metric paths: both Express `computeVipMetrics` + `lib/api.ts` `pbComputeVipMetrics`.
- **Deliberately EXCLUDED from demotion / anti-drain.** `highestBalanceEligibleTier` stays balance-only.
  **Why:** demotion exists to claw back tiers when a user drains their *balance*; referral income is monotonic and cannot be "drained", so gating demotion on it would never trigger and only adds confusion.

## Wallet lock
- Locked amount for an active tier = `VIP_REQUIREMENTS[level].balance` (helper `lockedBalanceForVipLevel(level)`; `availableBalanceAfterVipLock(balance, level)`). Level 0 locks nothing.
- The lock is keyed on the user's **actual `vip_level`** (admin-promoted users are locked too) — not on what they "earned".
- The withdrawal check compares the **GROSS** amount (pre-fee) against available, not the net.
  **Why:** the fee leaves the user's wallet too, so the full gross must be covered by available balance or the lock can be undercut.

## Where the lock MUST be enforced (keep in lockstep)
Any new withdrawal path has to apply the same lock or it becomes a bypass:
1. `server/routes.ts` `POST /api/app/withdrawals`
2. `shib-mine-backend/server/routes.ts` (mirror — Railway)
3. `context/WalletContext.tsx` `createWithdrawal` direct-PB fallback (this is the one the shipped APK actually hits)
- Also guard `Number.isFinite(amount) && amount > 0` BEFORE the lock check — otherwise `NaN > available` is `false` and fails open.

## Trust caveat
The APK enforces the lock client-side via the PB SDK fallback (Express is unreachable in prod, and `users` has self-CRUD PB rules). A tampered client could still write `shib_balance`/withdrawals directly. Closing that requires PB-side rules/hooks — out of scope for the lock feature, but note it before claiming the lock is tamper-proof.
