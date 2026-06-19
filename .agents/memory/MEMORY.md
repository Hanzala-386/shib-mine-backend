# Memory Index

- [Shiba Hit architecture](shiba-hit-architecture.md) — dual backend (local Express dev-only + Railway); published APK 404s on /api/app/* so every Express call needs a PocketBase SDK fallback.
- [Daily rewards](daily-rewards.md) — floating widget feature; reward amount must share ONE source of truth between grid display and claim payout (daily_claim_settings, not the hardcoded fallback).
- [RN release-APK upload](rn-release-upload.md) — multipart uploads that fetch a data: URI work in Expo Go/web but throw "Network request failed" in the release APK; stream the file {uri,name,type} instead.
- [VIP wallet lock & refIncome](vip-wallet-lock.md) — lock = active tier's balance req checked against GROSS withdrawal in all 3 paths; refIncome gates upgrades but is excluded from demotion.
- [Force-update gate](force-update-gate.md) — app_config-driven; intentionally fail-OPEN (anti-lockout > strict); seed once + never overwrite; don't make it fail-closed.
- [Boot-gated modals + PB re-locking](boot-gated-modals.md) — hold navigator for a boot-time PB audit (timeout fail-open + settled flag); every ensure*Collection must re-lock create/update/delete on the existing branch, not just read.
