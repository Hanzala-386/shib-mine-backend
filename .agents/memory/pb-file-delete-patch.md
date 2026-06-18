---
name: PB file-delete-on-PATCH silent failure
description: Why you must never combine file deletion with a status-only PATCH in PocketBase multipart requests.
---

## Rule
Never include a `fieldname-` (file-delete) field in the same multipart PATCH that updates record status or other non-file fields.

## Why
When PocketBase processes a multipart PATCH that includes both a file-delete directive (`proof_screenshot-`) and a normal field update (`status`, `admin_notes`), the request can fail silently if the filename doesn't exactly match what PB has stored. The response returns an empty object (no `code` field), but the record's fields are **not updated** — the status stays `pending` and the record appears to vanish from admin views that filter by status. Because there is no HTTP error, the Express handler returned `success: true` while the DB was unchanged.

## How to apply
- Approve and reject handlers: only PATCH `status` and `admin_notes` in the same request. Never include `proof_screenshot-` or any other file-delete directive.
- Screenshot cleanup, if ever needed, must be a separate PATCH call made after the status update is confirmed.
- Always check `patchRes.code` after the PATCH — a truthy `code` value means PB returned an error body even though HTTP status may not reflect it.
