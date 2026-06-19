import { requireOptionalNativeModule } from 'expo-modules-core';

export interface EnabledAccessibilityService {
  /** Flattened component id, e.g. "com.pkg/.MyService" */
  id: string;
  /** Owning package name, e.g. "simplehat.clicker" */
  packageName: string;
  /** Human-readable service label (may be null) */
  label: string | null;
  /** Service description text declared in its config (may be null) */
  description: string | null;
}

// Local Android-only Expo module. Absent on web / iOS / Expo Go (no native
// runtime) — requireOptionalNativeModule() returns null instead of throwing,
// so every helper below degrades to a safe no-op off-device.
const AutoClickerDetectorModule = requireOptionalNativeModule('AutoClickerDetector');

/** True only when the compiled native module is present (production Android APK). */
export function isAutoClickerDetectorAvailable(): boolean {
  return AutoClickerDetectorModule != null;
}

/**
 * Returns the list of currently ENABLED accessibility services.
 * Reading this list does NOT require QUERY_ALL_PACKAGES — it only exposes
 * services the user has explicitly turned on (which is exactly what an
 * auto-clicker needs to operate), keeping the scan Play-Store compliant.
 */
export function getEnabledAccessibilityServices(): EnabledAccessibilityService[] {
  if (!AutoClickerDetectorModule) return [];
  try {
    return (AutoClickerDetectorModule.getEnabledAccessibilityServices() ?? []) as EnabledAccessibilityService[];
  } catch {
    return [];
  }
}

/**
 * Known high-confidence auto-clicker / macro package IDs. MUST stay in sync with the
 * <queries> entries in android/src/main/AndroidManifest.xml — on Android 11+ only
 * these specific packages are visible to getPackageInfo (no QUERY_ALL_PACKAGES →
 * Play-Store compliant). Keep this list to EXACT, high-confidence IDs only.
 */
export const BLACKLISTED_AUTOCLICKER_PACKAGES = [
  'com.truedevelopersstudio.automatictap.autoclicker',
  'simplehat.clicker',
  'com.p000ison.autoclicker',
  'com.phonephreak.autoclicker',
];

/**
 * Returns the subset of `packages` that are currently INSTALLED on the device.
 * Catches floating-overlay auto-clickers even when they are not registered as an
 * enabled accessibility service. Safe no-op ([]) off-device / module absent.
 */
export function getInstalledBlacklistedPackages(
  packages: string[] = BLACKLISTED_AUTOCLICKER_PACKAGES,
): string[] {
  if (!AutoClickerDetectorModule) return [];
  try {
    return (AutoClickerDetectorModule.getInstalledBlacklistedPackages(packages) ?? []) as string[];
  } catch {
    return [];
  }
}
