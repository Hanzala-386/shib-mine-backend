---
name: Force-update gate is intentionally fail-OPEN
description: Shiba Hit's force-update system prioritizes anti-lockout over "strict non-bypassable" — don't "fix" it to fail-closed.
---

# Force-update gate is deliberately fail-open (anti-lockout > strict)
Driven by a single-row PocketBase `app_config` collection (public read) with
`current_version`, `min_required_version`, `play_store_url`, `update_message`.
Frontend compares a hardcoded `INSTALLED_APP_VERSION` (constants/version.ts, kept in
sync with app.json) against `min_required_version` via `isVersionLower`; if behind, a
non-dismissible RN Modal overlay shows (Android back trapped via BackHandler→true).

**Why fail-open:** the product's hard requirement is "never lock out currently-live
users." So: (1) the seed sets `min_required_version` = the live build version
(1.0.x) so nobody is blocked until an admin manually raises it; (2) the seed is
one-time / never-overwritten so a server restart can't reset the admin's bump;
(3) the modal fetch is wrapped in try/catch that does NOTHING on failure (offline /
PB down / blocked host → app stays usable). An architect flagged this as "not truly
non-bypassable" — that is intentional, not a bug. Do NOT change it to fail-closed
(blocking on fetch failure) without explicit product sign-off: that would lock out
every offline user and everyone during any PocketBase outage.

**How to apply:** Read the config row deterministically (`sort:'created'`, perPage 1)
so a stray extra row can't silently change the gate. The gate is native-only — skip
on `Platform.OS==='web'` (Play Store path is meaningless on web). To actually force an
update, the admin edits `app_config.min_required_version` in PB to exceed the shipped
`INSTALLED_APP_VERSION`. The old `settings.minimum_version` admin field is superseded
by this and left intact only to avoid scope creep.
