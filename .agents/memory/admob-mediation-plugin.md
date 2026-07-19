---
name: AdMob mediation Expo config plugin
description: Why the mediation waterfall really fails, plus the Expo-54 gradle facts and the verify-without-prebuild technique that the config plugin depends on.
---

# AdMob mediation config plugin (Android)

> **SUPERSEDED** — the AdMob mediation injection described here was removed when the Android ad stack began migrating to Yodo1 MAS (see `yodo1-migration.md`). The Expo-54 gradle ground-truth and the "verify a prebuild plugin without the CLI" technique below are still accurate and reusable.

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

## How to confirm an adapter is GMA-25 (or any GMA-major) compatible — the authoritative check
Do NOT trust the mediation docs page or guess from the 4-part version. Read each adapter's POM straight from Google Maven and look at its declared `play-services-ads` dependency:
- Versions list: `https://dl.google.com/dl/android/maven2/com/google/ads/mediation/<artifact>/maven-metadata.xml`
- POM: `…/<artifact>/<ver>/<artifact>-<ver>.pom` → grep `play-services-ads` (its version = the GMA major the adapter targets) AND the underlying network-SDK dep (groupId:artifactId:version).
- Full artifact-name list under the group: `…/com/google/ads/mediation/group-index.xml` (use this to catch renamed/removed adapters).
- Pin BOTH the `com.google.ads.mediation:*` adapter AND the exact underlying SDK version the POM declares; verify the underlying SDK actually resolves (curl the repo, expect 200) before pinning.

## Adapter / SDK rebrands that bite (coordinates change, not just versions)
- **Digital Turbine / DT Exchange**: the Google adapter is `com.google.ads.mediation:fyber` — `…:digitalturbine` 404s (never existed). Underlying SDK is `com.fyber:marketplace-sdk` (on Maven Central; also mirrored fyber.jfrog.io). Legacy `adcolony` is abandoned.
- **ironSource → LevelPlay (Unity acquisition)**: underlying SDK moved `com.ironsource.sdk:mediationsdk` → `com.unity3d.ads-mediation:mediation-sdk`, now on **Maven Central** (the old `android-sdk.is.com` repo 404s the new coordinate). The Google adapter artifact is still `com.google.ads.mediation:ironsource`.
- **Unity Ads**: the adapter POM says *"This build does not contain the UnityAds SDK"* — it does NOT pull `com.unity3d.ads:unity-ads` transitively, so the SDK must be pinned explicitly or Unity silently never fills.
- Net effect circa 2026: all these underlying SDKs resolve from Maven Central, so the custom `android-sdk.is.com` / `fyber.jfrog.io` repos became vestigial fallbacks (harmless; Gradle falls through 404 to mavenCentral).

## Verifying a prebuild config plugin when the CLI is blocked
The main-agent sandbox blocks `expo prebuild` (the CLI touches `.git` → destructive-git guard; a stale `.git/index.lock` may also block it). Verify without the CLI:
- Export the plugin's pure string transforms as properties on `module.exports` (keep the default export a function so config-plugins still loads it) and unit-test them.
- Drive the real `@expo/config-plugins` `compileModsAsync` (the exact engine prebuild uses) against a copy of the real template android/ dir, then grep the generated gradle.
- **Mod ordering fact:** dangerous mods run BEFORE the file-based mods flush to disk, so a `withDangerousMod` cannot read post-mod gradle content. Cross-file coordination (e.g. a fail-loud throw spanning build.gradle + settings.gradle) must be done in-memory via closure state and made order-independent (each pass records it ran; the last pass decides), not via a disk-reading guard.

## Unity mediation is ACTIVE again (Jul 2026) — two-dependency rule
The Unity waterfall was re-added via the official Google adapter. The non-obvious trap: `com.google.ads.mediation:unity` POM explicitly states "This build does not contain the UnityAds SDK" — it does NOT pull `com.unity3d.ads:unity-ads` transitively. **Why:** a build with only the adapter dep compiles but the adapter reports NOT_READY at runtime (no Unity classes). **How to apply:** always inject BOTH `com.google.ads.mediation:unity:<4-part>` and `com.unity3d.ads:unity-ads:<first-3-parts>` together; the adapter's 4-part version prefix = the Unity SDK version it was certified against. Game ID + placements live ONLY in the AdMob console mediation group — no code/manifest key is read by the adapter. RNGMA `initialize()` resolves `AdapterStatus[]` ({name, description, state 0|1}) = the getInitializationStatus map; match the Unity entry by name containing 'unity' (class name varies across GMA versions).

- **Mediation-adapter GMA parity rule (REACTIVATED — this is live again)**: a mediation adapter's POM pins an exact play-services-ads version and Gradle resolves the HIGHEST of {RNGMA's package.json sdkVersions default, adapter pin}. An adapter that pins GMA above RNGMA's default silently upgrades GMA for the whole app — if that newer GMA is built with a newer Kotlin, `:react-native-google-mobile-ads:compileReleaseKotlin` fails with a metadata error even though the app never asked for the upgrade. **Fix = pick the adapter whose POM GMA pin exactly matches RNGMA's expected GMA** (check `dl.google.com/dl/android/maven2/com/google/ads/mediation/<net>/<v>/<net>-<v>.pom`) — this beats fighting the Kotlin version because it works regardless of which compiler the builder runs.
