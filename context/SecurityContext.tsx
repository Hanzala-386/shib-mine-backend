import React, {
  createContext, useContext, useCallback,
  useEffect, useRef, useState,
} from 'react';
import { Platform } from 'react-native';
import { getApiUrl } from '@/lib/query-client';
import { requestIntegrityToken } from '@/lib/playIntegrity';
import {
  getEnabledAccessibilityServices,
  getInstalledBlacklistedPackages,
  isAutoClickerDetectorAvailable,
} from '@/modules/auto-clicker-detector';

// ── Block types ───────────────────────────────────────────────────────────────
// 'root'          — rooted / jailbroken device detected (jail-monkey / expo-device)
// 'emulator'      — running on an Android emulator or iOS simulator
// 'autoclicker'   — statistically uniform tap intervals detected by in-game TapMonitor
// 'accessibility' — an auto-clicker / macro app is ENABLED as an accessibility service
// 'integrity'     — Google Play Integrity API verdict: device does not meet integrity
// 'adblock'       — DNS-level ad-blocker / filter detected
export type SecurityBlockType =
  | 'root'
  | 'emulator'
  | 'autoclicker'
  | 'accessibility'
  | 'integrity'
  | 'adblock'
  | null;

interface SecurityContextValue {
  blockType:          SecurityBlockType;
  isChecking:         boolean;
  retryCheck:         () => Promise<void>;
  /** Call from games.tsx when TapMonitor reports suspicious intervals. */
  triggerAutoClicker: () => void;
}

const SecurityContext = createContext<SecurityContextValue>({
  blockType:          null,
  isChecking:         false,
  retryCheck:         async () => {},
  triggerAutoClicker: () => {},
});

export function useSecurity() { return useContext(SecurityContext); }

// ── Lazy-load native modules ──────────────────────────────────────────────────
// jail-monkey and expo-device require a native runtime.  We require() lazily
// so the app does not crash in web or Expo Go when modules are absent.
let Device:     any = null;
let JailMonkey: any = null;

if (Platform.OS !== 'web') {
  try { Device     = require('expo-device');          } catch {}
  try {
    /**
     * jail-monkey covers Android root AND iOS jailbreak detection:
     *   • su binary / busybox paths          (Android root)
     *   • test-keys release signatures       (Android — unsigned/unofficial ROM)
     *   • Magisk / SuperSU / KingoRoot       (Android)
     *   • Frida server / debugger attached   (both platforms)
     *   • Cydia / Sileo / unc0ver presence  (iOS jailbreak)
     *   • Writable /system partition          (Android)
     *   • App on external storage (re-signed) (Android)
     *
     * Requires EAS / production native build.  In Expo Go the require()
     * throws at runtime; we silently catch and fall through to expo-device.
     */
    JailMonkey = require('jail-monkey').default;
  } catch {}
}

// ── FLAG DEVICE ON BACKEND ────────────────────────────────────────────────────
// Fire-and-forget.  Writes is_flagged=true + flag_reason to the user's
// PocketBase record so admins can audit flagged accounts.
async function flagDeviceOnBackend(pbId: string, reason: string): Promise<void> {
  if (!pbId) return;
  try {
    const base = getApiUrl();
    await fetch(`${base}/api/app/security/flag-device`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ pbId, reason }),
    });
  } catch {
    // Non-critical — device is blocked locally regardless of whether
    // the backend write succeeds.
  }
}

// ── LAYER 1: Root / Jailbreak ─────────────────────────────────────────────────
async function checkRoot(): Promise<boolean> {
  if (Platform.OS === 'web') return false;

  // Sub-layer A — jail-monkey (comprehensive binary-level scan)
  if (JailMonkey) {
    try {
      if (JailMonkey.isJailBroken())       return true; // su / Cydia / tweaks
      if (JailMonkey.canMockLocation())    return true; // GPS spoofer (cheat tool signal)
      if (JailMonkey.isOnExternalStorage()) return true; // APK re-signed / moved to SD card
      if (JailMonkey.isDebugged())         return true; // Frida / IDA Pro debugger attached
    } catch { /* native call failed — continue to fallback */ }
  }

  // Sub-layer B — expo-device OS flag (works in Expo Go; less thorough)
  if (Device) {
    try {
      return !!(await Device.isRootedExperimentalAsync());
    } catch {}
  }

  return false;
}

// ── LAYER 2: Emulator / Simulator detection ───────────────────────────────────
// Checks expo-device.isDevice and model-name heuristics.
// Running the reward game on an emulator is a strong signal of scripted abuse.
async function checkEmulator(): Promise<boolean> {
  // iOS simulators are dev tools — skip on iOS to avoid blocking developers
  if (Platform.OS !== 'android') return false;
  if (!Device)                   return false;

  try {
    // expo-device sets isDevice=false on AVD / Genymotion
    if (Device.isDevice === false) return true;

    // Cross-check model name for common emulator fingerprints that slip
    // through isDevice (e.g., some cloud-testing farms or cloned devices)
    const model = ((Device.modelName ?? '') as string).toLowerCase();
    const emulatorMarkers = [
      'emulator', 'sdk_gphone', 'android sdk built', 'generic',
      'genymotion', 'goldfish', 'vbox', 'nox',
    ];
    if (emulatorMarkers.some(m => model.includes(m))) return true;
  } catch {}

  return false;
}

// ── LAYER 3: Google Play Integrity ────────────────────────────────────────────
// Requests an on-device attestation token, forwards it to the Railway
// backend which verifies the MEETS_DEVICE_INTEGRITY verdict via Google's API.
// Returns true when the device FAILS integrity (should be blocked).
async function checkPlayIntegrity(pbId: string): Promise<boolean> {
  // Nonce: 16-char random string (not a security secret — just replay protection
  // for the token request itself; the server verifies via Google's signed JWT).
  const nonce = Math.random().toString(36).slice(2, 10)
              + Math.random().toString(36).slice(2, 10);

  const token = await requestIntegrityToken(nonce);
  if (!token) {
    // Module unavailable (Expo Go / iOS / web / __DEV__) — fail open.
    return false;
  }

  try {
    const base = getApiUrl();
    const resp = await fetch(`${base}/api/app/security/verify-integrity`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token, pbId, nonce }),
    });
    if (!resp.ok) return false; // Server error — fail open
    const data = await resp.json();
    // data.pass === false means device does NOT meet integrity
    return data.pass === false;
  } catch {
    return false; // Network error — fail open
  }
}

// ── LAYER 4: Ad-blocker / DNS-filter probe ────────────────────────────────────
// Probes known Google Ads URLs that DNS blockers reliably intercept.
// Only triggers on fast failures (< threshold) to distinguish true DNS blocks
// from slow mobile-data timeouts.  Requires ≥ 2 fast-fails out of 3 probes.
async function checkAdBlocker(): Promise<boolean> {
  if (Platform.OS === 'web') return false;

  // Verify internet is reachable first (avoids false positives offline)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    await fetch('https://api.webcod.in/api/health', { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
  } catch {
    return false; // Offline — not an ad-blocker
  }

  const PROBES = [
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://googleads.g.doubleclick.net/pagead/id',
    'https://adservice.google.com/adsid/integrator.js',
  ];
  const PROBE_TIMEOUT_MS       = 10_000;
  const DNS_BLOCK_THRESHOLD_MS = 1_500; // NXDOMAIN/reset < 1.5 s; real timeout ≥ several s

  let fastFailCount = 0;

  for (const url of PROBES) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const t0    = Date.now();
    try {
      await fetch(url, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      return false; // At least one ad URL reachable → no DNS block
    } catch {
      clearTimeout(timer);
      if (Date.now() - t0 < DNS_BLOCK_THRESHOLD_MS) {
        fastFailCount++;
        if (fastFailCount >= 2) return true;
      }
    }
  }

  return fastFailCount >= 2;
}

// ── LAYER 5: Accessibility-service auto-clicker scan (Android) ─────────────────
// Auto-clicker / macro apps must register an Android AccessibilityService to
// synthesize taps. We enumerate the user-ENABLED accessibility services (no
// QUERY_ALL_PACKAGES needed → Play-Store compliant) and flag any whose package /
// id / label / description matches a known clicker package or a suspicious word.
const SUSPICIOUS_ACCESSIBILITY_STRINGS = [
  'clicker', 'auto', 'tapping', 'macro', 'touch', 'automation',
];
const BLACKLIST_ACCESSIBILITY_PACKAGES = [
  'com.truedevelopersstudio.automatictap.autoclicker',
  'simplehat.clicker',
  'com.p000ison.autoclicker',
  'com.phonephreak.autoclicker',
];

function checkAccessibilityAutoClicker(): boolean {
  // No-op unless the native module is compiled in (production Android APK).
  if (!isAutoClickerDetectorAvailable()) return false;

  // (A) INSTALLED known auto-clicker apps — exact package match only, restricted to
  // the IDs declared in the module's <queries> manifest (no QUERY_ALL_PACKAGES →
  // Play compliant). Catches floating-overlay clickers that synthesize taps without
  // ever appearing as an enabled accessibility service.
  if (getInstalledBlacklistedPackages().length > 0) return true;

  // (B) ENABLED accessibility services matching a known clicker package / keyword.
  const services = getEnabledAccessibilityServices();
  for (const svc of services) {
    const pkg   = (svc.packageName ?? '').toLowerCase();
    const id    = (svc.id ?? '').toLowerCase();
    const label = (svc.label ?? '').toLowerCase();
    const desc  = (svc.description ?? '').toLowerCase();

    // 1) Exact known auto-clicker packages
    if (BLACKLIST_ACCESSIBILITY_PACKAGES.some(b => {
      const bl = b.toLowerCase();
      return pkg.includes(bl) || id.includes(bl);
    })) {
      return true;
    }

    // 2) Suspicious keyword anywhere in package / id / label / description
    const haystack = `${pkg} ${id} ${label} ${desc}`;
    if (SUSPICIOUS_ACCESSIBILITY_STRINGS.some(w => haystack.includes(w))) {
      return true;
    }
  }
  return false;
}

// ── Provider ──────────────────────────────────────────────────────────────────
export function SecurityProvider({ children }: { children: React.ReactNode }) {
  const [blockType,  setBlockType]  = useState<SecurityBlockType>(null);
  const [isChecking, setIsChecking] = useState(false);
  // Store pbId so flagDeviceOnBackend can use it after auth resolves
  const pbIdRef    = useRef<string>('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // games.tsx (TapMonitor) calls this when it detects scripted taps
  const triggerAutoClicker = useCallback(() => {
    setBlockType('autoclicker');
    flagDeviceOnBackend(pbIdRef.current, 'autoclicker').catch(() => {});
  }, []);

  const runFullCheck = useCallback(async (): Promise<SecurityBlockType> => {
    if (await checkRoot())                         return 'root';
    if (await checkEmulator())                     return 'emulator';
    if (await checkPlayIntegrity(pbIdRef.current)) return 'integrity';
    if (await checkAdBlocker())                    return 'adblock';
    return null;
  }, []);

  const retryCheck = useCallback(async () => {
    setIsChecking(true);
    const result = await runFullCheck();
    setBlockType(result);
    setIsChecking(false);
  }, [runFullCheck]);

  useEffect(() => {
    // ⚠ Skip ALL security checks in __DEV__ (Expo Go / Replit sandbox).
    // Corporate networks block Google Ads domains → false ad-block positives.
    // __DEV__ is always false in production APK builds — checks run normally.
    if (__DEV__) return;

    // Root check: fast, synchronous-ish — runs immediately on startup
    (async () => {
      if (await checkRoot()) {
        setBlockType('root');
        flagDeviceOnBackend(pbIdRef.current, 'root').catch(() => {});
        return;
      }
      // Emulator check: also fast
      if (await checkEmulator()) {
        setBlockType('emulator');
        flagDeviceOnBackend(pbIdRef.current, 'emulator').catch(() => {});
      }
    })();

    // Play Integrity + ad-blocker: network-dependent, delayed 10 s to avoid
    // competing with app startup requests (auth restore, settings fetch, etc.)
    const delayedTimer = setTimeout(async () => {
      if (blockType === 'root' || blockType === 'emulator') return; // already blocked

      if (await checkPlayIntegrity(pbIdRef.current)) {
        setBlockType('integrity');
        flagDeviceOnBackend(pbIdRef.current, 'play_integrity').catch(() => {});
        return;
      }

      if (await checkAdBlocker()) setBlockType('adblock');
    }, 10_000);

    // Re-check ad-blocker every 60 s (no VPN check — unreliable on CGNAT carriers)
    intervalRef.current = setInterval(async () => {
      if (await checkAdBlocker()) {
        setBlockType('adblock');
        return;
      }
      setBlockType(prev => prev === 'adblock' ? null : prev);
    }, 60_000);

    return () => {
      clearTimeout(delayedTimer);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Accessibility auto-clicker watcher ───────────────────────────────────────
  // Runs OUTSIDE the __DEV__ guard on purpose: the native module is only present
  // in the production Android APK, so this effect no-ops in Expo Go / web / iOS
  // (isAutoClickerDetectorAvailable() === false) and activates automatically in
  // the real build. Scans on launch and every 5 s thereafter.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!isAutoClickerDetectorAvailable()) return; // Expo Go / module absent → no-op

    const scan = () => {
      if (checkAccessibilityAutoClicker()) {
        // Don't clobber a higher-severity block (root / emulator / integrity).
        setBlockType(prev => prev ?? 'accessibility');
        flagDeviceOnBackend(pbIdRef.current, 'accessibility_autoclicker').catch(() => {});
      } else {
        // Auto-clear once the offending service is turned off.
        setBlockType(prev => (prev === 'accessibility' ? null : prev));
      }
    };

    scan(); // immediate check on launch (well within the 3–5 s requirement)
    const accId = setInterval(scan, 5_000);
    return () => clearInterval(accId);
  }, []);

  return (
    <SecurityContext.Provider value={{ blockType, isChecking, retryCheck, triggerAutoClicker }}>
      {children}
    </SecurityContext.Provider>
  );
}
