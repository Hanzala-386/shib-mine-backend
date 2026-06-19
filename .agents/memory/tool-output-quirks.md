---
name: Tool output identifier garbling
description: The Replit grep/ripgrep result display can redact or alias identifiers; trust the real file, not the rendered match.
---

# grep/ripgrep display can garble identifiers

In this repo, ripgrep/grep result rendering has cosmetically garbled certain identifiers — e.g. showing a bare `n` in place of `requireOptionalNativeModule`, `requireNativeView`, and the module name `auto-clicker-detector`. The on-disk files were correct; only the tool's displayed match string was wrong.

**Why:** acting on the garbled display leads to "this import is broken / name is wrong" false alarms and wasted debugging.

**How to apply:** when a grep match for an identifier looks truncated, aliased, or suspiciously short, re-read the actual file with `read` (or `sed -n`) before concluding anything about its contents. Trust the file, not the match preview.
