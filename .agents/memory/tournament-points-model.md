---
name: Tournament points model
description: Which field is authoritative for Shiba Hit weekly tournament standings and payouts
---

- Authoritative source of weekly standings is `users.weekly_tournament_points`, server-computed from `mining_sessions` by `syncUserTournamentPoints`. Both the leaderboard and the end-of-week winner runner (`runEndOfWeek`) read this field.
- `tournament_participants.points` is COSMETIC/secondary — it is only mirrored from `weekly_tournament_points` for display / admin DB readability. It is NOT read for standings, payouts, or winner selection.
- Its `updateRule` is relaxed to `user_id = @request.auth.id` so a client can self-mirror its own points.
  **Why:** this self-update is safe ONLY because the field is non-authoritative; a user editing their own participant points cannot affect real standings or payouts.
- **How to apply:** Never use `tournament_participants.points` for payouts or winner selection. If admins ever need to trust it, make the mirroring server/admin-only and remove the client self-update.
