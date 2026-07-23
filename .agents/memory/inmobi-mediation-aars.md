---
name: InMobi mediation local AAR pattern
description: How local InMobi AARs are wired into the Expo config plugin, and the GMA 25.4.0 compatibility risk with InMobi adapter 11.4.0.0.
---

# InMobi mediation local AAR pattern

## The rule
When providing SDK .aar files manually alongside a `com.google.ads.mediation:*` adapter, always exclude the adapter's transitive SDK dep to prevent duplicate class build failures.

**Why:** `com.google.ads.mediation:inmobi:11.4.0.0` declares `com.inmobi.monetization:inmobi-ads-kotlin:11.4.0` as a transitive dependency. If Maven Central also resolves it AND the local `InMobiSDK.aar` provides the same classes, the build fails with a duplicate class error. Excluding the transitive dep makes Gradle use only the local AAR.

**How to apply:**
```groovy
implementation(fileTree(dir: "libs", include: ["*.aar"]))
implementation("com.google.ads.mediation:inmobi:11.4.0.0") {
    exclude group: "com.inmobi.monetization", module: "inmobi-ads-kotlin"
}
```

## File locations
- `android-libs/InMobiSDK.aar` (2.2 MB) — git-committed, InMobi SDK
- `android-libs/OMSDK.aar` (85 KB) — git-committed, IAB Open Measurement SDK
- Config plugin copies them to `android/app/libs/` on every prebuild (`withInMobiLibsCopy` in `plugins/withAndroidConfig.js`)

## GMA 25.4.0 compatibility risk
InMobi adapter 11.4.0.0 POM pins `play-services-ads:25.4.0` (vs RNGMA 16.1.0's default 25.0.0). Gradle resolves to 25.4.0 (highest wins). This also upgrades `kotlin-stdlib` to 2.3.0.

**Why it's a risk:** Unity adapter 4.19.0.0 caused the same GMA upgrade and broke `:react-native-google-mobile-ads:compileReleaseKotlin` (metadata "expected 2.1.0" / "got 2.3.0"). We rolled back to Unity 4.17.0.0 (pins GMA 25.0.0) to avoid it.

**Mitigation with InMobi:** Kotlin pin is now 2.2.20 (was effectively 2.1.x before). Kotlin 2.2.20 should handle 2.3.0 metadata (one-minor-ahead read rule). Confirm via EAS build logs — look for `compileReleaseKotlin` errors on the `:react-native-google-mobile-ads` module.

**If the build fails:** Try InMobi adapter 10.7.x which may pin an older GMA.
