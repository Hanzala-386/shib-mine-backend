import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { getApiUrl } from '@/lib/query-client';

export type SecurityBlockType = 'root' | 'vpn' | 'adblock' | null;

interface SecurityContextValue {
  blockType: SecurityBlockType;
  isChecking: boolean;
  retryCheck: () => Promise<void>;
}

const SecurityContext = createContext<SecurityContextValue>({
  blockType: null,
  isChecking: false,
  retryCheck: async () => {},
});

export function useSecurity() { return useContext(SecurityContext); }

// ── Lazy-loaded native modules (only available on Android/iOS native builds) ──
let Device: any = null;
let Network: any = null;
let NetworkStateType: any = null;
let JailMonkey: any = null;

if (Platform.OS !== 'web') {
  try { Device = require('expo-device'); } catch {}
  try {
    const net = require('expo-network');
    Network = net;
    NetworkStateType = net.NetworkStateType;
  } catch {}
  try {
    /* jail-monkey is a native module — available in EAS/production builds.
     * In Expo Go it throws on require; we silently catch and fall back to
     * expo-device's isRootedExperimentalAsync() instead. */
    JailMonkey = require('jail-monkey').default;
  } catch {}
}

// ── Root / Jailbreak detection ────────────────────────────────────────────────
// Two-layer check:
//   Layer 1 (deep): jail-monkey — multi-vector scan: su binary, known root
//     apps, SafetyNet, Magisk, frida server, RW system partition, JB
//     tweaks, Cydia, etc. Only available in EAS/production native builds.
//   Layer 2 (fallback): expo-device.isRootedExperimentalAsync — OS-level
//     flag. Less thorough but works in all native contexts including Expo Go.
// Always returns false on web or in __DEV__ (guard is in the provider).
async function checkRoot(): Promise<boolean> {
  if (Platform.OS === 'web') return false;

  // Layer 1 — jail-monkey (preferred, thorough)
  if (JailMonkey) {
    try {
      // isJailBroken() covers both Android root and iOS jailbreak
      if (JailMonkey.isJailBroken())          return true;
      // canMockLocation() — detects mock-location / GPS spoofer apps (often
      // used alongside cheat tools on Android)
      if (JailMonkey.canMockLocation())        return true;
      // isOnExternalStorage() — APK was moved to SD card / unsigned re-sign
      if (JailMonkey.isOnExternalStorage())    return true;
      // isDebugged() — active debugger session (frida, ida pro, etc.)
      if (JailMonkey.isDebugged())             return true;
    } catch { /* native call failed — continue to fallback */ }
  }

  // Layer 2 — expo-device fallback (Expo Go + older builds)
  if (Device) {
    try {
      return !!(await Device.isRootedExperimentalAsync());
    } catch {}
  }

  return false;
}

// ── VPN detection (expo-network, Android only) ────────────────────────────────
// iOS does not expose VPN type to JS; Android NetworkStateType.VPN is reliable.
async function checkVPN(): Promise<boolean> {
  if (!Network || !NetworkStateType || Platform.OS !== 'android') return false;
  try {
    const state = await Network.getNetworkStateAsync();
    return state.type === NetworkStateType.VPN;
  } catch { return false; }
}

// ── Ad-blocker / DNS-filter probe ─────────────────────────────────────────────
// Probes known Google Ads URLs that DNS blockers reliably intercept.
// Only triggers if the backend is reachable (excludes no-internet scenarios).
//
// Mobile-data safety: DNS blocks fail almost instantly (< ~1 s) because DNS
// resolution returns NXDOMAIN immediately.  A slow mobile/cellular connection
// that simply times out takes the full timeout duration before failing — that is
// NOT an ad-blocker.  We distinguish the two by measuring elapsed probe time
// and only counting "fast fails" (< DNS_BLOCK_THRESHOLD_MS) as DNS blocks.
// We require ≥ 2 fast-fails out of 3 probes to avoid single-probe false positives.
async function checkAdBlocker(): Promise<boolean> {
  if (Platform.OS === 'web') return false; // CORS makes probes unreliable on web

  // Step 1: Verify internet + backend is reachable (increased timeout for mobile data)
  const apiBase = getApiUrl();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    await fetch(`${apiBase}/api/app/settings`, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
  } catch {
    return false; // No internet / backend down — do not blame an ad-blocker
  }

  // Step 2: Probe three Google Ads URLs.
  // DNS block  → fails in < DNS_BLOCK_THRESHOLD_MS  (immediate NXDOMAIN)
  // Slow net   → fails after full PROBE_TIMEOUT_MS   (request timeout, not a block)
  const PROBES = [
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://googleads.g.doubleclick.net/pagead/id',
    'https://adservice.google.com/adsid/integrator.js',
  ];
  const PROBE_TIMEOUT_MS      = 10000; // generous timeout for mobile data
  const DNS_BLOCK_THRESHOLD_MS = 1500; // DNS NXDOMAIN/reset < 1.5 s; network timeout ≥ several s

  let fastFailCount = 0;

  for (const url of PROBES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const startMs = Date.now();
    try {
      await fetch(url, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      return false; // At least one ad URL reachable → no blocker
    } catch {
      clearTimeout(timer);
      const elapsed = Date.now() - startMs;
      if (elapsed < DNS_BLOCK_THRESHOLD_MS) {
        // Fast failure = DNS block or connection reset by filter
        fastFailCount++;
        if (fastFailCount >= 2) return true; // 2 fast-fails = confirmed ad-blocker
      }
      // Slow failure (timeout) = poor/cellular network — NOT an ad-blocker signal
    }
  }

  // Require ≥ 2 fast-fails to avoid single-probe false positives on mobile data
  return fastFailCount >= 2;
}

// ── Provider ──────────────────────────────────────────────────────────────────
export function SecurityProvider({ children }: { children: React.ReactNode }) {
  const [blockType, setBlockType] = useState<SecurityBlockType>(null);
  const [isChecking, setIsChecking] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const runFullCheck = useCallback(async (): Promise<SecurityBlockType> => {
    // Root (fast, synchronous-ish)
    if (await checkRoot()) return 'root';
    // VPN (fast)
    if (await checkVPN()) return 'vpn';
    // Ad-blocker (slow — requires network round-trip)
    if (await checkAdBlocker()) return 'adblock';
    return null;
  }, []);

  const retryCheck = useCallback(async () => {
    setIsChecking(true);
    const result = await runFullCheck();
    setBlockType(result);
    setIsChecking(false);
  }, [runFullCheck]);

  useEffect(() => {
    // ⚠ Skip ALL security checks in development (Expo Go, Replit preview).
    // Replit/corporate networks block Google Ads domains, causing false positives.
    // In production native builds __DEV__ is always false — checks run normally.
    if (__DEV__) return;

    // Initial checks on mount (non-blocking — app can load while ad probe runs)
    (async () => {
      // Root + VPN are fast — run immediately
      if (await checkRoot()) { setBlockType('root'); return; }
      if (await checkVPN())  { setBlockType('vpn');  return; }
      // Ad-blocker probe is slower — run in background
      if (await checkAdBlocker()) setBlockType('adblock');
    })();

    // Re-check VPN + ad-blocker every 60 seconds
    intervalRef.current = setInterval(async () => {
      if (await checkVPN())       { setBlockType('vpn');     return; }
      if (await checkAdBlocker()) { setBlockType('adblock'); return; }
      // If previously blocked by vpn/adblock and now clear, unblock
      setBlockType(prev => (prev === 'vpn' || prev === 'adblock') ? null : prev);
    }, 60_000);

    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  return (
    <SecurityContext.Provider value={{ blockType, isChecking, retryCheck }}>
      {children}
    </SecurityContext.Provider>
  );
}
