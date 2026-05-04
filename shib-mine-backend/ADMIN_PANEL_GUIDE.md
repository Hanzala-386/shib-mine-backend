# Shiba Hit — Admin Panel Technical Guide

> **Audience:** Developer building the custom Admin Panel UI.  
> **Scope:** Database schema, query patterns, and API access for the three analytics history tables: Sessions, Gaming, and Referrals.

---

## 1. PocketBase Access

All collections are stored in PocketBase at **`https://api.webcod.in`**.

The Admin Panel must use the **PocketBase Admin token** (not a regular user token). Obtain it by calling:

```
POST https://api.webcod.in/api/admins/auth-with-password
Content-Type: application/json

{ "identity": "<PB_ADMIN_EMAIL>", "password": "<PB_ADMIN_PASSWORD>" }
```

The response `token` field is a JWT. Include it on every subsequent request:

```
Authorization: <token>
```

Admin tokens have unrestricted access to all collections. Refresh it every 30 minutes using the same endpoint (or check expiry).

---

## 2. Sessions History

### Collection: `session_logs`

Created automatically by the Express server on startup. One record per mining session claim (including fraud attempts).

| Field              | Type   | Description                                                  |
|--------------------|--------|--------------------------------------------------------------|
| `id`               | string | PocketBase auto-generated record ID                         |
| `user`             | string | `pbId` of the user (matches `users.id`)                     |
| `session_type`     | string | `"1x"`, `"2x"`, `"4x"`, `"6x"`, `"10x"`, or `"fraud"`     |
| `income`           | number | SHIB reward earned (0 for fraud sessions)                   |
| `booster_multiplier` | number | Raw multiplier (1, 2, 4, 6, 10 — 0 for fraud)            |
| `duration_seconds` | number | Duration of the mining session in seconds                   |
| `created`          | string | ISO timestamp, auto-set by PocketBase                       |

### Query: All sessions for a user (sorted newest first)

```
GET /api/collections/session_logs/records
  ?filter=user="<pbId>"
  &sort=-created
  &perPage=50
```

### Query: Per-type aggregation for a user (for the summary table)

Fetch all records and aggregate client-side or in the admin backend:

```js
const records = await pb.collection('session_logs').getFullList({
  filter: `user="${pbId}"`,
});

const summary = {};
for (const r of records) {
  if (!summary[r.session_type]) summary[r.session_type] = { count: 0, totalIncome: 0 };
  summary[r.session_type].count++;
  summary[r.session_type].totalIncome += r.income;
}
// summary = { "1x": { count: 12, totalIncome: 0.834 }, "2x": { ... }, "fraud": { ... } }
```

### Query: Grand totals for a user

Also derived from aggregating session_logs:
```js
const totalSessions  = records.filter(r => r.session_type !== "fraud").length;
const fraudSessions  = records.filter(r => r.session_type === "fraud").length;
const grandTotalIncome = records.reduce((sum, r) => sum + (r.income || 0), 0);
```

### Query: Global session stats (all users)

```
GET /api/collections/session_logs/records?perPage=500&sort=-created
```

Aggregate by `session_type` across all users to get platform-wide stats.

---

## 3. Gaming History

### Collection: `game_logs`

One record per knife-hit game completed (either simple claim or 2× rewarded ad claim).

| Field         | Type    | Description                                               |
|---------------|---------|-----------------------------------------------------------|
| `id`          | string  | PocketBase auto-generated record ID                       |
| `user`        | string  | `pbId` of the user                                        |
| `raw_score`   | number  | Game score (base, before any multiplier)                  |
| `is_double`   | boolean | `true` = 2× rewarded-ad claim; `false` = simple claim    |
| `final_tokens`| number  | PT actually credited to the user's balance                |
| `created`     | string  | ISO timestamp, auto-set by PocketBase                     |

### Query: All game sessions for a user

```
GET /api/collections/game_logs/records
  ?filter=user="<pbId>"
  &sort=-created
  &perPage=50
```

### Query: Per-user gaming income summary

```js
const records = await pb.collection('game_logs').getFullList({ filter: `user="${pbId}"` });
const simpleClaims = records.filter(r => !r.is_double);
const doubleClaims = records.filter(r => r.is_double);

const summary = {
  totalGames:        records.length,
  simpleClaims:      simpleClaims.length,
  simpleIncome:      simpleClaims.reduce((s, r) => s + r.final_tokens, 0),
  doubleClaims:      doubleClaims.length,
  doubleIncome:      doubleClaims.reduce((s, r) => s + r.final_tokens, 0),
  totalGamingIncome: records.reduce((s, r) => s + r.final_tokens, 0),
};
```

### Cross-reference: Total Gaming PT from `users` collection

The `users` collection field `total_accumulated_score` is a running total of all PT earned from games (updated on every claim). Use this for fast single-user total lookups without aggregating game_logs:

```
GET /api/collections/users/records/<pbId>?fields=id,total_accumulated_score,total_wins
```

---

## 4. Referral History

### Collection: `referral_history`

One record per referral commission payment. **This is separate from `referral_earnings_log`** (which drives the actual payout pipeline — do not use that for display).

| Field            | Type   | Description                                                 |
|------------------|--------|-------------------------------------------------------------|
| `id`             | string | PocketBase auto-generated record ID                         |
| `referrer_id`    | string | `pbId` of the user who earned the commission                |
| `claimer_id`     | string | `pbId` of the user whose action triggered the commission    |
| `referrer_email` | string | Email of the referrer (denormalized for easy display)       |
| `claimer_email`  | string | Email of the claimer (denormalized for easy display)        |
| `amount`         | number | PT commission credited to the referrer                      |
| `source`         | string | `"mining_claim"` or `"game_reward"`                         |
| `created`        | string | ISO timestamp, auto-set by PocketBase                       |

### Query: All referrals earned by a specific referrer

```
GET /api/collections/referral_history/records
  ?filter=referrer_id="<pbId>"
  &sort=-created
  &perPage=50
```

### Query: All referrals where a specific user was the claimer

```
GET /api/collections/referral_history/records
  ?filter=claimer_id="<pbId>"
  &sort=-created
```

### Query: Total referral income for a user (fast path)

The `users` collection field `referral_earnings` holds the running cumulative total. No need to aggregate `referral_history` for this:

```
GET /api/collections/users/records/<pbId>?fields=id,referral_earnings,referral_balance
```

- `referral_earnings` = total ever earned (lifetime)
- `referral_balance`  = unclaimed amount still pending

### Query: Platform-wide referral table (all referrals)

```
GET /api/collections/referral_history/records?sort=-created&perPage=100
```

---

## 5. Users Collection: Key Fields Reference

The `users` collection has aggregate fields that are useful for quick lookups without joining history tables:

| Field                    | Type   | Description                                              |
|--------------------------|--------|----------------------------------------------------------|
| `shib_balance`           | number | Current SHIB mining balance                              |
| `power_tokens`           | number | Current Power Token balance                              |
| `total_accumulated_score`| number | Lifetime PT earned from games (running total)            |
| `total_claims`           | number | Total mining sessions successfully claimed               |
| `total_wins`             | number | Total game wins                                          |
| `referral_earnings`      | number | Lifetime referral commissions earned (PT)                |
| `referral_balance`       | number | Unclaimed referral commissions pending (PT)              |
| `fraud_attempts`         | number | Strike count (blocked at 3)                              |
| `status`                 | string | `"active"` or `"blocked"`                               |
| `referred_by`            | string | pbId of referrer (if any)                                |
| `referral_code`          | string | This user's unique referral code                         |

---

## 6. Express API Endpoints (for Admin Actions)

The Express backend runs at the same domain as the PB proxy. Admin-facing endpoints:

### Update withdrawal status
```
PUT /api/app/admin/withdrawals/:id
Body: { "status": "completed" | "rejected" | "pending" }
```
- Setting `completed` automatically creates a personal notification for the user.
- Setting `rejected` automatically refunds the SHIB balance.

### List all withdrawals (via PocketBase directly)
```
GET /api/collections/withdrawals/records
  ?sort=-created
  &expand=user
  &perPage=100
```

### Get all users
```
GET /api/collections/users/records?sort=-created&perPage=100
```

---

## 7. Summary: Collections to Display

| Admin Table           | Primary Collection   | Aggregate Field on Users        |
|-----------------------|----------------------|---------------------------------|
| Sessions History      | `session_logs`       | `total_claims`                  |
| Gaming History        | `game_logs`          | `total_accumulated_score`, `total_wins` |
| Referral History      | `referral_history`   | `referral_earnings`             |

---

## 8. Notes for the Admin Developer

1. **All three new collections use admin-only rules** (null for all rules). Only the admin token can read/write them — this is intentional.
2. **`referral_earnings_log`** is an internal payout pipeline collection — do **not** use it for the admin UI. Use `referral_history` instead.
3. **Fraud sessions** appear in `session_logs` with `session_type = "fraud"` and `income = 0`. Filter these out from income totals but display them separately as a fraud indicator.
4. **The `created` field** on all PocketBase records is UTC ISO 8601. Convert to local timezone for display.
5. **Pagination**: use `?perPage=100&page=2` etc. PB returns `totalItems` and `totalPages` in the response envelope.
