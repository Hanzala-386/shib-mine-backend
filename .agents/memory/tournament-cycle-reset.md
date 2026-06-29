---
name: Tournament cycle launch & stale-state reset
description: How a clean tournament cycle must be launched server-side, and the paginate-while-mutating bug that leaves stale auto-join / score-leak state.
---

# Launching a clean cycle (server-side only, no APK rebuild)

The shipped APK's join gate and score display read **user-level fields**, not just the participant table:
- `users.tournament_joined` (bool) → drives the Register/Join gate. If left `true`, the user appears **auto-joined** (gate bypassed).
- `users.weekly_tournament_points` (number) → drives displayed score. If left >0, the user sees a **stale score leak**.

The admin panel reads the participant table (cycle-scoped), so admin can correctly show 0/empty while the APK still leaks — the two surfaces read different sources.

**To launch a clean cycle entirely from PocketBase + server:**
1. Zero the user fields for everyone: `{ tournament_joined: false, weekly_tournament_points: 0 }`.
2. Activate ONE cycle by editing the **newest** `tournament_config` row *in place* (client reads `getList(1,1,{sort:'-created'})` — lib/api.ts + TournamentContext): set `is_active=true`, a **fresh `cycle_id`**, `start_time = now`, future `end_time`, and clear `payout_finalized_cycle`/`payout_finalized_bucket`.
3. **`start_time = now` is critical**: client score recompute sums `mining_sessions` where `updated >= start_time` (returns 0 if `!is_active` or past end). A baseline of `now` ⇒ everyone starts at 0 and only grows from real mining.
4. Editing the newest row in place (vs. creating a new row) **preserves the banner file** — avoids multipart download+re-upload of the PB file field.

**Why:** prod symptoms "auto-join" + "tens-of-thousands stale points" came from these user fields, not the participant table.

# The reset bug to avoid (paginate-while-mutating)

`runEndOfCycle`'s user-reset loop advanced `page++` while patching rows. Each patched row leaves the filter, so the result set shrinks under the cursor and `page++` **skips ~half the remaining rows every iteration** — leaving hundreds of users un-reset.

**Rule:** never paginate with an incrementing page index while mutating the rows you're paging over. Use one of:
- **Drain page 1**: repeatedly read `page=1` of the matching filter, patch that batch, repeat until empty (add an `ok===0` guard to avoid an infinite loop if a whole batch fails).
- **Read-all-ids-then-mutate**: collect every id first (stable read), then mutate (the pattern `wipeAllParticipants` already uses).

Use an **OR filter** (`tournament_joined=true || weekly_tournament_points>0`) so a row with stale points but `joined=false` is still caught.

**How to apply:** any PB bulk patch/delete over a filtered set in server/tournament.ts (or similar) must follow one of the two safe patterns above.

# Operational note
The dev Express backend (`server/tournament.ts`) is the **de-facto finalize/reconcile engine for prod** — the APK has no server. The reconciler polls every 60s + on boot; for an active config with a future `end_time` it only **arms a timer** (logs "ends in ~Xh"), and for an inactive config it re-runs `runEndOfCycle` only if `payout_finalized_cycle !== cycle_id` OR participants remain — so a finalized, participant-empty inactive config is a safe no-op. This makes live data surgery safe without stopping the backend, given careful sequencing (reset while no cycle active → activate last).
