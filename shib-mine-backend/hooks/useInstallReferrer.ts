import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@shib_install_referrer_code';

let InstallReferrer: any = null;
try {
  InstallReferrer = require('react-native-install-referrer').InstallReferrer;
} catch {
  // Not available in Expo Go — works in EAS / production builds
}

async function readAndCacheReferrer(): Promise<string | null> {
  try {
    const cached = await AsyncStorage.getItem(STORAGE_KEY);
    if (cached !== null) return cached;
  } catch {
    return null;
  }

  if (Platform.OS !== 'android' || !InstallReferrer) return null;

  return new Promise<string | null>((resolve) => {
    try {
      InstallReferrer.getInstallReferrer((err: any, details: any) => {
        if (err || !details?.installReferrer) {
          resolve(null);
          return;
        }
        const referrerStr: string = details.installReferrer;
        // referrer string looks like: "ref_code=ABC123" or "utm_source=...&ref_code=ABC123"
        const match = referrerStr.match(/ref_code=([^&]+)/);
        const code = match ? decodeURIComponent(match[1]) : null;
        if (code) {
          AsyncStorage.setItem(STORAGE_KEY, code).catch(() => {});
        }
        resolve(code);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Reads the Play Store install referrer (Android only) and extracts the
 * ref_code parameter.  Result is cached in AsyncStorage so it survives
 * across app restarts without hitting the native API again.
 *
 * Returns null on iOS, web, Expo Go, or when no referral code was present.
 */
export function useInstallReferrer(): string | null {
  const [referralCode, setReferralCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readAndCacheReferrer().then((code) => {
      if (!cancelled && code) setReferralCode(code);
    });
    return () => { cancelled = true; };
  }, []);

  return referralCode;
}
