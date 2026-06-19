# Memory Index

- [Shiba Hit architecture](shiba-hit-architecture.md) — dual backend (local Express dev-only + Railway); published APK 404s on /api/app/* so every Express call needs a PocketBase SDK fallback.
- [Daily rewards](daily-rewards.md) — floating widget feature; reward amount must share ONE source of truth between grid display and claim payout (daily_claim_settings, not the hardcoded fallback).
- [RN release-APK upload](rn-release-upload.md) — multipart uploads that fetch a data: URI work in Expo Go/web but throw "Network request failed" in the release APK; stream the file {uri,name,type} instead.
