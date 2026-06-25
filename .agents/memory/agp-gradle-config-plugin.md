---
name: AGP gradle config-plugin pitfalls
description: Deprecated Gradle flags + why an upsert-only config plugin can still emit them
---

# AGP / gradle.properties config-plugin pitfalls

- `android.enableDexingArtifactTransform` was deprecated and **removed in AGP 8.3**. If it is present in `gradle.properties` at all (even `=false`), AGP 8.3+ **hard-fails the build**. Modern AGP manages the dexing transform automatically — no replacement flag exists. Do not re-add it.

- **Upsert is not enough — a config plugin that writes gradle.properties must also actively FILTER removed/deprecated keys out of the incoming (existing/cached) `modResults`.**
  - **Why:** `expo prebuild`/EAS may carry an existing or cached `gradle.properties`. A plugin that only upserts its own keys will leave a stale deprecated key untouched, so the build still fails even though the plugin "removed" the key from its own source list.
  - **How to apply:** keep a `DEPRECATED_GRADLE_KEYS` list and `.filter()` them from the items array at the top of the apply-transform, before upserting. Cover the stale-input case in the node verification harness (`scripts/verify-android-config.js`), not just the fresh-`[]` case.

- Yodo1 MAS native privacy setters (`setCOPPA`/`setGDPR`/`setCCPA`) must be called **before** `initMas()`. A Kotlin try/catch around them only guards runtime throws — a renamed setter is a **compile error** and must be fixed against the real AAR in the EAS build (sandbox cannot compile native).
