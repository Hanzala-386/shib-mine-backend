import { initializeApp, getApps, getApp } from 'firebase/app';
import { Platform } from 'react-native';
import {
  initializeAuth,
  getAuth,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  sendEmailVerification,
  sendPasswordResetEmail,
  onAuthStateChanged,
  type User as FirebaseUser,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyDQnt9_QENqlHtMprocQnJVQkB-4IyBgjg',
  authDomain: 'shib-mine.firebaseapp.com',
  projectId: 'shib-mine',
  storageBucket: 'shib-mine.firebasestorage.app',
  messagingSenderId: '1032738643319',
  appId: '1:1032738643319:web:057ba2235420353b2a1572',
  measurementId: 'G-5TYK49Z19W',
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

function createAuth() {
  // ── Web: IndexedDB persistence (survives tab close / browser restart) ──────
  if (Platform.OS === 'web') {
    try {
      return initializeAuth(app, { persistence: indexedDBLocalPersistence });
    } catch {
      // initializeAuth throws if called more than once (hot reload) — return the
      // already-initialised instance which already has the correct persistence.
      return getAuth(app);
    }
  }

  // ── Native (Android / iOS): AsyncStorage persistence ─────────────────────
  // IMPORTANT: initializeAuth MUST be called before getAuth on first launch.
  // getAuth(app) creates an in-memory-only auth instance if initializeAuth
  // hasn't been called yet — that instance loses the session on every app close.
  try {
    // getReactNativePersistence is in the RN-specific bundle of firebase/auth.
    const { getReactNativePersistence } = require('@firebase/auth/dist/rn/index.js');
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    return initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch {
    // initializeAuth throws "already initialized" on hot reload — the existing
    // instance (created on first launch) already uses AsyncStorage persistence.
    try { return getAuth(app); } catch {}
    // Last resort — in-memory only (session lost on app close)
    return initializeAuth(app, { persistence: inMemoryPersistence });
  }
}

const auth = createAuth();

export {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  firebaseSignOut,
  sendEmailVerification,
  sendPasswordResetEmail,
  onAuthStateChanged,
  type FirebaseUser,
};
