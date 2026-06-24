/**
 * plugins/withAndroidConfig.js
 *
 * Expo Config Plugin — patches generated Android files on every `npx expo prebuild`.
 *
 *  1. AGP version       — Pins to 8.10.2 (required for compileSdk 36 / Gradle 8.13)
 *  2. Gradle wrapper    — Updates to Gradle 8.13 (required for compileSdk 35/36 on EAS)
 *  3. Yodo1 MAS repos   — Adds the 7 mediation-network Maven repositories Yodo1 needs,
 *                         injected AFTER google()/mavenCentral() so they are queried
 *                         last-resort only (no latency hit on the bulk of deps).
 *  4. gradle.properties — useAndroidX / enableJetifier / enableDexingArtifactTransform
 *                         + the dormant `yodo1Enabled` master toggle (default false).
 *  5. NDK version       — Pins to 26.1.10909125 (stable LTS for RN 0.81)
 *  6. C++ config        — Sets -DANDROID_STL=c++_shared + cppFlags "-std=c++17" in cmake
 *  7. subprojects sdk   — Forces compileSdk 35 on any third-party module below it
 *  8. ADI registration  — Writes adi-registration.properties into native assets
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * YODO1 MAS MIGRATION — PHASE 1 (DORMANT FOUNDATION)
 * ─────────────────────────────────────────────────────────────────────────────
 * The old AdMob-mediation injection (Unity / AppLovin / Meta / ironSource /
 * InMobi / Digital Turbine adapter pins, their extra repos, the ironSource
 * hardware-acceleration manifest patch and the InMobi location permissions) has
 * been REMOVED — Yodo1 MAS Full SDK bundles those networks internally.
 *
 * This phase only lays prebuild-safe infrastructure: the Maven repos + the
 * gradle.properties flags. The actual Yodo1 SDK dependencies live in the local
 * Expo module `modules/yodo1-mas/android/build.gradle`, gated behind the
 * `yodo1Enabled` gradle property (default false set here). While false the module
 * compiles a no-op stub and pulls ZERO Yodo1 deps, so the current
 * react-native-google-mobile-ads (.aab) build keeps working unchanged. Phase 2
 * flips `yodo1Enabled` → true (and removes react-native-google-mobile-ads).
 */

const {
  withProjectBuildGradle,
  withAppBuildGradle,
  withSettingsGradle,
  withGradleProperties,
  withDangerousMod,
} = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');

/* ─────────────────────────────────────────────────────────────────────────────
 * YODO1 PHASE TOGGLE — the single source of truth for the migration phase.
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 (current) = false → TRULY DORMANT. None of the Yodo1 build-environment
 * changes are applied: the vendor Maven repos are NOT injected and the
 * AndroidX/dexing gradle.properties are NOT written, so the current
 * react-native-google-mobile-ads (.aab) build pipeline is byte-for-byte
 * untouched. The only thing written is the `yodo1Enabled=false` marker property,
 * which nothing consumes while false (the modules/yodo1-mas Gradle gate compiles
 * its no-op stub and pulls zero Yodo1 deps).
 *
 * Phase 2 = flip to true → this one switch (a) injects the 7 Yodo1 vendor Maven
 * repos, (b) writes the Yodo1/AndroidX/dexing gradle.properties, and (c) writes
 * `yodo1Enabled=true`, which makes modules/yodo1-mas/android/build.gradle compile
 * the real bridge + pull the Yodo1 MAS SDK. (Phase 2 must also remove
 * react-native-google-mobile-ads first — GMA 25.x cannot coexist with Yodo1's
 * bundled play-services-ads.)
 */
const YODO1_ENABLED = true;

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

/* ─── 3. Yodo1 MAS — mediation-network Maven repositories ────────────────────── */
//
// Yodo1 MAS Full SDK aggregates many ad networks (Pangle, ironSource, Mintegral,
// BidMachine, YSO Network, PubMatic, Chartboost, …). Each network's SDK artifact
// is hosted on its own vendor Maven repo — these are the exact URLs Yodo1's
// integration guide requires.
//
// IMPORTANT (latency / fragility): these vendor repos are injected AFTER
// google()/mavenCentral() (see findReposInsertIndex) so Gradle only consults
// them as a last resort. The bulk of the build's dependencies (React Native,
// AndroidX, Expo, etc.) resolve from google()/mavenCentral() first and never hit
// these slower vendor endpoints. In Phase 1 no Yodo1 dependency is present at all
// (the module stub pulls nothing), so these repos are declared-but-unused.
//
const REPOS_MARKER_OPEN  = '// [yodo1-mas-repos] injected by withAndroidConfig.js — DO NOT EDIT';
const REPOS_MARKER_CLOSE = '// [/yodo1-mas-repos]';

const YODO1_MAVEN_REPOS = [
  { marker: 'artifact.bytedance.com',        line: 'maven { url "https://artifact.bytedance.com/repository/pangle" }' },
  { marker: 'android-sdk.is.com',            line: 'maven { url "https://android-sdk.is.com" }' },
  { marker: 'dl-maven-android.mintegral.com', line: 'maven { url "https://dl-maven-android.mintegral.com/repository/mbridge_android_sdk_oversea" }' },
  { marker: 'artifactory.bidmachine.io',     line: 'maven { url "https://artifactory.bidmachine.io/bidmachine" }' },
  { marker: 'ysonetwork.s3',                 line: 'maven { url "https://ysonetwork.s3.eu-west-3.amazonaws.com/sdk/android" }' },
  { marker: 'repo.pubmatic.com',             line: 'maven { url "https://repo.pubmatic.com/artifactory/public-repos" }' },
  { marker: 'bitbucket.org/sdkcenter',       line: 'maven { url "https://bitbucket.org/sdkcenter/sdkcenter/raw/release" }' },
];

/**
 * Brace-aware locator: returns the string index at which to insert the vendor
 * repos INSIDE the `repositories { }` child of the `blockKeyword { … }` block.
 *
 * Insertion point preference (to keep vendor repos last-resort):
 *   1. immediately AFTER the last `mavenCentral()` call, else
 *   2. immediately AFTER the last `google()` call, else
 *   3. immediately after the `repositories {` opener.
 *
 * Returns -1 if the block (or its repositories child) is absent. Brace-counting
 * bounds every search to the relevant block body so we never match a
 * `repositories {` that sits OUTSIDE the target block.
 */
function findReposInsertIndex(contents, blockKeyword) {
  const open = new RegExp(blockKeyword + '\\s*\\{');
  const m = open.exec(contents);
  if (!m) return -1;

  // Walk braces from the block's opening `{` to find the block-body extent.
  let depth = 0, blockStart = -1, blockEnd = -1;
  for (let i = m.index + m[0].length - 1; i < contents.length; i++) {
    const ch = contents[i];
    if (ch === '{') { depth++; if (depth === 1) blockStart = i; }
    else if (ch === '}') { depth--; if (depth === 0) { blockEnd = i; break; } }
  }
  if (blockStart === -1 || blockEnd === -1) return -1;

  // First `repositories {` strictly within the block body.
  const body = contents.slice(blockStart, blockEnd);
  const rm = /repositories\s*\{/.exec(body);
  if (!rm) return -1;

  // Bound the search to the repositories child block body.
  const repoOpenAbs = blockStart + rm.index + rm[0].length - 1; // index of its `{`
  let d = 0, repoEndAbs = -1;
  for (let i = repoOpenAbs; i < contents.length; i++) {
    const ch = contents[i];
    if (ch === '{') d++;
    else if (ch === '}') { d--; if (d === 0) { repoEndAbs = i; break; } }
  }
  if (repoEndAbs === -1) return -1;

  const repoBody = contents.slice(repoOpenAbs, repoEndAbs);

  // Insert after the LAST mavenCentral() (preferred) or google() so the vendor
  // repos are queried only after the standard repos.
  for (const re of [/mavenCentral\s*\(\s*\)/g, /google\s*\(\s*\)/g]) {
    let mm, last = -1;
    while ((mm = re.exec(repoBody)) !== null) { last = mm.index + mm[0].length; }
    if (last > -1) return repoOpenAbs + last;
  }

  // Fallback: right after the `repositories {` opener.
  return repoOpenAbs + 1;
}

/**
 * Pure transform (exported for tests): inject YODO1_MAVEN_REPOS after
 * google()/mavenCentral() inside the `blockKeyword { … }` block, indenting each
 * line with `indent`.
 *
 * Returns { contents, changed, alreadyPresent, found }. Never throws — the caller
 * decides whether a missing block is fatal (so it can fall back to another file).
 */
function injectYodo1ReposIntoBlock(contents, blockKeyword, indent) {
  if (typeof contents !== 'string') {
    return { contents, changed: false, alreadyPresent: false, found: false };
  }
  if (contents.includes(REPOS_MARKER_OPEN)) {
    return { contents, changed: false, alreadyPresent: true, found: true };
  }
  const insertAt = findReposInsertIndex(contents, blockKeyword);
  if (insertAt < 0) return { contents, changed: false, alreadyPresent: false, found: false };

  const repoLines = [
    '',
    indent + REPOS_MARKER_OPEN,
    ...YODO1_MAVEN_REPOS.map(r => indent + r.line),
    indent + REPOS_MARKER_CLOSE,
  ].join('\n');

  const out = contents.slice(0, insertAt) + repoLines + contents.slice(insertAt);
  return { contents: out, changed: true, alreadyPresent: false, found: true };
}

/* ─── 3. Maven repos — fail-loud, version-proof injection ────────────────────── */
//
// Repositories can live in different files depending on the RN/Expo version:
//   • Expo 54:                 root build.gradle → allprojects { repositories { } }
//   • newer bare-RN templates: settings.gradle   → dependencyResolutionManagement { repositories { } }
//
// Both passes run in-memory through modResults. The fail-loud throw is
// ORDER-INDEPENDENT — each pass records that it ran, and whichever pass runs LAST
// throws iff BOTH files were inspected and nothing was injected anywhere.
//
function withYodo1Repositories(config) {
  const state = { injected: false, buildGradleRan: false, settingsGradleRan: false };

  const failIfBothCheckedAndEmpty = () => {
    if (state.buildGradleRan && state.settingsGradleRan && !state.injected) {
      throw new Error(
        '[withAndroidConfig] FATAL: could not inject the Yodo1 MAS Maven repositories — no ' +
        '`allprojects { repositories { … } }` (root build.gradle) or ' +
        '`dependencyResolutionManagement { repositories { … } }` (settings.gradle) block was ' +
        'found in either file. Yodo1 mediation-network SDKs would fail to resolve at build time. ' +
        'Aborting prebuild.'
      );
    }
  };

  // Pass A — root build.gradle: Expo 54's allprojects block (or a DRM block if a
  // future template put one here).
  config = withProjectBuildGradle(config, (cfg) => {
    state.buildGradleRan = true;
    if (!state.injected) {
      let res = injectYodo1ReposIntoBlock(cfg.modResults.contents, 'allprojects', '        ');
      if (!res.found) {
        res = injectYodo1ReposIntoBlock(cfg.modResults.contents, 'dependencyResolutionManagement', '            ');
      }
      if (res.found) {
        cfg.modResults.contents = res.contents;
        state.injected = true;
        console.log(res.changed
          ? '[withAndroidConfig] ✓ Yodo1 MAS Maven repos injected into root build.gradle (after mavenCentral)'
          : '[withAndroidConfig] ✓ Yodo1 MAS Maven repos already present in root build.gradle');
      }
    }
    failIfBothCheckedAndEmpty();
    return cfg;
  });

  // Pass B — settings.gradle: newer templates' dependencyResolutionManagement block.
  // No-op on Expo 54 (repos already injected in Pass A). Order-independent throw.
  config = withSettingsGradle(config, (cfg) => {
    state.settingsGradleRan = true;
    if (!state.injected) {
      const res = injectYodo1ReposIntoBlock(cfg.modResults.contents, 'dependencyResolutionManagement', '            ');
      if (res.found) {
        cfg.modResults.contents = res.contents;
        state.injected = true;
        console.log(res.changed
          ? '[withAndroidConfig] ✓ Yodo1 MAS Maven repos injected into settings.gradle dependencyResolutionManagement { repositories }'
          : '[withAndroidConfig] ✓ Yodo1 MAS Maven repos already present in settings.gradle');
      }
    }
    failIfBothCheckedAndEmpty();
    return cfg;
  });

  return config;
}

/* ─── 4. gradle.properties — Yodo1 / AndroidX flags + dormant toggle ─────────── */
//
// Yodo1 MAS + its bundled networks (and the Jetifier-dependent legacy SDKs they
// pull) require these flags. `enableDexingArtifactTransform=false` is Yodo1's
// documented workaround for multidex/dexing conflicts with some adapter SDKs.
//
// These three flags ALTER THE CURRENT BUILD PIPELINE (Jetifier rewriting + dexing
// transform behaviour) even when no Yodo1 dependency is present, so they are
// applied ONLY in Phase 2 (YODO1_ENABLED=true) to keep Phase 1 truly dormant.
// `enableDexingArtifactTransform=false` is Yodo1's documented workaround for
// multidex/dexing conflicts with some bundled adapter SDKs.
//
const YODO1_GRADLE_PROPERTIES = [
  { key: 'android.useAndroidX',                  value: 'true'  },
  { key: 'android.enableJetifier',               value: 'true'  },
  { key: 'android.enableDexingArtifactTransform', value: 'false' },
];

/**
 * Pure transform (exported for tests): idempotently set/overwrite the Yodo1
 * gradle.properties on an `expo-build-properties`-style PropertiesItem[].
 *
 * Always writes the dormant master marker `yodo1Enabled` (mirroring `enabled`).
 * The pipeline-altering AndroidX/dexing flags are written ONLY when `enabled` is
 * true (Phase 2), so Phase 1 leaves the existing build pipeline untouched.
 */
function applyYodo1GradleProperties(items, enabled = YODO1_ENABLED) {
  const props = Array.isArray(items) ? items : [];
  const upsert = (key, value) => {
    const existing = props.find((i) => i && i.type === 'property' && i.key === key);
    if (existing) existing.value = value;
    else props.push({ type: 'property', key, value });
  };

  // Master toggle marker — always present, consumed by modules/yodo1-mas build.gradle.
  upsert('yodo1Enabled', String(enabled));

  // Build-pipeline flags — Phase 2 only.
  if (enabled) {
    YODO1_GRADLE_PROPERTIES.forEach(({ key, value }) => upsert(key, value));
  }
  return props;
}

function withYodo1GradleProperties(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = applyYodo1GradleProperties(cfg.modResults, YODO1_ENABLED);
    console.log(
      `[withAndroidConfig] ✓ Yodo1 gradle.properties applied (yodo1Enabled=${YODO1_ENABLED}` +
      (YODO1_ENABLED ? ')' : ' — dormant; AndroidX/dexing flags deferred to Phase 2)')
    );
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

/* ─── Compose all patches and export ─────────────────────────────────────────── */
module.exports = function withAndroidConfig(config) {
  // Build system
  config = withAgpVersion(config);
  config = withGradleWrapper(config);
  config = withNdkVersion(config);
  config = withCppConfig(config);
  config = withSubprojectsCompileSdk(config);

  // Yodo1 MAS — mediation-network Maven repositories. These change the Gradle
  // resolution environment, so they are injected ONLY in Phase 2. Phase 1 skips
  // them entirely (no repos, no fail-loud throw) to keep the current build inert.
  if (YODO1_ENABLED) {
    config = withYodo1Repositories(config);
  }
  // Yodo1 MAS — always writes the `yodo1Enabled` marker; the pipeline-altering
  // AndroidX/dexing flags are written only when YODO1_ENABLED (Phase 2).
  config = withYodo1GradleProperties(config);

  // App assets / Google Play ownership registration
  config = withAdiRegistration(config);

  return config;
};

/* ─── Exported pure transforms (for verification harness / unit tests) ───────── */
module.exports.injectYodo1ReposIntoBlock    = injectYodo1ReposIntoBlock;
module.exports.findReposInsertIndex         = findReposInsertIndex;
module.exports.applyYodo1GradleProperties   = applyYodo1GradleProperties;
module.exports.YODO1_MAVEN_REPOS            = YODO1_MAVEN_REPOS;
module.exports.YODO1_GRADLE_PROPERTIES      = YODO1_GRADLE_PROPERTIES;
