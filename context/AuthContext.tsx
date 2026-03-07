import React, { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from 'react';
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
  is_verified: boolean;
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
    is_verified: u.is_verified,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [pbUser, setPbUser] = useState<PBUser | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Prevents onAuthStateChanged from interfering while signIn/signUp is in progress
  const isAuthActionRef = useRef(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      if (isAuthActionRef.current) return;
      handleAuthStateChange(fbUser);
    });
    return unsub;
  }, []);

  // Only called on app startup / session restore — not during signIn/signUp
  async function handleAuthStateChange(fbUser: FirebaseUser | null) {
    if (!fbUser) {
      setUser(null);
      setPbUser(null);
      setFirebaseUser(null);
      setIsLoading(false);
      return;
    }

    setFirebaseUser(fbUser);

    try {
      const pb = await Promise.race([
        api.getUser(fbUser.uid),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]).catch(() => null);

      if (pb?.is_verified) {
        setPbUser(pb);
        setUser(pbToProfile(pb, fbUser));
      } else {
        // Logged in Firebase but not verified — show OTP screen
        setPbUser(pb ?? null);
        setUser(null);
      }
    } catch {
      setPbUser(null);
      setUser(null);
    }

    setIsLoading(false);
  }

  async function signUp(
    email: string,
    password: string,
    displayName: string,
    referredBy?: string,
  ): Promise<void> {
    isAuthActionRef.current = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);

      // Store pending display name & referral for when OTP is verified
      await AsyncStorage.setItem(`shib_pending_${cred.user.uid}`, JSON.stringify({
        displayName,
        referralCode: generateReferralCode(),
        referredBy: referredBy?.toUpperCase() || '',
      }));

      setFirebaseUser(cred.user);
      setPbUser(null);
      setUser(null);
      setIsLoading(false);

      // Send OTP and navigate to verify screen immediately
      api.sendOtp(email).catch(() => {});
      router.replace('/verify-email' as any);
    } finally {
      isAuthActionRef.current = false;
    }
  }

  async function signIn(email: string, password: string): Promise<void> {
    isAuthActionRef.current = true;
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      setFirebaseUser(cred.user);

      // Fetch PB user to check verification status
      const pb = await Promise.race([
        api.getUser(cred.user.uid),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]).catch(() => null);

      if (pb?.is_verified) {
        // Verified — load profile and go to tabs
        setPbUser(pb);
        setUser(pbToProfile(pb, cred.user));
        setIsLoading(false);
        router.replace('/(tabs)' as any);
      } else {
        // Not verified — go to OTP screen
        setPbUser(pb ?? null);
        setUser(null);
        setIsLoading(false);
        api.sendOtp(email).catch(() => {});
        router.replace('/verify-email' as any);
      }
    } finally {
      isAuthActionRef.current = false;
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
      const fbUser = auth.currentUser ?? firebaseUser;
      if (!fbUser) return { success: false, error: 'Session expired. Please sign in again.' };

      // Sync user to PocketBase now that OTP is verified
      const cached = await AsyncStorage.getItem(`shib_pending_${fbUser.uid}`);
      const pending = cached ? JSON.parse(cached) : {};
      const pb = await api.syncUser({
        firebaseUid: fbUser.uid,
        email: fbUser.email ?? email,
        displayName: pending.displayName || fbUser.email?.split('@')[0] || '',
        referralCode: pending.referralCode || generateReferralCode(),
        referredBy: pending.referredBy || '',
      });
      if (cached) await AsyncStorage.removeItem(`shib_pending_${fbUser.uid}`);

      if (pb?.is_verified) {
        setPbUser(pb);
        setUser(pbToProfile(pb, fbUser));
        router.replace('/(tabs)' as any);
      }

      return { success: true };
    } catch (e: any) {
      const msg = e?.message?.includes('400') || e?.message?.includes('Invalid')
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
    if (!fbUser) return;
    try {
      const pb = await api.getUser(fbUser.uid).catch(() => null);
      if (pb?.is_verified) {
        setPbUser(pb);
        setUser(pbToProfile(pb, fbUser));
      }
    } catch {}
  }

  async function refreshBalance() {
    const fbUser = auth.currentUser;
    if (!fbUser) return;
    try {
      const pb = await api.getUser(fbUser.uid).catch(() => null);
      if (pb) {
        setPbUser(pb);
        if (pb.is_verified) setUser(pbToProfile(pb, fbUser));
      }
    } catch {}
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
