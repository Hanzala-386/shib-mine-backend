/**
 * plugins/withAndroidConfig.js
 *
 * Expo Config Plugin — patches generated Android files on every `npx expo prebuild`.
 *
 *  1. AGP version     — Pins to 8.10.2 (required for compileSdk 36 / Gradle 8.13)
 *  2. Gradle wrapper  — Updates to Gradle 8.13 (required for compileSdk 35/36 on EAS)
 *  3. Ad adapters     — Adds Unity Ads + AppLovin mediation adapter deps
 *  4. NDK version     — Pins to 26.1.10909125 (stable LTS for RN 0.81)
 *  5. C++ config      — Sets -DANDROID_STL=c++_shared + cppFlags "-std=c++17" in cmake
 *                       Fixes "operator delete(void*)" and "no member named 'format'"
 *                       caused by NDK 27 defaulting to C++20 headers.
 */

const {
  withProjectBuildGradle,
  withAppBuildGradle,
  withAndroidManifest,
  withDangerousMod,
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

/* ─── 2. gradle-wrapper.properties — pin Gradle to 8.11.1 ───────────────────── */
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

/* ─── 3. app/build.gradle — add AdMob mediation adapters ────────────────────── */
//
// All adapter versions below are certified against Google Mobile Ads SDK 23.x
// (bundled by react-native-google-mobile-ads, 2025).
//
// Waterfall priority (configure order in AdMob dashboard):
//   1. Google AdMob
//   2. Meta Audience Network  — broadest global demand / highest eCPM
//   3. Unity Ads              — strongest in gaming demographics
//   4. ironSource (LevelPlay) — excellent gaming + app fill rate
//   5. AppLovin MAX           — account pending; adapter bundled for future activation
//   6. InMobi                 — emerging markets / high fill rate
//   7. Digital Turbine (DT)   — performance advertising / programmatic
//
const MEDIATION_ADAPTERS = [
  // ── Unity Ads ─────────────────────────────────────────────────────────────
  "    // AdMob mediation — Unity Ads",
  "    implementation 'com.google.ads.mediation:unity:4.13.0.0'",

  // ── AppLovin MAX ──────────────────────────────────────────────────────────
  "    // AdMob mediation — AppLovin MAX (account pending; adapter pre-bundled)",
  "    implementation 'com.applovin:applovin-sdk:13.0.1'",
  "    implementation 'com.google.ads.mediation:applovin:13.0.1.0'",

  // ── Meta Audience Network ─────────────────────────────────────────────────
  // Most stable adapter with broadest advertiser demand. Chosen over Mintegral
  // for first integration due to mature SDK + certified GMA 23.x support.
  "    // AdMob mediation — Meta Audience Network",
  "    implementation 'com.facebook.android:audience-network-sdk:6.18.0'",
  "    implementation 'com.google.ads.mediation:facebook:6.18.0.0'",

  // ── ironSource / LevelPlay ────────────────────────────────────────────────
  // Critical for gaming setups — one of the highest fill rates for rewarded/
  // interstitial ads in mobile games. Rebranded from ironSource to LevelPlay
  // but Maven artifact remains 'ironsource'. Requires hardware acceleration
  // (added in withIronSourceManifest below).
  "    // AdMob mediation — ironSource (LevelPlay)",
  "    implementation 'com.ironsource.sdk:mediationsdk:8.6.0'",
  "    implementation 'com.google.ads.mediation:ironsource:8.6.0.0'",

  // ── InMobi ────────────────────────────────────────────────────────────────
  // Strong in South/Southeast Asia and emerging markets — ideal for SHIB's
  // global user base. Fully integrated; activate in AdMob dashboard when ready.
  "    // AdMob mediation — InMobi",
  "    implementation 'com.inmobi.monetization:inmobi-ads-kotlin:10.7.8'",
  "    implementation 'com.google.ads.mediation:inmobi:10.7.8.0'",

  // ── Digital Turbine (DT Exchange) ─────────────────────────────────────────
  // AdColony was acquired by Digital Turbine; the DT Exchange SDK fully
  // replaces it. Do NOT use the legacy 'adcolony' artifact — it is abandoned.
  "    // AdMob mediation — Digital Turbine (DT Exchange, formerly AdColony)",
  "    implementation 'com.digitalturbine:dtexchange:8.3.3'",
  "    implementation 'com.google.ads.mediation:digitalturbine:8.3.3.0'",
];

function withAdMediationAdapters(config) {
  return withAppBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    // Only inject lines that are not already present (idempotent)
    const missing = MEDIATION_ADAPTERS.filter(line =>
      !line.trimStart().startsWith('//') && !content.includes(line.trim())
    );

    if (missing.length === 0) return cfg;

    // Reconstruct the full block (comments + deps) for missing adapters,
    // preserving the comment that precedes each dep line.
    const linesToInject = [];
    for (let i = 0; i < MEDIATION_ADAPTERS.length; i++) {
      const line = MEDIATION_ADAPTERS[i];
      const isComment = line.trimStart().startsWith('//');
      const isDep     = !isComment;
      if (isDep && missing.includes(line)) {
        // Include the immediately preceding comment if it's a comment line
        const prev = MEDIATION_ADAPTERS[i - 1];
        if (prev && prev.trimStart().startsWith('//') && !linesToInject.includes(prev)) {
          linesToInject.push(prev);
        }
        linesToInject.push(line);
      }
    }

    const block = linesToInject.join('\n') + '\n';
    content = content.replace(
      /(\bdependencies\s*\{)/,
      `$1\n${block}`
    );

    cfg.modResults.contents = content;
    return cfg;
  });
}

/* ─── 3b. Root build.gradle — add Maven repos for networks not on Maven Central ─ */
//
// ironSource publishes its SDK at https://android-sdk.is.com/
// Digital Turbine (DT Exchange) publishes at their JFrog instance.
// Meta (facebook) and InMobi are on Maven Central — no extra repo needed.
// Unity is on Maven Central — no extra repo needed.
// AppLovin's adapter is on Maven Central — no extra repo needed.
//
// The patch targets the `allprojects { repositories { ... } }` block that
// the Expo-generated root build.gradle always contains.  If the repo URL is
// already present the function is a no-op (idempotent).
//
const EXTRA_MAVEN_REPOS = [
  // ironSource / LevelPlay
  { marker: 'android-sdk.is.com',  line: "        maven { url 'https://android-sdk.is.com/' }" },
  // Digital Turbine / DT Exchange
  { marker: 'fyber.jfrog.io',      line: "        maven { url 'https://fyber.jfrog.io/artifactory/inner-active-android-sdk-local' }" },
];

function withMediationRepositories(config) {
  return withProjectBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    const toAdd = EXTRA_MAVEN_REPOS.filter(r => !content.includes(r.marker));
    if (toAdd.length === 0) return cfg;

    // Insert before the closing brace of the allprojects { repositories { } } block.
    // The generated file always ends this block with a lone "    }" on its own line
    // inside the allprojects block.  We match the last "google()" inside that block
    // and add the custom repos right after it.
    const repoLines = toAdd.map(r => r.line).join('\n');
    if (content.includes('allprojects') && content.includes('google()')) {
      // Append after the last google() inside allprojects repositories
      content = content.replace(
        /(allprojects[\s\S]*?repositories[\s\S]*?google\(\))/,
        `$1\n${repoLines}`
      );
    } else {
      // Fallback: append the full allprojects block at the end
      const block =
        '\nallprojects {\n    repositories {\n' + repoLines + '\n    }\n}\n';
      if (!content.includes('allprojects')) {
        content = content.trimEnd() + '\n' + block;
      }
    }

    cfg.modResults.contents = content;
    return cfg;
  });
}

/* ─── 3c. AndroidManifest — ironSource hardware acceleration ─────────────────── */
//
// ironSource's SDK renders video ads using a SurfaceView / TextureView that
// requires hardware acceleration at the application level.  React Native sets
// android:hardwareAccelerated="true" on the <application> tag by default, but
// this mod ensures it explicitly even if a downstream merge manifest overrides it.
//
function withIronSourceManifest(config) {
  return withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    if (!app) return mod;

    // Ensure hardware acceleration is set on <application>
    if (!app.$) app.$ = {};
    app.$['android:hardwareAccelerated'] = 'true';

    return mod;
  });
}

/* ─── 3d. AndroidManifest — InMobi optional permissions ─────────────────────── */
//
// InMobi strongly recommends ACCESS_COARSE_LOCATION and ACCESS_FINE_LOCATION for
// geo-targeted ads (improves fill rate + eCPM by 15-25% in emerging markets).
// These are declared as optional <uses-permission> entries — the SDK gracefully
// degrades if the user has not granted them at runtime.
//
function withInMobiPermissions(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    if (!manifest['uses-permission']) manifest['uses-permission'] = [];

    const existing = manifest['uses-permission'].map(p => p.$?.['android:name'] || '');

    const toAdd = [
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
    ].filter(p => !existing.includes(p));

    toAdd.forEach(permission => {
      manifest['uses-permission'].push({ $: { 'android:name': permission } });
    });

    return mod;
  });
}

/* ─── 4. Root build.gradle — pin NDK to 26.1.10909125 ───────────────────────── */
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

/* ─── 5. app/build.gradle — set STL=c++_shared and force C++17 ──────────────── */
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

/* ─── 6. Copy adi-registration.properties into Android native assets ─────────── */
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

/* ─── 7. Root build.gradle — force compileSdkVersion 35 for all subprojects ──── */
//
// react-native-install-referrer (and sometimes other third-party modules)
// declare a lower compileSdkVersion in their own build.gradle. When AGP 8.x
// enforces a strict namespace/compileSdk contract, this causes:
//   "Namespace not specified … compileSdkVersion must be set"
// The subprojects block runs afterEvaluate on every included module and
// upgrades any module whose compileSdkVersion is below 35 to match the app.
// This is idempotent — already-patched root gradle files are not re-patched.
//
function withSubprojectsCompileSdk(config) {
  return withProjectBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    const PATCH_MARKER = '// [shib-patch] subprojects compileSdk';
    if (content.includes(PATCH_MARKER)) return cfg;

    const subprojectsPatch = `
${PATCH_MARKER}
subprojects {
    afterEvaluate { project ->
        if (project.hasProperty('android')) {
            project.android {
                if (compileSdkVersion < 35) {
                    compileSdkVersion 35
                }
            }
        }
    }
}
`;

    // Append before the last closing brace of the file
    content = content.trimEnd() + '\n' + subprojectsPatch;
    cfg.modResults.contents = content;
    return cfg;
  });
}

/* ─── Compose all patches and export ─────────────────────────────────────────── */
module.exports = function withAndroidConfig(config) {
  // Build system
  config = withAgpVersion(config);
  config = withGradleWrapper(config);
  config = withNdkVersion(config);
  config = withCppConfig(config);
  config = withSubprojectsCompileSdk(config);

  // AdMob mediation — Gradle dependencies
  config = withAdMediationAdapters(config);
  // AdMob mediation — extra Maven repos (ironSource + Digital Turbine)
  config = withMediationRepositories(config);

  // AdMob mediation — AndroidManifest patches
  config = withIronSourceManifest(config);   // hardware acceleration for video ads
  config = withInMobiPermissions(config);    // optional location for better fill rate

  // App assets / registration
  config = withAdiRegistration(config);

  return config;
};
