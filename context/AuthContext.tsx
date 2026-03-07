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

// Prevents onAuthStateChanged from interfering while signIn/signUp is in progress
let isAuthAction = false;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [pbUser, setPbUser] = useState<PBUser | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      if (isAuthAction) return;
      handleAuthStateChange(fbUser);
    });
    return unsub;
  }, []);

  // App startup session restore — not called during active signIn/signUp
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
      const pb = await api.getUser(fbUser.uid).catch(() => null);
      if (pb?.is_verified) {
        setPbUser(pb);
        setUser(pbToProfile(pb, fbUser));
        await AsyncStorage.setItem(`shib_profile_${fbUser.uid}`, JSON.stringify(pbToProfile(pb, fbUser)));
      } else {
        setPbUser(pb ?? null);
        setUser(null);
      }
    } catch {
      setPbUser(null);
      setUser(null);
    }

    setIsLoading(false);
  }

  // ── Sign Up ────────────────────────────────────────────────────────────────
  // FLOW: Firebase create → navigate to OTP screen immediately → OTP sent in background
  async function signUp(
    email: string,
    password: string,
    displayName: string,
    referredBy?: string,
  ): Promise<void> {
    isAuthAction = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);

      await AsyncStorage.setItem(`shib_pending_${cred.user.uid}`, JSON.stringify({
        displayName,
        referralCode: generateReferralCode(),
        referredBy: referredBy?.toUpperCase() || '',
      }));

      setFirebaseUser(cred.user);
      setPbUser(null);
      setUser(null);
      setIsLoading(false);

      // Navigate to OTP screen FIRST — then send OTP in background
      router.replace('/verify-email' as any);
      api.sendOtp(email).catch((e) => console.warn('[Auth] OTP send failed:', e?.message));
    } finally {
      isAuthAction = false;
    }
  }

  // ── Sign In ────────────────────────────────────────────────────────────────
  // FLOW:
  //   verified (is_verified=true)  → go directly to /(tabs)
  //   unverified (is_verified=false or no PB record) → OTP screen + send OTP
  //   server error/timeout → throw so auth.tsx shows inline error
  async function signIn(email: string, password: string): Promise<void> {
    isAuthAction = true;
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      setFirebaseUser(cred.user);
      setIsLoading(false);

      // Fetch PB record with 6s timeout
      let pb: PBUser | null = null;
      let isServerError = false;

      try {
        pb = await Promise.race<PBUser | null>([
          api.getUser(cred.user.uid),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Server timeout')), 6000)
          ),
        ]);
      } catch (e: any) {
        const msg = (e?.message || '').toLowerCase();
        // "user not found" / "404" means no PB record — treat like unverified
        if (msg.includes('not found') || msg.includes('404')) {
          pb = null;
          isServerError = false;
        } else {
          // Network / timeout / 5xx — undo Firebase login and surface error to UI
          isServerError = true;
        }
      }

      if (isServerError) {
        await firebaseSignOut(auth);
        setFirebaseUser(null);
        throw new Error('Server unavailable. Please check your connection and try again.');
      }

      if (pb?.is_verified) {
        // ✅ Verified user — go straight to the app
        setPbUser(pb);
        setUser(pbToProfile(pb, cred.user));
        await AsyncStorage.setItem(`shib_profile_${cred.user.uid}`, JSON.stringify(pbToProfile(pb, cred.user)));
        router.replace('/(tabs)' as any);
      } else {
        // 🔒 Not verified — send OTP and go to verify screen
        setPbUser(pb ?? null);
        setUser(null);
        router.replace('/verify-email' as any);
        api.sendOtp(email).catch((e) => console.warn('[Auth] OTP send failed:', e?.message));
      }
    } finally {
      isAuthAction = false;
      setIsLoading(false);
    }
  }

  // ── Sign Out ────────────────────────────────────────────────────────────────
  async function signOut() {
    await firebaseSignOut(auth);
    setUser(null);
    setPbUser(null);
    setFirebaseUser(null);
    router.replace('/auth' as any);
  }

  // ── Verify OTP ─────────────────────────────────────────────────────────────
  // Called from verify-email.tsx after user enters code
  // On success: creates/syncs PB user with is_verified=true → navigates to tabs
  async function verifyOtp(email: string, code: string): Promise<{ success: boolean; error?: string }> {
    try {
      await api.verifyOtp(email, code);

      const fbUser = auth.currentUser ?? firebaseUser;
      if (!fbUser) return { success: false, error: 'Session expired. Please sign in again.' };

      // Sync / create PB user (server will set is_verified=true from the verifiedEmails set)
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
        await AsyncStorage.setItem(`shib_profile_${fbUser.uid}`, JSON.stringify(pbToProfile(pb, fbUser)));
        router.replace('/(tabs)' as any);
      } else {
        // Edge case: PB sync returned is_verified=false (shouldn't happen normally)
        return { success: false, error: 'Verification failed on server. Please try again.' };
      }

      return { success: true };
    } catch (e: any) {
      const msg =
        e?.message?.includes('400') || e?.message?.toLowerCase().includes('invalid')
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
