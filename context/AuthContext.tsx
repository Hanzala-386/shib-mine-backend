import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  firebaseSignOut,
  sendEmailVerification,
  onAuthStateChanged,
  type FirebaseUser,
} from '@/lib/firebase';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  username: string;
  referralCode: string;
  referredBy?: string;
  createdAt: number;
  emailVerified: boolean;
}

const ADMIN_EMAIL = 'hanzala386@gmail.com';

interface AuthContextValue {
  user: UserProfile | null;
  firebaseUser: FirebaseUser | null;
  isLoading: boolean;
  isAdmin: boolean;
  signUp: (email: string, password: string, username: string, displayName: string, referralCode?: string) => Promise<{ needsVerification: boolean }>;
  signIn: (email: string, password: string) => Promise<{ needsVerification: boolean }>;
  signOut: () => Promise<void>;
  resendVerification: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function generateReferralCode(): string {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser && fbUser.emailVerified) {
        const profile = await loadProfile(fbUser.uid);
        if (profile) {
          setUser({ ...profile, emailVerified: true });
        }
      } else {
        setUser(null);
      }
      setIsLoading(false);
    });
    return unsubscribe;
  }, []);

  async function loadProfile(uid: string): Promise<UserProfile | null> {
    try {
      const raw = await AsyncStorage.getItem(`shib_profile_${uid}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async function saveProfile(profile: UserProfile) {
    await AsyncStorage.setItem(`shib_profile_${profile.uid}`, JSON.stringify(profile));
  }

  async function signUp(email: string, password: string, username: string, displayName: string, referralCode?: string): Promise<{ needsVerification: boolean }> {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const profile: UserProfile = {
      uid: cred.user.uid,
      email: email.toLowerCase(),
      displayName,
      username,
      referralCode: generateReferralCode(),
      referredBy: referralCode?.toUpperCase(),
      createdAt: Date.now(),
      emailVerified: false,
    };
    await saveProfile(profile);
    await sendEmailVerification(cred.user);
    setFirebaseUser(cred.user);
    return { needsVerification: true };
  }

  async function signIn(email: string, password: string): Promise<{ needsVerification: boolean }> {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    if (!cred.user.emailVerified) {
      return { needsVerification: true };
    }
    const profile = await loadProfile(cred.user.uid);
    if (profile) {
      const updated = { ...profile, emailVerified: true };
      await saveProfile(updated);
      setUser(updated);
    }
    setFirebaseUser(cred.user);
    return { needsVerification: false };
  }

  async function signOut() {
    await firebaseSignOut(auth);
    setUser(null);
    setFirebaseUser(null);
  }

  async function resendVerification() {
    if (firebaseUser) {
      await sendEmailVerification(firebaseUser);
    }
  }

  async function refreshUser() {
    if (firebaseUser) {
      await firebaseUser.reload();
      if (firebaseUser.emailVerified) {
        const profile = await loadProfile(firebaseUser.uid);
        if (profile) {
          const updated = { ...profile, emailVerified: true };
          await saveProfile(updated);
          setUser(updated);
          setFirebaseUser({ ...firebaseUser });
        }
      }
    }
  }

  const isAdmin = firebaseUser?.email?.toLowerCase() === ADMIN_EMAIL;

  const value = useMemo(() => ({
    user, firebaseUser, isLoading, isAdmin,
    signUp, signIn, signOut, resendVerification, refreshUser,
  }), [user, firebaseUser, isLoading, isAdmin]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
