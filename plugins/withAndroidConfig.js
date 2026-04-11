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
function withAdMediationAdapters(config) {
  return withAppBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    const adapters = [
      "    // AdMob mediation — Unity Ads",
      "    implementation 'com.google.ads.mediation:unity:4.13.0.0'",
      "    // AdMob mediation — AppLovin",
      "    implementation 'com.applovin:applovin-sdk:13.0.0'",
      "    implementation 'com.google.ads.mediation:applovin:13.0.0.0'",
    ].join('\n');

    const alreadyPatched =
      content.includes('com.google.ads.mediation:unity') &&
      content.includes('com.applovin:applovin-sdk');

    if (!alreadyPatched) {
      content = content.replace(
        /(\bdependencies\s*\{)/,
        `$1\n${adapters}`
      );
    }

    cfg.modResults.contents = content;
    return cfg;
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

/* ─── Compose all patches and export ─────────────────────────────────────────── */
module.exports = function withAndroidConfig(config) {
  config = withAgpVersion(config);
  config = withGradleWrapper(config);
  config = withAdMediationAdapters(config);
  config = withNdkVersion(config);
  config = withCppConfig(config);
  config = withAdiRegistration(config);
  return config;
};
