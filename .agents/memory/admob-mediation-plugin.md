---
name: AdMob mediation Expo config plugin
description: Why the mediation waterfall really fails, plus the Expo-54 gradle facts and the verify-without-prebuild technique that the config plugin depends on.
---

# AdMob mediation config plugin (Android)

## Real likely cause of the long-standing "No ad config / Adapter not found"
**Version drift, not the gradle injection.** `react-native-google-mobile-ads` bundles a GMA (play-services-ads) SDK version on Android (read it from `react-native-google-mobile-ads/package.json` → `sdkVersions.android.googleMobileAds`); when it jumped to GMA 25.x while the mediation adapters were still pinned at versions certified for GMA 23.x, adapters can be runtime-incompatible. Also, "No ad config" is AdMob's **server-side** message for an ad unit / mediation group not set up in the dashboard — also unrelated to gradle.
**Before blaming the plugin:** (1) check adapter ↔ GMA-major compatibility on Google's mediation versions page and bump the 4-part adapter versions to match the bundled GMA major; (2) verify the AdMob dashboard mediation groups. Do NOT guess adapter version numbers — confirm them from Google's page first.
**Why:** the regex injection was suspected for months, but ground truth (below) shows it matched all along, so a regex-only fix cannot fix prod.

## Expo SDK 54 android template — gradle ground truth
Verified against the real template (`npm pack expo-template-bare-minimum@sdk-54`):
- root `build.gradle` HAS `allprojects { repositories { google(); mavenCentral(); jitpack } }`.
- `settings.gradle` has **no** `dependencyResolutionManagement` block (uses Expo's version catalog).
- app `build.gradle` has exactly one top-level (column-0) `dependencies {`.
So regex/brace injection targeting `allprojects…repositories` + top-level `dependencies {` **does** match Expo 54. The "silent no-op" only afflicts the *bare RN community* template (repos under `dependencyResolutionManagement` in settings.gradle), which Expo does not use.

## android/ is gitignored and absent
`.gitignore` lists `android/`; there is no committed android/. ⇒ `expo prebuild` / EAS regenerates it fresh every build, so registered config plugins always run. A stale committed android/ bypassing the plugin is **not** a failure mode for this project; there is nothing to "clear".

## Verifying a prebuild config plugin when the CLI is blocked
The main-agent sandbox blocks `expo prebuild` (the CLI touches `.git` → destructive-git guard; a stale `.git/index.lock` may also block it). Verify without the CLI:
- Export the plugin's pure string transforms as properties on `module.exports` (keep the default export a function so config-plugins still loads it) and unit-test them.
- Drive the real `@expo/config-plugins` `compileModsAsync` (the exact engine prebuild uses) against a copy of the real template android/ dir, then grep the generated gradle.
- **Mod ordering fact:** dangerous mods run BEFORE the file-based mods flush to disk, so a `withDangerousMod` cannot read post-mod gradle content. Cross-file coordination (e.g. a fail-loud throw spanning build.gradle + settings.gradle) must be done in-memory via closure state and made order-independent (each pass records it ran; the last pass decides), not via a disk-reading guard.
