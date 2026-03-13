/**
 * Platform-safe AsyncStorage wrapper.
 *
 * On web: uses localStorage directly — avoids the @react-native-async-storage
 * native module binding that crashes when RNCAsyncStorage is undefined.
 * On native: delegates to @react-native-async-storage/async-storage.
 *
 * Import this module instead of AsyncStorage directly in all contexts.
 */
import { Platform } from 'react-native';

interface SafeStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const webStorage: SafeStorage = {
  getItem: async (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  setItem: async (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* ignore quota errors */ }
  },
  removeItem: async (key) => {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

function makeNativeStorage(): SafeStorage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-async-storage/async-storage');
    const AS = mod?.default ?? mod;
    if (AS && typeof AS.getItem === 'function') return AS as SafeStorage;
  } catch { /* native module not available */ }
  // Ultimate fallback (should never be reached on a real device)
  return {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };
}

const storage: SafeStorage = Platform.OS === 'web' ? webStorage : makeNativeStorage();

export default storage;
