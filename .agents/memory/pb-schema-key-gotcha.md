---
name: PB collection field-list key (schema vs fields)
description: This app's shared PocketBase (api.webcod.in) exposes collection fields under `col.schema`, not `col.fields`; schema-patch helpers that read only `fields` silently no-op.
---

# PB exposes collection fields under `schema`, not `fields`

The shared PocketBase at `api.webcod.in` is an older build: `GET /api/collections/<name>` returns the field list under **`col.schema`**, and `col.fields` is `undefined`. Select-field allowed values are nested under `field.options.values` (not the flattened `field.values` of newer PB).

**Why:** a boot-time helper meant to append a value to the `withdrawals.method` select read `col.fields || []` → got `[]` → found no `method` field → returned silently. It "succeeded" (no error, no log line) but changed nothing, so Hit-Ticket redeem kept failing PB's select validation ("Redemption failed"). Cost real debugging because the failure was invisible and the code looked "complete".

**How to apply:** any collection-schema helper (add field / extend a select / patch rules) must read `col.schema || col.fields || []` and PATCH back under the SAME key the instance uses: `Array.isArray(col.schema) ? { schema } : { fields }`. The proven working helpers in `server/routes.ts` (the `purchased_items` field adder, tournament `ensure*` steps) all use `col.schema || col.fields`. When a schema-ensure step logs nothing at all, suspect a silent early-return on the wrong key — verify the live collection directly (auth as admin, GET the collection) rather than trusting "code-complete".
