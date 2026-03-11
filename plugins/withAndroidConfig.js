/**
 * plugins/withAndroidConfig.js
 *
 * Expo Config Plugin — patches generated Android files on every `npx expo prebuild`.
 *
 *  1. AGP version     — Downgrades to 8.9.1 (max supported by Android Studio Panda 2)
 *  2. Gradle wrapper  — Updates to Gradle 8.11.1 (required by AGP 8.9.1)
 *  3. Ad adapters     — Adds Unity Ads + AppLovin mediation adapter deps
 *  4. NDK version     — Pins to 26.1.10909125 (stable for RN 0.81, avoids NDK 27 ABI issues)
 *  5. C++ STL         — Adds -DANDROID_STL=c++_shared to cmake to fix
 *                       "undefined symbol: operator delete(void*)" with NDK 27 / RN 0.81
 */

const {
  withProjectBuildGradle,
  withAppBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');

/* ─── 1. Root build.gradle — pin AGP to 8.9.1 ───────────────────────────────── */
function withAgpVersion(config) {
  return withProjectBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    content = content.replace(
      /classpath\(["']com\.android\.tools\.build:gradle:[^"']+["']\)/g,
      'classpath("com.android.tools.build:gradle:8.9.1")'
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
        'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-bin.zip'
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
// NDK 27.1 changed C++ ABI in ways that break prebuilt .so files in many
// React Native native modules (react-native-screens, react-native-reanimated,
// etc.), causing "undefined symbol: operator delete(void*)" linker errors.
// NDK 26.1.10909125 is the LTS release explicitly supported by RN 0.81.
//
function withNdkVersion(config) {
  return withProjectBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    // Patch `ndkVersion = "X.X.X"` inside the ext { } block
    content = content.replace(
      /ndkVersion\s*=\s*["'][^"']+["']/,
      'ndkVersion = "26.1.10909125"'
    );

    cfg.modResults.contents = content;
    return cfg;
  });
}

/* ─── 5. app/build.gradle — add -DANDROID_STL=c++_shared to cmake ───────────── */
//
// Using c++_shared ensures all native modules share the same C++ runtime,
// preventing duplicate/missing C++ symbols when linking with NDK 26/27.
// Handles three cases in the generated build.gradle:
//   A) cmake { arguments "..." } already exists  → append to it
//   B) cmake { } exists but no arguments line    → inject arguments line
//   C) no cmake block in defaultConfig at all    → inject full cmake block
//
function withCppShared(config) {
  return withAppBuildGradle(config, (cfg) => {
    let content = cfg.modResults.contents;

    // Skip if already patched
    if (content.includes('-DANDROID_STL=c++_shared')) return cfg;

    // Case A: cmake { arguments "..." } — append to existing arguments string
    if (/cmake\s*\{[^}]*arguments\s+"/.test(content)) {
      content = content.replace(
        /(cmake\s*\{[^}]*arguments\s+")([^"]*)(")/,
        (_, pre, args, post) => `${pre}${args} -DANDROID_STL=c++_shared${post}`
      );
    }
    // Case B: cmake { } exists but no arguments line — inject one
    else if (/externalNativeBuild\s*\{[\s\S]*?cmake\s*\{/.test(content)) {
      content = content.replace(
        /(cmake\s*\{)/,
        '$1\n                arguments "-DANDROID_STL=c++_shared"'
      );
    }
    // Case C: no cmake block in defaultConfig — create one
    else {
      content = content.replace(
        /(defaultConfig\s*\{)/,
        '$1\n        externalNativeBuild {\n            cmake {\n                arguments "-DANDROID_STL=c++_shared"\n            }\n        }'
      );
    }

    cfg.modResults.contents = content;
    return cfg;
  });
}

/* ─── Compose all five patches and export ────────────────────────────────────── */
module.exports = function withAndroidConfig(config) {
  config = withAgpVersion(config);
  config = withGradleWrapper(config);
  config = withAdMediationAdapters(config);
  config = withNdkVersion(config);
  config = withCppShared(config);
  return config;
};
