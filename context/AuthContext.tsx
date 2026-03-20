import React, { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from 'react';
import { Alert } from 'react-native';
import storage from '@/lib/storage';
import { router } from 'expo-router';
import {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  firebaseSignOut,
  sendEmailVerification,
  sendPasswordResetEmail,
  onAuthStateChanged,
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
  referralEarnings: number;
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
  resendVerificationEmail: () => Promise<void>;
  checkVerificationStatus: () => Promise<{ verified: boolean }>;
  forgotPassword: (email: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  optimisticUpdatePt: (newPt: number) => void;
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
    referralEarnings: u.referralEarnings || 0,
    createdAt: new Date(u.created).getTime(),
    is_verified: u.is_verified,
  };
}

// Module-level flag to block onAuthStateChanged during active sign-in/sign-up
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

  // ── App startup session restore ──────────────────────────────────────────
  async function handleAuthStateChange(fbUser: FirebaseUser | null) {
    if (!fbUser) {
      setUser(null);
      setPbUser(null);
      setFirebaseUser(null);
      setIsLoading(false);
      return;
    }

    // Reload to get the freshest emailVerified status from Firebase
    try { await fbUser.reload(); } catch {}
    const freshUser = auth.currentUser ?? fbUser;
    setFirebaseUser(freshUser);

    if (freshUser.emailVerified) {
      // Firebase says verified → make sure PB is synced
      try {
        await confirmAndLoadUser(freshUser);
      } catch (e: any) {
        // confirmAndLoadUser already signed out and cleared state for banned emails
        console.warn('[Auth] handleAuthStateChange: confirmAndLoadUser threw:', e?.message);
        if (e?.code === 'EMAIL_PERMANENTLY_BANNED' || e?.status === 403) {
          Alert.alert(
            'Account Permanently Banned',
            e.message || 'This email address is permanently banned and cannot be used to create a new account.',
            [{ text: 'OK' }]
          );
        }
        setIsLoading(false);
      }
    } else {
      // Not verified yet → show the check-email screen
      setPbUser(null);
      setUser(null);
      setIsLoading(false);
    }
  }

  // Confirms verification in PB and loads user profile
  async function confirmAndLoadUser(fbUser: FirebaseUser): Promise<void> {
    try {
      const cached = await storage.getItem(`shib_pending_${fbUser.uid}`);
      const pending = cached ? JSON.parse(cached) : {};

      const pb = await api.confirmVerified({
        firebaseUid: fbUser.uid,
        email: fbUser.email ?? '',
        displayName: pending.displayName || fbUser.email?.split('@')[0] || '',
        referralCode: pending.referralCode || generateReferralCode(),
        referredBy: pending.referredBy || '',
      });

      if (cached) await storage.removeItem(`shib_pending_${fbUser.uid}`);

      if (pb.status === 'blocked') {
        setPbUser(null);
        setUser(null);
        setIsLoading(false);
        try { await firebaseSignOut(auth); } catch {}
        return;
      }
      setPbUser(pb);
      setUser(pbToProfile(pb, fbUser));
      await storage.setItem(`shib_profile_${fbUser.uid}`, JSON.stringify(pbToProfile(pb, fbUser)));
    } catch (e: any) {
      console.warn('[Auth] confirmAndLoadUser failed:', e);
      if (e?.code === 'EMAIL_PERMANENTLY_BANNED' || e?.status === 403) {
        // This email was permanently blacklisted — sign out and surface the error
        setPbUser(null);
        setUser(null);
        setIsLoading(false);
        try { await firebaseSignOut(auth); } catch {}
        // Surface the error to auth screen via re-throw so auth.tsx shows it
        throw e;
      }
      setPbUser(null);
      setUser(null);
    }
    setIsLoading(false);
  }

  // ── Sign Up ───────────────────────────────────────────────────────────────
  // Creates Firebase account, sends verification email, navigates to check-email screen.
  async function signUp(
    email: string,
    password: string,
    displayName: string,
    referredBy?: string,
  ): Promise<void> {
    isAuthAction = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);

      // Store pending profile data for when they verify
      await storage.setItem(`shib_pending_${cred.user.uid}`, JSON.stringify({
        displayName,
        referralCode: generateReferralCode(),
        referredBy: referredBy?.toUpperCase() || '',
      }));

      setFirebaseUser(cred.user);
      setPbUser(null);
      setUser(null);
      setIsLoading(false);

      // Send Firebase verification email — free, no external service needed
      await sendEmailVerification(cred.user);

      // Navigate to check-email screen immediately
      router.replace('/verify-email' as any);
    } finally {
      isAuthAction = false;
    }
  }

  // ── Sign In ───────────────────────────────────────────────────────────────
  // Checks Firebase emailVerified:
  //   true  → confirm in PB + navigate to tabs
  //   false → throw EMAIL_NOT_VERIFIED so auth.tsx shows resend button
  async function signIn(email: string, password: string): Promise<void> {
    isAuthAction = true;
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);

      // Always reload to get the freshest emailVerified status
      await cred.user.reload();
      const freshUser = auth.currentUser ?? cred.user;
      setFirebaseUser(freshUser);
      setIsLoading(false);

      if (freshUser.emailVerified) {
        // ✅ Verified — sync with PB and open the app
        await confirmAndLoadUser(freshUser);
        router.replace('/(tabs)' as any);
      } else {
        // 🔒 Not verified — stay on auth with error; user can resend
        throw Object.assign(new Error('Email not verified. Please check your inbox and click the verification link.'), {
          code: 'EMAIL_NOT_VERIFIED',
        });
      }
    } finally {
      isAuthAction = false;
      setIsLoading(false);
    }
  }

  // ── Sign Out ──────────────────────────────────────────────────────────────
  async function signOut() {
    await firebaseSignOut(auth);
    setUser(null);
    setPbUser(null);
    setFirebaseUser(null);
    router.replace('/auth' as any);
  }

  // ── Resend Firebase verification email ───────────────────────────────────
  async function resendVerificationEmail(): Promise<void> {
    const fbUser = auth.currentUser ?? firebaseUser;
    if (!fbUser) throw new Error('No user session. Please sign in again.');
    await sendEmailVerification(fbUser);
  }

  // ── Check if Firebase has verified the email (poll on button tap) ─────────
  async function checkVerificationStatus(): Promise<{ verified: boolean }> {
    const fbUser = auth.currentUser ?? firebaseUser;
    if (!fbUser) return { verified: false };

    try {
      await fbUser.reload();
      const fresh = auth.currentUser ?? fbUser;
      setFirebaseUser(fresh);

      if (fresh.emailVerified) {
        await confirmAndLoadUser(fresh);
        router.replace('/(tabs)' as any);
        return { verified: true };
      }
    } catch (e: any) {
      if (e?.code === 'EMAIL_PERMANENTLY_BANNED' || e?.status === 403) {
        Alert.alert(
          'Account Permanently Banned',
          e.message || 'This email address is permanently banned and cannot be used to register a new account.',
          [{ text: 'OK' }]
        );
        throw e; // Re-throw so verify-email.tsx can react
      }
    }
    return { verified: false };
  }

  async function forgotPassword(email: string) {
    await sendPasswordResetEmail(auth, email);
  }

  async function refreshUser() {
    const fbUser = auth.currentUser;
    if (!fbUser) return;
    try {
      // Don't swallow ACCOUNT_BLOCKED — re-throw it so the catch block can sign out
      const pb = await api.getUser(fbUser.uid).catch((e: any) => {
        if (e?.data?.error === 'ACCOUNT_BLOCKED' || e?.status === 403) throw e;
        return null;
      });
      if (!pb) return;
      if (pb.status === 'blocked') {
        Alert.alert('ACCOUNT BANNED!', 'Your account has been permanently disabled due to multiple fraud attempts.');
        await signOut(); return;
      }
      if (pb.is_verified) {
        setPbUser(pb);
        setUser(pbToProfile(pb, fbUser));
      }
    } catch (e: any) {
      if (e?.data?.error === 'ACCOUNT_BLOCKED' || e?.status === 403) {
        Alert.alert('ACCOUNT BANNED!', 'Your account has been permanently disabled due to multiple fraud attempts.');
        await signOut();
      }
    }
  }

  async function refreshBalance() {
    const fbUser = auth.currentUser;
    if (!fbUser) return;
    try {
      // Don't swallow ACCOUNT_BLOCKED — re-throw it so the catch block can sign out
      const pb = await api.getUser(fbUser.uid).catch((e: any) => {
        if (e?.data?.error === 'ACCOUNT_BLOCKED' || e?.status === 403) throw e;
        return null;
      });
      if (!pb) return;
      if (pb.status === 'blocked') {
        Alert.alert('ACCOUNT BANNED!', 'Your account has been permanently disabled due to multiple fraud attempts.');
        await signOut();
        return;
      }
      setPbUser(pb);
      if (pb.is_verified) setUser(pbToProfile(pb, fbUser));
    } catch (e: any) {
      if (e?.data?.error === 'ACCOUNT_BLOCKED' || e?.status === 403) {
        Alert.alert('ACCOUNT BANNED!', 'Your account has been permanently disabled due to multiple fraud attempts.');
        await signOut();
      }
    }
  }

  // Immediately updates the PT balance in state without a network round-trip.
  // Used by MiningContext after a successful startMiningWithBooster call so the
  // UI reflects the deducted cost in 0 ms — refreshBalance() reconciles later.
  function optimisticUpdatePt(newPt: number) {
    setPbUser((prev) => {
      if (!prev) return prev;
      return { ...prev, powerTokens: typeof newPt === 'number' && isFinite(newPt) ? newPt : prev.powerTokens };
    });
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
    resendVerificationEmail,
    checkVerificationStatus,
    forgotPassword,
    refreshUser,
    refreshBalance,
    optimisticUpdatePt,
  }), [user, firebaseUser, isLoading, isAdmin, pbUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
