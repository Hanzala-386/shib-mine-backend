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

  return config;
};

/* ─── Exported pure transforms (for verification harness / unit tests) ───────── */
module.exports.filterDeprecatedGradleKeys  = filterDeprecatedGradleKeys;
module.exports.injectSubprojectsCompileSdk = injectSubprojectsCompileSdk;
module.exports.SUBPROJECTS_PATCH_MARKER    = SUBPROJECTS_PATCH_MARKER;
