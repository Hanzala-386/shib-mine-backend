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
  try {
    return getAuth(app);
  } catch { }

  if (Platform.OS === 'web') {
    try {
      return initializeAuth(app, { persistence: indexedDBLocalPersistence });
    } catch {
      return getAuth(app);
    }
  }

  try {
    const { getReactNativePersistence } = require('@firebase/auth/react-native');
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    return initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  } catch {
    try {
      return initializeAuth(app, { persistence: inMemoryPersistence });
    } catch {
      return getAuth(app);
    }
  }
}

const auth = createAuth();

export {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  firebaseSignOut,
  sendEmailVerification,
  onAuthStateChanged,
  type FirebaseUser,
};
