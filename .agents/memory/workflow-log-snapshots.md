---
name: Workflow log files are snapshots
description: /tmp/logs/*.log are point-in-time snapshots — polling them with grep never sees new output
---

**Rule:** Files under `/tmp/logs/` are written once per `refresh_all_logs` call (a snapshot of unseen output at that moment). They do NOT tail live workflow output.

**Why:** Wasted ~90s grep-polling a Start Backend log file waiting for a boot-chain migration line that had already been printed — the line only appeared after calling `refresh_all_logs` again (new timestamped file).

**How to apply:** To wait for a boot/init log line, loop on `refresh_all_logs` (each call writes a fresh file), not on grep against an existing `/tmp/logs` file. The backend's PB schema init chain also takes ~60-90s after boot before late entries (e.g. game_score) log.
