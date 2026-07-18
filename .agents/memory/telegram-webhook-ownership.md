---
name: Telegram webhook ownership — prod must own it
description: Why the Telegram bot goes silent when dev owns the webhook, and how to diagnose secret-mismatch silence on prod.
---

# Rule: the production server must own the Telegram bot webhook

A Telegram bot has exactly ONE webhook. If the Replit dev server registers it (its
boot used to do this by default), the webhook points at the dev domain — which
**sleeps when the workspace is idle**. Every real user's `/start` then gets
`Wrong response from the webhook: 404 Not Found` (visible in `getWebhookInfo.last_error_message`)
and the bot is completely silent while the app polls forever.

**Why:** exactly this happened in production testing (Jul 18 2026) — the bot worked only
while an agent session kept the workspace awake.

**How to apply:**
- Dev must never auto-register the webhook; registration in the sandbox is opt-in via
  `TELEGRAM_DEV_WEBHOOK=1` (or an explicit `TELEGRAM_WEBHOOK_BASE`).
- `getWebhookInfo` is the first diagnostic: check `url`, `pending_update_count`,
  `last_error_message` + `last_error_date` (compare against current UTC — a recent
  timestamp means the user's live attempt is failing right now).

# Silent-ignore trap: webhook host missing the bot token env

The webhook handler validates `X-Telegram-Bot-Api-Secret-Token` (derived by hashing the
bot token). If the prod host has the ROUTES deployed but the `TELEGRAM_BOT_TOKEN` env
var missing, it computes a different secret → every genuine update is answered 200 but
**silently discarded** (and sendMessage couldn't work anyway). No error appears anywhere.

**Diagnosis without server logs:** mint a real session via the prod start route, then POST a
fake Telegram update (correct secret header, fake chat id, `/start <token>` text) to the
prod webhook and check whether the PB session row gets `chat_id` bound. Bound = token
present; untouched = env var missing on the host.
