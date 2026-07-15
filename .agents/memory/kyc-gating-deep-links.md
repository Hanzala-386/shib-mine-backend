---
name: KYC gating on deep-linkable routes
description: Rules for client-side feature gates on Expo Router routes when auth state hydrates async
---

# KYC / feature gating on deep-linkable Expo Router routes

**Rule 1 — every route in a gated area needs its own mount guard.** Gating only the hub entry point is bypassable: lobby and match screens are deep-linkable routes. The match screen is the money path — it joins the paid queue (stakes PT) in a mount effect, so the gate must block the socket connect itself, not just render a modal.

**Rule 2 — mount guards must CLEAR when verification flips true.** `pbUser` starts null and hydrates async from storage/network (and is transiently nulled in some flows). A guard written as `if (!verified) show()` latches the block modal open for verified users on cold-start deep links. Write `setShow(!verified)` so it clears on hydration.

**Rule 3 — money-path gates must LATCH once true.** The inverse hazard: if a live match socket's effect depends on raw `isVerified`, a transient pbUser re-hydration to null would tear down the socket mid-game. Latch into local state (`if (verified) setOk(true)`), key the connect effect on the latch, and guard so it connects at most once.

**Rule 4 — gate-modal close navigation**: `router.canGoBack() ? router.back() : router.replace('/(tabs)')` — `back()` can no-op on native when the gated route was the deep-link entry with no stack.

**Why:** All four were architect findings or fixes in the KYC verification build (Jul 2026); #1 and #2 shipped as real bugs before review caught them.

**How to apply:** Any time a screen area is gated by async-hydrated auth/verification state — check every deep-linkable route in the area, clear non-money gates on flip, latch money-path gates.
