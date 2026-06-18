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
