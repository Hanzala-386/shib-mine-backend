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

- **Never call `project.afterEvaluate(Closure)` unconditionally from a root `subprojects {}` block.** Under Gradle 8.13 + RN 0.81 / Expo autolinking, some subprojects are *already evaluated* by the time the root build script runs that block, and registering an afterEvaluate hook on them throws a hard, build-aborting `"Cannot run Project.afterEvaluate(Closure) when the project is already evaluated."`
  - **Why:** evaluation order is not guaranteed root-first; autolinking can force early child evaluation, so a blanket `subprojects { afterEvaluate {} }` crashes the root config phase.
  - **How to apply:** branch on `subproject.state.executed` — apply the mutation immediately for already-evaluated modules, only `afterEvaluate {}` for the rest. The afterEvaluate branch (not the immediate one) is what actually *overrides* a module's declared value, because it runs after the module's own build.gradle body; the immediate branch is best-effort (AGP may have already finalised), so wrap it in `try/catch(Throwable)` + `logger.warn` so a late write can never abort the build.
  - Read compileSdk **type-safely**: AGP 8 exposes Integer `android.compileSdk`; legacy DSL may surface `compileSdkVersion` as a String like `"android-34"`. Normalise to int (try `compileSdk`, else regex `=~ /\d+/` on `compileSdkVersion`) before comparing `< 35`, then set via `ext.compileSdk = 35`. A bare `compileSdkVersion < 35` is type-fragile.

- The node verification harness can assert all of this without Gradle: model a representative Expo-54 root `build.gradle` (a `buildscript { repositories {} }` *and* a top-level `allprojects { repositories {} }`) and assert repos land in `allprojects` (not `buildscript`), no `afterEvaluate` appears in the repos region, the subprojects patch contains the `state.executed` guard (and the old unguarded `subprojects {\n afterEvaluate { project ->` regex is gone), both transforms are idempotent, and `{`/`}` stay balanced.
