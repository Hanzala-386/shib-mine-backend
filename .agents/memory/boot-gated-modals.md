---
name: Boot-gated modals + idempotent PB collection re-locking
description: How Shiba Hit holds the navigator for a boot-time PocketBase audit, and the security rule that every ensure*Collection must re-lock write rules on the existing-collection branch.
---

# Boot-gated modal pattern (announcement banner, and reusable for future gates)
Some popups must be decided BEFORE the main navigator mounts so a slow PocketBase
response can't pop a modal over a live screen (e.g. an active mining session). The
pattern, implemented in `useAnnouncementGate()` + `app/_layout.tsx`:
- A hook runs the PB query + AsyncStorage frequency check during the splash and
  exposes `{ resolved, <data> }`.
- `RootLayoutNav` gates the splash on `booting = isLoading || !resolved` and gates
  the startup `router.replace` effect on `[booting]` (not `[isLoading]`) so the
  navigator is mounted before the route is replaced.
- A timeout (≈6s) calls the resolver with a null result so a dead/slow network can
  never hang the splash forever (fail-open).
- A `settled` flag + an early `if (settled) return;` right after the awaited fetch
  prevents a late response from (a) showing the modal over an already-mounted
  screen, or (b) mutating AsyncStorage after the gate already resolved.

**Why:** the whole point is anti-race — resolve the show/no-show decision during
splash, render the modal on top from frame one if shown.
**How to apply:** post-login routing is handled by AuthContext (`syncWithServer` /
`signOut` call `router.replace`), so the startup-only navigate effect does NOT need
`user`/`firebaseUser` in its deps. AsyncStorage must go through `@/lib/storage`
(platform-safe web shim), never the raw module, so the gate works in web preview.

# Idempotent PB provisioning MUST re-lock write rules on the existing branch
Every `ensure*Collection` on api.webcod.in has two branches: create-new vs
already-exists. The architect flagged that patching only `listRule`/`viewRule` on
the existing branch leaves a pre-existing collection's `createRule`/`updateRule`/
`deleteRule` untouched — so a collection someone created with permissive writes
stays publicly writable forever.
**Why:** public-read collections (announcements, settings, app_config, tasks…) are
tamper targets — open writes let anyone change banners/redirects/economy values.
**How to apply:** on the existing-collection branch, PATCH the FULL rule set every
boot — `listRule:'' , viewRule:'' , createRule:null, updateRule:null, deleteRule:null`
(null = admin-only) — not just the read rules. Apply this to all public-read
ensure* functions, in BOTH `server/tournament.ts` and `shib-mine-backend/server/routes.ts`.
