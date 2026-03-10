/**
 * plugins/withAndroidConfig.js
 *
 * Expo Config Plugin that patches the generated Android files every time
 * `npx expo prebuild` runs. Fixes three things:
 *
 *  1. AGP version  — Downgrades to 8.9.1 (max supported by Android Studio 2024.x)
 *  2. Gradle wrap  — Updates wrapper to Gradle 8.11.1 (required by AGP 8.9.1)
 *  3. Ad adapters  — Adds Unity Ads + AppLovin mediation adapter deps to app/build.gradle
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

/* ─── Compose all three patches and export ───────────────────────────────────── */
module.exports = function withAndroidConfig(config) {
  config = withAgpVersion(config);
  config = withGradleWrapper(config);
  config = withAdMediationAdapters(config);
  return config;
};
