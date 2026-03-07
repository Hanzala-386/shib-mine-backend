import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  firebaseSignOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  type FirebaseUser,
} from '@/lib/firebase';
import { api, type PBUser } from '@/lib/api';

export interface UserProfile {
  uid: string;
  pbId: string;
  email: string;
  displayName: string;
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
  pbUser: PBUser | null;
  signUp: (email: string, password: string, displayName: string, referredBy?: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  verifyOtp: (email: string, code: string) => Promise<{ success: boolean; error?: string }>;
  resendOtp: (email: string) => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function generateReferralCode(): string {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function pbToProfile(u: PBUser, fbUser: FirebaseUser): UserProfile {
  return {
    uid: fbUser.uid,
    pbId: u.pbId,
    email: u.email,
    displayName: u.displayName,
    referralCode: u.referralCode,
    referredBy: u.referredBy || undefined,
    createdAt: new Date(u.created).getTime(),
    emailVerified: u.is_verified,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [pbUser, setPbUser] = useState<PBUser | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (fbUser) => {
      handleAuthStateChange(fbUser);
    });
    return unsubscribe;
  }, []);

  async function handleAuthStateChange(fbUser: FirebaseUser | null) {
    setFirebaseUser(fbUser);
    if (!fbUser) {
      setUser(null);
      setPbUser(null);
      setIsLoading(false);
      return;
    }

    try {
      const pb = await withTimeout(api.getUser(fbUser.uid), 8000, null);
      if (pb?.is_verified) {
        await syncWithServer(fbUser, pb);
      } else {
        setUser(null);
        setPbUser(pb);
      }
    } catch {
      setUser(null);
      setPbUser(null);
    }
    setIsLoading(false);
  }

  async function syncWithServer(fbUser: FirebaseUser, existingPb?: PBUser | null): Promise<void> {
    try {
      let pb = existingPb ?? await api.getUser(fbUser.uid).catch(() => null);

      if (!pb) {
        const cached = await AsyncStorage.getItem(`shib_pending_${fbUser.uid}`);
        const pending = cached ? JSON.parse(cached) : {};
        pb = await api.syncUser({
          firebaseUid: fbUser.uid,
          email: fbUser.email ?? '',
          displayName: pending.displayName || fbUser.displayName || fbUser.email?.split('@')[0] || '',
          referralCode: pending.referralCode || generateReferralCode(),
          referredBy: pending.referredBy || '',
        });
        if (cached) await AsyncStorage.removeItem(`shib_pending_${fbUser.uid}`);
      }

      if (pb) {
        if (!pb.referralCode) {
          const code = generateReferralCode();
          pb = { ...pb, referralCode: code };
          api.syncUser({ firebaseUid: fbUser.uid, email: fbUser.email ?? '', referralCode: code })
            .catch(() => {});
          await AsyncStorage.setItem(`shib_referral_${fbUser.uid}`, code);
        }
        setPbUser(pb);
        setUser(pbToProfile(pb, fbUser));
        await AsyncStorage.setItem(`shib_profile_${fbUser.uid}`, JSON.stringify(pbToProfile(pb, fbUser)));
        if (pb.is_verified) {
          setTimeout(() => {
            try { router.replace('/(tabs)' as any); } catch {}
          }, 100);
        }
      }
    } catch (e) {
      console.warn('[Auth] syncWithServer failed, checking cache', e);
      const cached = await AsyncStorage.getItem(`shib_profile_${fbUser.uid}`);
      if (cached) {
        try {
          const p = JSON.parse(cached);
          if (!p.referralCode) {
            const stored = await AsyncStorage.getItem(`shib_referral_${fbUser.uid}`);
            p.referralCode = stored || generateReferralCode();
          }
          setUser(p);
        } catch {}
      }
    }
  }

  async function signUp(
    email: string,
    password: string,
    displayName: string,
    referredBy?: string,
  ): Promise<void> {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const pending = {
      displayName,
      referralCode: generateReferralCode(),
      referredBy: referredBy?.toUpperCase() || '',
    };
    await AsyncStorage.setItem(`shib_pending_${cred.user.uid}`, JSON.stringify(pending));
    await api.sendOtp(email);
    setFirebaseUser(cred.user);
  }

  async function signIn(email: string, password: string): Promise<void> {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    setFirebaseUser(cred.user);

    let pb: PBUser | null = null;
    try {
      pb = await withTimeout(api.getUser(cred.user.uid), 8000, null);
    } catch {
      pb = null;
    }

    if (pb?.is_verified) {
      await syncWithServer(cred.user, pb);
    } else {
      setPbUser(pb);
      await api.sendOtp(email).catch(() => {});
    }
  }

  async function signOut() {
    await firebaseSignOut(auth);
    setUser(null);
    setPbUser(null);
    setFirebaseUser(null);
    router.replace('/auth' as any);
  }

  async function verifyOtp(email: string, code: string): Promise<{ success: boolean; error?: string }> {
    try {
      await api.verifyOtp(email, code);
      const fbUser = firebaseUser ?? auth.currentUser;
      if (fbUser) {
        await syncWithServer(fbUser, null);
      }
      return { success: true };
    } catch (e: any) {
      const msg = e?.message?.includes('400')
        ? 'Invalid or expired code. Please try again.'
        : e?.message || 'Verification failed.';
      return { success: false, error: msg };
    }
  }

  async function resendOtp(email: string) {
    await api.sendOtp(email);
  }

  async function forgotPassword(email: string) {
    await sendPasswordResetEmail(auth, email);
  }

  async function refreshUser() {
    const fbUser = auth.currentUser;
    if (fbUser) {
      try {
        await fbUser.reload();
        const refreshed = auth.currentUser;
        if (refreshed) {
          const pb = await api.getUser(refreshed.uid).catch(() => null);
          if (pb?.is_verified) {
            await syncWithServer(refreshed, pb);
          } else {
            setFirebaseUser(refreshed);
            setPbUser(pb);
          }
        }
      } catch (e) {
        console.warn('[Auth] refreshUser failed', e);
      }
    }
  }

  async function refreshBalance() {
    const fbUser = auth.currentUser;
    if (!fbUser) return;
    try {
      let pb = await api.getUser(fbUser.uid).catch(() => null);
      if (!pb) {
        pb = await api.syncUser({
          firebaseUid: fbUser.uid,
          email: fbUser.email ?? '',
          displayName: fbUser.displayName || fbUser.email?.split('@')[0] || '',
        });
      }
      if (pb) {
        if (!pb.referralCode) {
          const stored = await AsyncStorage.getItem(`shib_referral_${fbUser.uid}`);
          pb = { ...pb, referralCode: stored || generateReferralCode() };
        }
        setPbUser(pb);
        setUser(pbToProfile(pb, fbUser));
        await AsyncStorage.setItem(`shib_profile_${fbUser.uid}`, JSON.stringify(pbToProfile(pb, fbUser)));
      }
    } catch (e) {
      console.warn('[Auth] refreshBalance failed', e);
    }
  }

  const isAdmin = !!(firebaseUser?.email?.toLowerCase() === ADMIN_EMAIL);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    firebaseUser,
    isLoading,
    isAdmin,
    pbUser,
    signUp,
    signIn,
    signOut,
    refreshUser,
    refreshBalance,
    verifyOtp,
    resendOtp,
    forgotPassword,
  }), [user, firebaseUser, isLoading, isAdmin, pbUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
