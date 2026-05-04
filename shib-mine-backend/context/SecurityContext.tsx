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

if (Platform.OS !== 'web') {
  try { Device = require('expo-device'); } catch {}
  try {
    const net = require('expo-network');
    Network = net;
    NetworkStateType = net.NetworkStateType;
  } catch {}
}

// ── Root detection (expo-device) ──────────────────────────────────────────────
// Returns true if the device is rooted/jailbroken.
// NOTE: Always false in Expo Go and development; works fully in production builds.
async function checkRoot(): Promise<boolean> {
  if (!Device || Platform.OS === 'web') return false;
  try {
    return !!(await Device.isRootedExperimentalAsync());
  } catch { return false; }
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
async function checkAdBlocker(): Promise<boolean> {
  if (Platform.OS === 'web') return false; // CORS makes probes unreliable on web

  // Step 1: Verify internet + backend is reachable
  const apiBase = getApiUrl();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    await fetch(`${apiBase}/api/app/settings`, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
  } catch {
    return false; // No internet / backend down — do not blame an ad-blocker
  }

  // Step 2: Probe Google Ads URLs — these are always intercepted by DNS filters
  const PROBES = [
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://googleads.g.doubleclick.net/pagead/id',
  ];

  for (const url of PROBES) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      await fetch(url, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      return false; // Reached an ad URL — no blocker active
    } catch {
      clearTimeout(t);
      // This probe failed — try next one
    }
  }
  return true; // All probes blocked while backend is reachable → ad-blocker
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
