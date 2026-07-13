---
name: Artifact-managed workflows can't be deleted
description: Workflows created by the artifacts/mockup-sandbox system reject removeWorkflow; reclaim disk differently.
---

Workflows whose names start with `artifacts/…` (e.g. the mockup-sandbox preview server) are platform artifact-managed: `removeWorkflow` fails with PROHIBITED_ACTION.

**Why:** The artifact system owns their lifecycle; only the platform can delete them.

**How to apply:** To reclaim disk space from an artifact sandbox, delete its `node_modules` (regenerable via `npm install`) instead of trying to delete the workflow or the artifact directory. Also exclude `artifacts/` from the root tsconfig so a missing sandbox `node_modules` doesn't pollute `tsc --noEmit`.
