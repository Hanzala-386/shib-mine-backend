---
name: PB collection create two-step
description: api.webcod.in PocketBase requires schema (not fields) and rejects rule fields in the creation POST — rules must be PATCHed separately.
---

## Rule
When creating a new PocketBase collection at api.webcod.in via `pbHttp("POST", "/api/collections", ...)`:
1. Use `schema: [...]` (NOT `fields: [...]`) — the instance runs an older PB version that only accepts `schema`.
2. Do NOT include `listRule`, `viewRule`, `createRule`, `updateRule`, `deleteRule` in the POST body — the older PB version rejects the creation with `{"data":{"schema":{"code":"validation_required","message":"Cannot be blank."}}}` when rules are present.
3. After a successful creation (check `createResult.id`), PATCH the rules in a separate call.

## Why
api.webcod.in runs an older PocketBase version. Including rule fields alongside `schema` causes PocketBase to return a confusing 400 error that makes the entire schema appear blank. This was confirmed by comparing the failing `solo_game_config` creation against working collections (`referral_earnings_log`, `deleted_emails`) which all POST schema-only and PATCH rules separately.

## How to apply
```ts
const created = await pbHttp("POST", "/api/collections", {
  name: "my_collection",
  type: "base",
  schema: [ { name: "field_name", type: "text", required: true } ],
}, token);
if (created.id) {
  await pbHttp("PATCH", `/api/collections/${created.id}`, {
    listRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
  }, token);
}
```

Check existence by `!check.id` (not `check.code`) — a successful GET returns the collection object without a `code` field; a 404 returns `{code: 404, ...}`.
