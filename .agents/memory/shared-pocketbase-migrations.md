---
name: Shared PocketBase migrations
description: Why restarting the dev backend can change the production database
---

- There is ONE shared PocketBase instance (api.webcod.in) used by BOTH the dev Express server and the production Railway backend (backend.webcod.in).
- `setupTournamentSchema` (and sibling schema/rule setup in `server/`) runs on dev backend boot and creates collections / patches API rules directly against that shared PB.
- **Why this matters:** restarting the "Start Backend" workflow in dev mutates the LIVE production database schema and collection rules. Rule relaxations (e.g. an `updateRule` change) take effect for prod users immediately — there is no separate dev DB.
- **How to apply:** Treat any schema/rule edit in `server/tournament.ts` (and similar boot-time setup) as a production migration. Verify the boot-log confirmation line, and weigh cheat-safety before relaxing any `*Rule`.
