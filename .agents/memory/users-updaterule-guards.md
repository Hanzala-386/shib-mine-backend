---
name: users updateRule guard list
description: Every server-stamped users field must be added to the self-update :isset guard list or clients can forge it
---

The `users` collection updateRule allows `@request.auth.id = id` self-updates (required for APK direct-PB CRUD). Any field that is supposed to be **server-stamped only** (verification flags, KYC status, phone-verified markers, counters) is forgeable by any authenticated client unless it appears in the rule's `@request.data.<field>:isset = false` guard list.

**Why:** Telegram phone verification (Jul 2026) shipped with `wa_verified_phone`/`wa_verified_at` unguarded — architect review caught that a client could self-write the field and bypass verification entirely. The same miss can happen for ANY new server-managed users field.

**How to apply:** Whenever adding a new server-managed field to `users`, append `&& @request.data.<field>:isset = false` to the updateRule in BOTH routes.ts copies (byte-identical) and restart the backend so the rule patch applies to the shared PB. Legit server writes are unaffected — they go through the admin token, which bypasses API rules; clients only read.
