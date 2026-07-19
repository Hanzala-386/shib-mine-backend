/**
 * plugins/withAndroidConfig.js
 *
 * Expo Config Plugin — patches generated Android files on every `npx expo prebuild`.
 *
 *  1. AGP version       — Pins to 8.10.2 (required for compileSdk 36 / Gradle 8.13)
 *  2. Gradle wrapper    — Updates to Gradle 8.13 (required for compileSdk 35/36 on EAS)
 *  3. gradle.properties — filters deprecated keys that hard-fail AGP 8.3+
 *  4. NDK version       — Pins to 26.1.10909125 (stable LTS for RN 0.81)
 *  5. C++ config        — Sets -DANDROID_STL=c++_shared + cppFlags "-std=c++17" in cmake
 *  6. subprojects sdk   — Forces compileSdk 35 on any third-party module below it
 *  7. ADI registration  — Writes adi-registration.properties into native assets
 *
 * NOTE: The Yodo1 MAS migration (repos, gradle flags, dormant toggle) and the
 * old AdMob-mediation injection have BOTH been fully removed. The app is
 * AdMob-only via react-native-google-mobile-ads — its own Expo config plugin
 * (configured in app.json) writes the AdMob App ID into AndroidManifest.xml.
 */

const {
  withProjectBuildGradle,
  withAppBuildGradle,
  withGradleProperties,
  withDangerousMod,
  withAndroidManifest,
  AndroidConfig,
} = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');

/* ─── 1. Root build.gradle — pin AGP to 8.10.2 (supports compileSdk 36) ─────── */
function withAgpVersion(config) {
  return withProjectBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    content = content.replace(
      /classpath\(["']com\.android\.tools\.build:gradle:[^"']+["']\)/g,
      'classpath("com.android.tools.build:gradle:8.10.2")'
    );

    cfg.modResults.contents = content;
    return cfg;
  });
}

/* ─── 2. gradle-wrapper.properties — pin Gradle to 8.13 ─────────────────────── */
function withGradleWrapper(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const wrapperPath = path.join(
        cfg.modRequest.platformProjectRoot,
        'gradle',
        'wrapper',
        'gradle-wrapper.properties'
      );

      if (!fs.existsSync(wrapperPath)) return cfg;

      let content = fs.readFileSync(wrapperPath, 'utf8');

      content = content.replace(
        /^distributionUrl=.+$/m,
        'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip'
      );

      fs.writeFileSync(wrapperPath, content, 'utf8');
      return cfg;
    },
  ]);
}

/* ─── 3. gradle.properties — filter deprecated keys ─────────────────────────── */
//
// Keys that must NEVER appear in gradle.properties — actively filtered out of any
// existing/cached modResults so a stale file can't re-introduce them. AGP 8.3+
// hard-fails the build if android.enableDexingArtifactTransform is present at all.
//
const DEPRECATED_GRADLE_KEYS = ['android.enableDexingArtifactTransform'];

/** Pure transform (exported for tests): drop deprecated/removed gradle flags. */
function filterDeprecatedGradleKeys(items) {
  return (Array.isArray(items) ? items : []).filter(
    (i) => !(i && i.type === 'property' && DEPRECATED_GRADLE_KEYS.includes(i.key))
  );
}

function withGradlePropertiesCleanup(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = filterDeprecatedGradleKeys(cfg.modResults);
    console.log('[withAndroidConfig] ✓ gradle.properties cleaned (deprecated keys filtered)');
    return cfg;
  });
}

/* ─── 5. Root build.gradle — pin NDK to 26.1.10909125 ───────────────────────── */
//
// NDK 27.x ships C++20 standard library headers by default. Several prebuilt
// .so files bundled with react-native-screens, react-native-reanimated, and
// other modules were compiled against NDK 26 / C++17. Mixing them with NDK 27
// causes ABI mismatches: "undefined symbol: operator delete(void*)".
// NDK 26.1.10909125 is the LTS release explicitly validated against RN 0.81.
//
function withNdkVersion(config) {
  return withProjectBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    content = content.replace(
      /ndkVersion\s*=\s*["'][^"']+["']/,
      'ndkVersion = "26.1.10909125"'
    );

    cfg.modResults.contents = content;
    return cfg;
  });
}

/* ─── 6. app/build.gradle — set STL=c++_shared and force C++17 ──────────────── */
//
// Two flags are required together:
//
//   -DANDROID_STL=c++_shared
//     All native modules share one copy of the C++ runtime .so instead of each
//     bundling a static copy. Prevents duplicate/conflicting C++ symbols at link time.
//
//   cppFlags "-std=c++17"
//     Forces every C++ translation unit through the C++17 standard. NDK 27 defaults
//     to C++20, which enables std::format and other C++20 constructs in NDK headers.
//     Prebuilt React Native modules don't use those constructs, so compiling against
//     C++20 headers causes "no member named 'format' in namespace 'std'" errors when
//     the compiler enables C++20 mode but a dependency doesn't expect it.
//
// The patch is idempotent — running prebuild multiple times won't double-inject.
// It handles all four shapes of the generated app/build.gradle:
//   A) externalNativeBuild { cmake { arguments "..." } } — appends to existing args
//   B) externalNativeBuild { cmake { } } no args/flags   — injects both lines
//   C) cmake block with cppFlags but no args             — adds args, extends cppFlags
//   D) no cmake block at all                             — creates full block
//
function withCppConfig(config) {
  return withAppBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    const STL_ARG   = '-DANDROID_STL=c++_shared';
    const CPP17     = '-std=c++17';
    const ARGS_LINE = `arguments "${STL_ARG}"`;
    const CPP_LINE  = `cppFlags "${CPP17}"`;

    // ── Helper: patch inside an already-located cmake { ... } block ──────────
    function ensureCmakeFlags(block) {
      let b = block;

      // arguments line
      if (/\barguments\s+"/.test(b)) {
        if (!b.includes(STL_ARG)) {
          b = b.replace(
            /(arguments\s+")([^"]*)(")/,
            (_, pre, args, post) => `${pre}${args.trimEnd()} ${STL_ARG}${post}`
          );
        }
      } else {
        b = b.replace(/(cmake\s*\{)/, `$1\n                ${ARGS_LINE}`);
      }

      // cppFlags line
      if (/\bcppFlags\s+"/.test(b)) {
        if (!b.includes(CPP17)) {
          b = b.replace(
            /(cppFlags\s+")([^"]*)(")/,
            (_, pre, flags, post) => `${pre}${flags.trimEnd()} ${CPP17}${post}`
          );
        }
      } else {
        b = b.replace(/(cmake\s*\{)/, `$1\n                ${CPP_LINE}`);
      }

      return b;
    }

    // Case A/B/C: externalNativeBuild { cmake { ... } } already present
    if (/externalNativeBuild\s*\{[\s\S]*?cmake\s*\{/.test(content)) {
      content = content.replace(
        /(externalNativeBuild\s*\{[\s\S]*?cmake\s*\{[\s\S]*?\}[\s\S]*?\})/,
        (match) => ensureCmakeFlags(match)
      );
    } else {
      // Case D: no cmake block — inject into defaultConfig
      content = content.replace(
        /(defaultConfig\s*\{)/,
        `$1\n        externalNativeBuild {\n            cmake {\n                ${ARGS_LINE}\n                ${CPP_LINE}\n            }\n        }`
      );
    }

    cfg.modResults.contents = content;
    return cfg;
  });
}

/* ─── 7. Root build.gradle — force compileSdkVersion 35 for all subprojects ──── */
//
// react-native-install-referrer (and sometimes other third-party modules)
// declare a lower compileSdkVersion in their own build.gradle. When AGP 8.x
// enforces a strict namespace/compileSdk contract, this causes:
//   "Namespace not specified … compileSdkVersion must be set"
// We upgrade any module whose compileSdkVersion is below 35 to match the app.
//
// ⚠️ LIFECYCLE SAFETY (Gradle 8.13 + RN 0.81):
// We must NOT unconditionally call `project.afterEvaluate(Closure)` from the root
// build script. Under Gradle 8.13 with RN 0.81 / Expo autolinking, some
// subprojects are ALREADY EVALUATED by the time the root project's build script
// reaches this `subprojects { }` block. Registering an afterEvaluate hook on an
// already-evaluated project throws a hard, build-aborting error:
//   "Cannot run Project.afterEvaluate(Closure) when the project is already evaluated."
// So for each subproject we branch on `subproject.state.executed`: apply the
// compileSdk override IMMEDIATELY for projects already evaluated, and only defer
// via afterEvaluate for projects not yet evaluated. This keeps every module's
// evaluation intact regardless of the order Gradle configures them in.
// This is idempotent — already-patched root gradle files are not re-patched.
//
const SUBPROJECTS_PATCH_MARKER = '// [shib-patch] subprojects compileSdk';

/**
 * Pure transform (exported for tests): append the evaluation-order-safe
 * subprojects compileSdk-forcing block to the root build.gradle contents.
 * Idempotent — re-running on already-patched contents is a no-op.
 *
 * Returns { contents, changed }.
 */
function injectSubprojectsCompileSdk(contents) {
  if (typeof contents !== 'string') return { contents, changed: false };
  if (contents.includes(SUBPROJECTS_PATCH_MARKER)) return { contents, changed: false };

  const subprojectsPatch = `
${SUBPROJECTS_PATCH_MARKER}
subprojects { subproject ->
    def forceCompileSdk = {
        if (!subproject.hasProperty('android')) return
        try {
            def ext = subproject.android
            // Read the CURRENT compileSdk type-safely. AGP 8 exposes an Integer
            // 'compileSdk' property; older/legacy DSL may surface 'compileSdkVersion'
            // as a String like "android-34". Normalise both to an int.
            Integer current = null
            try { current = ext.compileSdk } catch (ignored) {}
            if (current == null) {
                try {
                    def legacy = ext.compileSdkVersion
                    if (legacy instanceof Number) {
                        current = legacy.intValue()
                    } else if (legacy != null) {
                        def m = (legacy.toString() =~ /\\d+/)
                        if (m.find()) current = m.group() as Integer
                    }
                } catch (ignored) {}
            }
            if (current == null || current < 35) {
                ext.compileSdk = 35
            }
        } catch (Throwable t) {
            // Best-effort only: an already-finalised (early-evaluated) module may
            // reject a late compileSdk write. Never abort the build over it.
            subproject.logger.warn("[shib-patch] could not force compileSdk 35 on '" + subproject.name + "': " + t.message)
        }
    }
    // Avoid "Cannot run Project.afterEvaluate(Closure) when the project is
    // already evaluated." — for not-yet-evaluated modules defer via afterEvaluate
    // (runs AFTER the module declares its own compileSdk, so the override sticks);
    // for already-evaluated modules apply immediately (best-effort, see try/catch).
    if (subproject.state.executed) {
        forceCompileSdk()
    } else {
        subproject.afterEvaluate { forceCompileSdk() }
    }
}
`;

  // Append after the last closing brace of the file.
  return { contents: contents.trimEnd() + '\n' + subprojectsPatch, changed: true };
}

function withSubprojectsCompileSdk(config) {
  return withProjectBuildGradle(config, (cfg) => {
    const res = injectSubprojectsCompileSdk(cfg.modResults.contents);
    cfg.modResults.contents = res.contents;
    return cfg;
  });
}

/* ─── 8. Copy adi-registration.properties into Android native assets ─────────── */
//
// Google Play ownership verification requires this file to exist at:
//   android/app/src/main/assets/adi-registration.properties
//
// assetBundlePatterns only bundles files into the JS layer — it does NOT place
// files in the native assets folder. This withDangerousMod writes the file
// directly during prebuild so it is included in the compiled APK/AAB.
//
function withAdiRegistration(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const assetsDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'assets'
      );

      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
      }

      const destPath = path.join(assetsDir, 'adi-registration.properties');
      fs.writeFileSync(destPath, 'DI6G2JKTKQSU4AAAAAAAAAAAAA', 'utf8');

      return cfg;
    },
  ]);
}

/* ─── 9. Unity Ads via official Google AdMob mediation (waterfall source) ────── */
//
// Official Google mediation ONLY (NOT IronSource/LevelPlay). Two artifacts are
// required because the adapter POM states "This build does not contain the
// UnityAds SDK" — the adapter does NOT pull unity-ads transitively:
//
//   com.google.ads.mediation:unity:4.19.0.0  (adapter; POM verified 2026-07-19:
//     targets play-services-ads 25.4.0 — same GMA 25.x major that
//     react-native-google-mobile-ads 16.1.0 bundles [sdkVersions → 25.0.0])
//   com.unity3d.ads:unity-ads:4.19.0         (Unity SDK the adapter wraps;
//     resolves on Maven Central — verified HTTP 200)
//
// Version floor compliance: Unity SDK 4.19.0 ≥ 4.11.3 ✓; adapter 4.19.0.0 ≥
// 4.11.3.0 ✓; GMA 25.x ≥ 23.0.0 ✓. Both repos (google() + mavenCentral()) are
// already in the Expo 54 template root build.gradle — no repo injection needed.
//
// Game ID 6061517 and placements (Shib_Banner_Android / Shib_Interstitial_Android
// / Shib_Rewarded_Android) are configured in the AdMob console mediation group —
// the adapter receives them server-side from AdMob; they are NOT read from code.
// The manifest meta-data below records the Game ID for auditability.
//
const UNITY_MEDIATION_MARKER = '// [shib-patch] unity-admob-mediation';
const UNITY_ADAPTER_DEP      = 'com.google.ads.mediation:unity:4.19.0.0';
const UNITY_SDK_DEP          = 'com.unity3d.ads:unity-ads:4.19.0';
const UNITY_GAME_ID          = '6061517';

/**
 * Pure transform (exported for tests): inject the Unity mediation adapter +
 * Unity Ads SDK into the app build.gradle top-level `dependencies {` block.
 * The Expo SDK 54 template has exactly ONE column-0 `dependencies {`.
 * Idempotent via marker. Returns { contents, changed }.
 */
function injectUnityMediationDeps(contents) {
  if (typeof contents !== 'string') return { contents, changed: false };
  if (contents.includes(UNITY_MEDIATION_MARKER)) return { contents, changed: false };

  const depsBlockRe = /^dependencies\s*\{/m;
  if (!depsBlockRe.test(contents)) {
    console.warn('[withAndroidConfig] ✗ Unity mediation: no top-level dependencies{} block found — NOT injected');
    return { contents, changed: false };
  }

  const injected = contents.replace(
    depsBlockRe,
    `dependencies {\n    ${UNITY_MEDIATION_MARKER}\n    implementation("${UNITY_ADAPTER_DEP}")\n    implementation("${UNITY_SDK_DEP}")\n`
  );
  return { contents: injected, changed: true };
}

function withUnityMediationDeps(config) {
  return withAppBuildGradle(config, (cfg) => {
    const res = injectUnityMediationDeps(cfg.modResults.contents);
    cfg.modResults.contents = res.contents;
    if (res.changed) {
      console.log(`[withAndroidConfig] ✓ Unity mediation deps injected (${UNITY_ADAPTER_DEP} + ${UNITY_SDK_DEP})`);
    }
    return cfg;
  });
}

/**
 * Pure transform (exported for tests): add the Unity Game ID meta-data entry
 * to <application> in AndroidManifest.xml. addMetaDataItemToMainApplication
 * is upsert-style, so re-running prebuild never duplicates the entry.
 * NOTE: AdMob mediation itself does not read this key — the Game ID lives in
 * the AdMob console mediation source config. Kept for explicit auditability.
 */
function addUnityGameIdMetaData(androidManifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, 'com.unity3d.ads.gameId', UNITY_GAME_ID);
  return androidManifest;
}

function withUnityGameIdManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = addUnityGameIdMetaData(cfg.modResults);
    console.log(`[withAndroidConfig] ✓ AndroidManifest meta-data com.unity3d.ads.gameId=${UNITY_GAME_ID}`);
    return cfg;
  });
}

/* ─── 10. Kotlin version — enforce 2.2.20 at BOTH propagation layers ─────────── */
//
// EAS failed with a Kotlin metadata error ("binary version of its metadata is
// 2.3.0, expected version is 2.1.0") — that "expected 2.1.0" fingerprint means
// the failing module compiled with Kotlin 2.0.x, i.e. Expo's fallback default
// (2.0.21) was used because the project's kotlinVersion pin never reached the
// build. The Kotlin compiler reads metadata ONE minor ahead, so 2.2.x reads the
// 2.3.0 metadata in play-services-ads / the Unity adapter's kotlin-stdlib.
//
// WHY 2.2.20 AND NOT 2.3.0: Expo SDK 54's autolinking KSP lookup table tops out
// at 2.2.20 — any higher value hard-fails prebuild with "Can't find KSP version".
// 2.2.20 is the ceiling AND is sufficient (one-minor-ahead metadata rule).
//
// Layer 1 (gradle.properties `android.kotlinVersion`): feeds Expo's settings
//   plugin → version catalog `kotlin` → KGP/KSP for every expo module.
//   expo-build-properties also writes this; we upsert it here too so the key
//   survives even if plugin order changes or a cached/stale file drops it.
// Layer 2 (root build.gradle `ext.kotlinVersion`): read directly by libraries
//   like react-native-google-mobile-ads via getExtOrDefault('kotlinVersion',…)
//   — their fallback is an ancient 1.8.22 if the ext is missing.
//
// KEEP IN SYNC with app.json → plugins → expo-build-properties → android.kotlinVersion.
// If that value ever changes (e.g. SDK 55 upgrade), update this constant in lockstep —
// otherwise this plugin silently overwrites the app.json value (last writer wins).
const KOTLIN_VERSION_PIN  = '2.2.20';
const KOTLIN_EXT_MARKER   = '// [shib-patch] kotlin-version-pin';

/** Pure transform (exported for tests): upsert android.kotlinVersion in gradle.properties items. */
function upsertKotlinGradleProp(items) {
  const list = Array.isArray(items) ? [...items] : [];
  const idx = list.findIndex((i) => i && i.type === 'property' && i.key === 'android.kotlinVersion');
  if (idx >= 0) {
    if (list[idx].value === KOTLIN_VERSION_PIN) return { items: list, changed: false };
    list[idx] = { type: 'property', key: 'android.kotlinVersion', value: KOTLIN_VERSION_PIN };
    return { items: list, changed: true };
  }
  list.push({ type: 'property', key: 'android.kotlinVersion', value: KOTLIN_VERSION_PIN });
  return { items: list, changed: true };
}

/**
 * Pure transform (exported for tests): pin ext.kotlinVersion in the root
 * build.gradle. Injects inside the top-level `buildscript {` block (classic RN
 * pattern — safe before `plugins {}` constraints); if no buildscript block
 * exists, appends at EOF (still evaluated before any subproject configures).
 * Idempotent via marker. Returns { contents, changed }.
 */
function injectRootKotlinExt(contents) {
  if (typeof contents !== 'string') return { contents, changed: false };
  if (contents.includes(KOTLIN_EXT_MARKER)) return { contents, changed: false };

  const pin = `${KOTLIN_EXT_MARKER}\n    ext.kotlinVersion = "${KOTLIN_VERSION_PIN}"`;
  const buildscriptRe = /^buildscript\s*\{/m;

  if (buildscriptRe.test(contents)) {
    return {
      contents: contents.replace(buildscriptRe, `buildscript {\n    ${pin}`),
      changed: true,
    };
  }
  return {
    contents: `${contents}\n${KOTLIN_EXT_MARKER}\next.kotlinVersion = "${KOTLIN_VERSION_PIN}"\n`,
    changed: true,
  };
}

function withKotlinVersionEnforced(config) {
  config = withGradleProperties(config, (cfg) => {
    const res = upsertKotlinGradleProp(cfg.modResults);
    cfg.modResults = res.items;
    console.log(`[withAndroidConfig] ✓ gradle.properties android.kotlinVersion=${KOTLIN_VERSION_PIN} enforced`);
    return cfg;
  });
  config = withProjectBuildGradle(config, (cfg) => {
    const res = injectRootKotlinExt(cfg.modResults.contents);
    cfg.modResults.contents = res.contents;
    if (res.changed) {
      console.log(`[withAndroidConfig] ✓ root build.gradle ext.kotlinVersion=${KOTLIN_VERSION_PIN} pinned`);
    }
    return cfg;
  });
  return config;
}

/* ─── Compose all patches and export ─────────────────────────────────────────── */
module.exports = function withAndroidConfig(config) {
  // Build system
  config = withAgpVersion(config);
  config = withGradleWrapper(config);
  config = withGradlePropertiesCleanup(config);
  config = withNdkVersion(config);
  config = withCppConfig(config);
  config = withSubprojectsCompileSdk(config);

  // App assets / Google Play ownership registration
  config = withAdiRegistration(config);

  // Unity Ads via official Google AdMob mediation (waterfall source)
  config = withUnityMediationDeps(config);
  config = withUnityGameIdManifest(config);

  // Kotlin 2.2.20 — SDK-54 ceiling; reads the 2.3.0 metadata of GMA/Unity deps
  config = withKotlinVersionEnforced(config);

  return config;
};

/* ─── Exported pure transforms (for verification harness / unit tests) ───────── */
module.exports.filterDeprecatedGradleKeys  = filterDeprecatedGradleKeys;
module.exports.injectSubprojectsCompileSdk = injectSubprojectsCompileSdk;
module.exports.SUBPROJECTS_PATCH_MARKER    = SUBPROJECTS_PATCH_MARKER;
module.exports.injectUnityMediationDeps    = injectUnityMediationDeps;
module.exports.addUnityGameIdMetaData      = addUnityGameIdMetaData;
module.exports.UNITY_MEDIATION_MARKER      = UNITY_MEDIATION_MARKER;
module.exports.UNITY_ADAPTER_DEP           = UNITY_ADAPTER_DEP;
module.exports.UNITY_SDK_DEP               = UNITY_SDK_DEP;
module.exports.upsertKotlinGradleProp      = upsertKotlinGradleProp;
module.exports.injectRootKotlinExt         = injectRootKotlinExt;
module.exports.KOTLIN_VERSION_PIN          = KOTLIN_VERSION_PIN;
module.exports.KOTLIN_EXT_MARKER           = KOTLIN_EXT_MARKER;
