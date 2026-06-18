---
name: Backend trust model (client-supplied pbId + PB self-CRUD)
description: Why Shiba Hit's Express/PB endpoints have no server-side auth, and why "fixing" one endpoint in isolation is wrong.
---

# Shiba Hit backend trust model

Every economic + admin endpoint trusts a client-supplied `pbId` and has **no
server-side auth/admin middleware**. This is intentional and app-wide:

- All `/api/admin/*` routes (tasks, submissions approve/reject, users/vip,
  users/search) are plain `async (req,res)` with no auth check.
- Claim / booster / mining endpoints key all writes off the body `pbId`.
- The PocketBase `users` collection has list/view/create/update/delete rules
  **fully opened** ("APK self-CRUD enabled" logs at boot), so the client writes
  balances / vip_level / promotion fields directly via the PB-direct fallback.
- Published APK gets 404 on every `/api/app/*` and `/api/admin/*` route
  (Railway/Express only run in dev + Railway), so a PB-direct SDK fallback is
  **mandatory** for every server call — that fallback inherently allows self-CRUD.

**Why:** the app deliberately pushes logic client-side with PB as the store;
admin gating is client-side (email allow-list) + the open PB rules. A code
reviewer will flag this as broken access control — it is, in absolute terms.

**How to apply:** do NOT add auth to a single new endpoint (e.g. VIP) in
isolation — it breaks consistency and closes nothing, because the open PB rules
let a modified client write the same fields directly. Treat hardening as a
separate, whole-app decision (server-side identity binding + tightened PB
field rules together), and surface it to the user rather than doing it silently.
New economic features should match the existing pattern (Railway → Express →
PB-direct fallback) unless the user asks to re-architect security.
