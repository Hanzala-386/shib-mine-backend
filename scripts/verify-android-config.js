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

const { applyYodo1GradleProperties, YODO1_GRADLE_PROPERTIES } = cfg;

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

console.log(`\nAll ${passed} checks passed \u2713`);
