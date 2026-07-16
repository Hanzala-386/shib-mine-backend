---
name: PB collection field-list key (schema vs fields)
description: This app's shared PocketBase (api.webcod.in) exposes collection fields under `col.schema`, not `col.fields`; schema-patch helpers that read only `fields` silently no-op.
---

# PB exposes collection fields under `schema`, not `fields`

The shared PocketBase at `api.webcod.in` is an older build: `GET /api/collections/<name>` returns the field list under **`col.schema`**, and `col.fields` is `undefined`. Select-field allowed values are nested under `field.options.values` (not the flattened `field.values` of newer PB).

**Why:** a boot-time helper meant to append a value to the `withdrawals.method` select read `col.fields || []` → got `[]` → found no `method` field → returned silently. It "succeeded" (no error, no log line) but changed nothing, so Hit-Ticket redeem kept failing PB's select validation ("Redemption failed"). Cost real debugging because the failure was invisible and the code looked "complete".

**How to apply:** any collection-schema helper (add field / extend a select / patch rules) must read `col.schema || col.fields || []` and PATCH back under the SAME key the instance uses: `Array.isArray(col.schema) ? { schema } : { fields }`. The proven working helpers in `server/routes.ts` (the `purchased_items` field adder, tournament `ensure*` steps) all use `col.schema || col.fields`. When a schema-ensure step logs nothing at all, suspect a silent early-return on the wrong key — verify the live collection directly (auth as admin, GET the collection) rather than trusting "code-complete".

# Field TYPE cannot be changed in-place — use a 3-phase swap

This PB build also hard-rejects changing an existing field's type (schema PATCH → 400 `validation_field_type_change`, "Field type cannot be changed"), even when the field id is preserved.

**Why:** converting `verification_requests.status` text→select by PATCHing the same field id failed with that 400; the boot log warning was easy to miss and the field silently stayed text.

**How to apply:** to change a field's type: (A) add a temp field of the NEW type, (B) copy/map every row's value into it (collect all ids first — never paginate while mutating), (C) one schema PATCH that omits the old field (deletes it) and renames the temp field (keeping its id — renames ARE allowed) to the original name. Make it idempotent (skip when already converted; resume partial runs). Do the swap in a write-quiet window: rows written between B and C lose their value when the old column drops. Select fields silently drop stored values not in their options list — map values BEFORE the type takes effect.
