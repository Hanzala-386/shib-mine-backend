/* ─────────────────────────────────────────────────────────────────────────────
 * Verification harness for plugins/withAndroidConfig.js Yodo1 gradle.properties.
 *
 * Run with:  node scripts/verify-android-config.js
 *
 * Guards two contracts that the EAS Android build depends on:
 *  1. The deprecated `android.enableDexingArtifactTransform` flag (removed in AGP
 *     8.3) is never emitted into gradle.properties.
 *  2. The Phase-1 (dormant) vs Phase-2 (active) behaviour of the AndroidX/Jetifier
 *     flags + the `yodo1Enabled` marker remains correct and idempotent.
 * ──────────────────────────────────────────────────────────────────────────── */
const assert = require('assert');
const cfg = require('../plugins/withAndroidConfig.js');

const {
  applyYodo1GradleProperties,
  YODO1_GRADLE_PROPERTIES,
  injectYodo1ReposIntoBlock,
  injectSubprojectsCompileSdk,
  SUBPROJECTS_PATCH_MARKER,
  REPOS_MARKER_OPEN,
  YODO1_MAVEN_REPOS,
} = cfg;

// Representative Expo 54 / RN 0.81 root android/build.gradle (trimmed to the
// parts the plugin touches). Mirrors the real prebuild template structure:
// a buildscript { repositories {} } block AND a top-level allprojects {
// repositories {} } block. The repos must land in the LATTER, never the former.
const EXPO54_ROOT_BUILD_GRADLE = `buildscript {
    ext {
        compileSdkVersion = Integer.parseInt(findProperty('android.compileSdkVersion') ?: '36')
        ndkVersion = "27.1.12297006"
    }
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath('com.android.tools.build:gradle')
    }
}

apply plugin: "com.facebook.react.rootproject"

allprojects {
    repositories {
        google()
        mavenCentral()
        maven { url 'https://www.jitpack.io' }
    }
}
`;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  \u2713 ${name}`);
}

const byKey = (items) => Object.fromEntries(items.map((p) => [p.key, p.value]));

console.log('verify-android-config: Yodo1 gradle.properties\n');

// 1. The deprecated dexing flag must be gone from the source definition.
check('YODO1_GRADLE_PROPERTIES omits android.enableDexingArtifactTransform', () => {
  const hit = YODO1_GRADLE_PROPERTIES.find(
    (p) => p.key === 'android.enableDexingArtifactTransform'
  );
  assert.strictEqual(hit, undefined, 'deprecated dexing flag must be removed');
});

// 2. Phase 2 (enabled): AndroidX + Jetifier + marker written, NO dexing flag.
check('Phase 2 writes AndroidX/Jetifier + yodo1Enabled, no dexing flag', () => {
  const out = byKey(applyYodo1GradleProperties([], true));
  assert.strictEqual(out['yodo1Enabled'], 'true');
  assert.strictEqual(out['android.useAndroidX'], 'true');
  assert.strictEqual(out['android.enableJetifier'], 'true');
  assert.ok(
    !('android.enableDexingArtifactTransform' in out),
    'dexing flag must NOT be written in Phase 2'
  );
});

// 3. Phase 1 (disabled): only the dormant marker, no pipeline flags.
check('Phase 1 writes only the dormant yodo1Enabled=false marker', () => {
  const out = byKey(applyYodo1GradleProperties([], false));
  assert.strictEqual(out['yodo1Enabled'], 'false');
  assert.ok(!('android.useAndroidX' in out));
  assert.ok(!('android.enableJetifier' in out));
  assert.ok(!('android.enableDexingArtifactTransform' in out));
});

// 4. Idempotency: re-applying does not duplicate keys.
check('re-apply is idempotent (no duplicate keys)', () => {
  let out = applyYodo1GradleProperties([], true);
  const before = out.length;
  out = applyYodo1GradleProperties(out, true);
  assert.strictEqual(out.length, before, 'keys must not be duplicated on re-apply');
});

// 5. Stale input: an EXISTING deprecated dexing flag is stripped, others kept.
check('stale android.enableDexingArtifactTransform is stripped from existing input', () => {
  const stale = [
    { type: 'property', key: 'android.enableDexingArtifactTransform', value: 'false' },
    { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx2g' },
  ];
  // Phase 2
  const out2 = byKey(applyYodo1GradleProperties(stale, true));
  assert.ok(
    !('android.enableDexingArtifactTransform' in out2),
    'stale dexing flag must be stripped in Phase 2'
  );
  assert.strictEqual(out2['org.gradle.jvmargs'], '-Xmx2g', 'unrelated flags preserved');
  // Phase 1 (dormant) must also strip it
  const out1 = byKey(applyYodo1GradleProperties(stale, false));
  assert.ok(
    !('android.enableDexingArtifactTransform' in out1),
    'stale dexing flag must be stripped in Phase 1 too'
  );
});

// ── Maven repos injection into the native allprojects { repositories { } } ─────

// 6. Repos land INSIDE the allprojects block, after mavenCentral(), not in buildscript.
check('Yodo1 repos injected inside allprojects { repositories { } } (not buildscript)', () => {
  const res = injectYodo1ReposIntoBlock(EXPO54_ROOT_BUILD_GRADLE, 'allprojects', '        ');
  assert.ok(res.found, 'allprojects block must be found');
  assert.ok(res.changed, 'repos must be injected');

  const out = res.contents;
  // Marker + all 7 vendor repos present exactly once.
  assert.strictEqual((out.match(/yodo1-mas-repos/g) || []).length, 2, 'open+close marker present once');
  YODO1_MAVEN_REPOS.forEach((r) => {
    assert.ok(out.includes(r.line), `missing repo: ${r.marker}`);
  });

  // The injection point must be within the allprojects block, NOT the buildscript block.
  const allprojectsIdx = out.indexOf('allprojects {');
  const markerIdx = out.indexOf(REPOS_MARKER_OPEN);
  const buildscriptEndIdx = out.indexOf('}\n\napply plugin'); // end of buildscript block
  assert.ok(markerIdx > allprojectsIdx, 'repos must be after allprojects opener');
  assert.ok(markerIdx > buildscriptEndIdx, 'repos must NOT be inside buildscript block');
});

// 7. No afterEvaluate / appended-block wrapping for the repos — clean in-place injection.
check('repos injection adds NO afterEvaluate wrapper', () => {
  const res = injectYodo1ReposIntoBlock(EXPO54_ROOT_BUILD_GRADLE, 'allprojects', '        ');
  // The only allowed content added is maven repo lines + markers; never a lifecycle hook.
  const addedRegion = res.contents.slice(
    res.contents.indexOf(REPOS_MARKER_OPEN),
    res.contents.indexOf('// [/yodo1-mas-repos]')
  );
  assert.ok(!/afterEvaluate/.test(addedRegion), 'repos block must not contain afterEvaluate');
  assert.ok(!/subprojects/.test(addedRegion), 'repos block must not contain subprojects');
});

// 8. Repos injection is idempotent (marker guard prevents double-inject).
check('repos injection is idempotent', () => {
  const once = injectYodo1ReposIntoBlock(EXPO54_ROOT_BUILD_GRADLE, 'allprojects', '        ');
  const twice = injectYodo1ReposIntoBlock(once.contents, 'allprojects', '        ');
  assert.strictEqual(twice.changed, false, 'second run must be a no-op');
  assert.strictEqual(once.contents, twice.contents, 'contents unchanged on re-run');
});

// ── subprojects compileSdk patch — lifecycle safety (the build-breaking bug) ───

// 9. The subprojects patch must NOT register afterEvaluate unconditionally; it must
//    guard with subproject.state.executed so already-evaluated modules don't crash.
check('subprojects patch is evaluation-order-safe (state.executed guard)', () => {
  const res = injectSubprojectsCompileSdk(EXPO54_ROOT_BUILD_GRADLE);
  assert.ok(res.changed, 'patch must be appended');
  const out = res.contents;

  assert.ok(out.includes('subproject.state.executed'), 'must branch on state.executed');
  assert.ok(out.includes('subproject.afterEvaluate'), 'must still defer for not-yet-evaluated');
  assert.ok(out.includes('ext.compileSdk = 35'), 'must still force compileSdk 35');
  assert.ok(/catch\s*\(\s*Throwable/.test(out), 'late-write must be best-effort (try/catch)');

  // Regression: the OLD unguarded pattern `subprojects {\n    afterEvaluate { project ->`
  // (which threw "already evaluated") must be gone.
  assert.ok(
    !/subprojects\s*\{\s*\n\s*afterEvaluate\s*\{\s*project\s*->/.test(out),
    'old unguarded subprojects { afterEvaluate { project -> } } pattern must be removed'
  );
});

// 10. subprojects patch is idempotent (marker guard).
check('subprojects patch is idempotent', () => {
  const once = injectSubprojectsCompileSdk(EXPO54_ROOT_BUILD_GRADLE);
  const twice = injectSubprojectsCompileSdk(once.contents);
  assert.strictEqual(twice.changed, false, 'second run must be a no-op');
  assert.strictEqual(
    (once.contents.match(new RegExp(SUBPROJECTS_PATCH_MARKER.replace(/[[\]]/g, '\\$&'), 'g')) || []).length,
    1,
    'patch marker must appear exactly once'
  );
});

// 11. Brace balance sanity: applying BOTH transforms keeps { } balanced.
check('both transforms together keep braces balanced', () => {
  let out = injectSubprojectsCompileSdk(EXPO54_ROOT_BUILD_GRADLE).contents;
  out = injectYodo1ReposIntoBlock(out, 'allprojects', '        ').contents;
  const opens = (out.match(/\{/g) || []).length;
  const closes = (out.match(/\}/g) || []).length;
  assert.strictEqual(opens, closes, `unbalanced braces: ${opens} open vs ${closes} close`);
});

console.log(`\nAll ${passed} checks passed \u2713`);
