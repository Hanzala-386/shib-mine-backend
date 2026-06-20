#!/bin/bash
set -e

# Post-merge reconciliation for the Shiba Hit Expo + Express project.
# Idempotent and non-interactive — safe to run after every task merge.
# Schema migrations are applied at backend boot (ensureField pattern), so the
# only reconciliation needed here is syncing JS dependencies.

npm install --no-audit --no-fund
