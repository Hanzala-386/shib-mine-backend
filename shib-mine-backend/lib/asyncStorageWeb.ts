const AsyncStorageWeb = {
  getItem: (key: string): Promise<string | null> => {
    try {
      return Promise.resolve(localStorage.getItem(key));
    } catch {
      return Promise.resolve(null);
    }
  },
  setItem: (key: string, value: string): Promise<void> => {
    try {
      localStorage.setItem(key, value);
    } catch {}
    return Promise.resolve();
  },
  removeItem: (key: string): Promise<void> => {
    try {
      localStorage.removeItem(key);
    } catch {}
    return Promise.resolve();
  },
  clear: (): Promise<void> => {
    try {
      localStorage.clear();
    } catch {}
    return Promise.resolve();
  },
  getAllKeys: (): Promise<string[]> => {
    try {
      return Promise.resolve(Object.keys(localStorage));
    } catch {
      return Promise.resolve([]);
    }
  },
  multiGet: (keys: string[]): Promise<[string, string | null][]> => {
    try {
      return Promise.resolve(keys.map((k) => [k, localStorage.getItem(k)]));
    } catch {
      return Promise.resolve(keys.map((k) => [k, null]));
    }
  },
  multiSet: (pairs: [string, string][]): Promise<void> => {
    try {
      pairs.forEach(([k, v]) => localStorage.setItem(k, v));
    } catch {}
    return Promise.resolve();
  },
  multiRemove: (keys: string[]): Promise<void> => {
    try {
      keys.forEach((k) => localStorage.removeItem(k));
    } catch {}
    return Promise.resolve();
  },
};

export default AsyncStorageWeb;
