// Hardcoded native app version for the currently compiled bundle.
// IMPORTANT: bump this to match app.json `expo.version` on every production APK build
// (e.g. change to "1.0.2" for the next release). The force-update gate compares this
// value against app_config.min_required_version in PocketBase.
export const INSTALLED_APP_VERSION = '1.0.4';

// Semantic version comparison via per-segment numeric compare.
// Returns true when `current` is strictly lower than `minimum`.
// Handles multi-digit jumps correctly (e.g. "1.10.0" is NOT lower than "1.2.0").
export function isVersionLower(current: string, minimum: string): boolean {
  if (!minimum || minimum.trim() === '') return false;
  const currParts = current.split('.').map(Number);
  const minParts = minimum.split('.').map(Number);
  const len = Math.max(currParts.length, minParts.length);
  for (let i = 0; i < len; i++) {
    const currNum = currParts[i] || 0;
    const minNum = minParts[i] || 0;
    if (currNum < minNum) return true;
    if (currNum > minNum) return false;
  }
  return false;
}
