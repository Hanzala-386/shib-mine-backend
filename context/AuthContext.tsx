import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  signUp: (email: string, password: string, displayName: string, referredBy?: string) => Promise<{ needsVerification: boolean; pendingEmail: string }>;
  signIn: (email: string, password: string) => Promise<{ needsVerification: boolean; pendingEmail?: string }>;
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
    emailVerified: fbUser.emailVerified || u.is_verified,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [pbUser, setPbUser] = useState<PBUser | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser) {
        try {
          const pb = await api.getUser(fbUser.uid);
          if (pb?.is_verified) {
            await syncWithServer(fbUser);
          } else {
            setUser(null);
            setPbUser(pb || null);
          }
        } catch (e) {
          setUser(null);
          setPbUser(null);
        }
      } else {
        setUser(null);
        setPbUser(null);
      }
      setIsLoading(false);
    });
    return unsubscribe;
  }, []);

  async function syncWithServer(fbUser: FirebaseUser): Promise<void> {
    try {
      // First try to fetch existing user
      let pb = await api.getUser(fbUser.uid).catch(() => null);

      if (!pb) {
        // Check for pending signup data
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
        // If server returned empty referral code, assign one now and save it
        if (!pb.referralCode) {
          const code = generateReferralCode();
          pb = { ...pb, referralCode: code };
          // Save to server in background (don't await)
          api.syncUser({
            firebaseUid: fbUser.uid,
            email: fbUser.email ?? '',
            referralCode: code,
          }).then((updated) => {
            if (updated.referralCode) pb = updated;
          }).catch(() => {});
          // Persist locally
          await AsyncStorage.setItem(`shib_referral_${fbUser.uid}`, code);
        }
        setPbUser(pb);
        setUser(pbToProfile(pb, fbUser));
        await AsyncStorage.setItem(`shib_profile_${fbUser.uid}`, JSON.stringify(pbToProfile(pb, fbUser)));
        console.log('[Auth] user set, referralCode=', pb.referralCode);
      }
    } catch (e) {
      console.warn('[Auth] Server sync failed, using cache', e);
      const cached = await AsyncStorage.getItem(`shib_profile_${fbUser.uid}`);
      if (cached) {
        const cachedProfile = JSON.parse(cached);
        // If cached profile has no referral code, generate one
        if (!cachedProfile.referralCode) {
          const storedCode = await AsyncStorage.getItem(`shib_referral_${fbUser.uid}`);
          cachedProfile.referralCode = storedCode || generateReferralCode();
          if (!storedCode) {
            await AsyncStorage.setItem(`shib_referral_${fbUser.uid}`, cachedProfile.referralCode);
          }
        }
        setUser(cachedProfile);
      }
    }
  }

  async function signUp(
    email: string,
    password: string,
    displayName: string,
    referredBy?: string,
  ): Promise<{ needsVerification: boolean; pendingEmail: string }> {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const pending = {
      displayName,
      referralCode: generateReferralCode(),
      referredBy: referredBy?.toUpperCase() || '',
    };
    await AsyncStorage.setItem(`shib_pending_${cred.user.uid}`, JSON.stringify(pending));
    await api.sendOtp(email);
    setFirebaseUser(cred.user);
    return { needsVerification: true, pendingEmail: email };
  }

  async function signIn(email: string, password: string): Promise<{ needsVerification: boolean; pendingEmail?: string }> {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    setFirebaseUser(cred.user);
    try {
      const pb = await api.getUser(cred.user.uid);
      if (!pb.is_verified) {
        await api.sendOtp(email);
        return { needsVerification: true, pendingEmail: email };
      }
    } catch (e) {
      // If user not in PB yet, it needs verification
      await api.sendOtp(email);
      return { needsVerification: true, pendingEmail: email };
    }
    
    await syncWithServer(cred.user);
    return { needsVerification: false };
  }

  async function signOut() {
    await firebaseSignOut(auth);
    setUser(null);
    setPbUser(null);
    setFirebaseUser(null);
  }

  async function verifyOtp(email: string, code: string): Promise<{ success: boolean; error?: string }> {
    try {
      await api.verifyOtp(email, code);
      if (firebaseUser) {
        await syncWithServer(firebaseUser);
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || 'Invalid code' };
    }
  }

  async function resendOtp(email: string) {
    await api.sendOtp(email);
  }

  async function forgotPassword(email: string) {
    await sendPasswordResetEmail(auth, email);
  }

  async function refreshUser() {
    if (firebaseUser) {
      await firebaseUser.reload();
      const refreshed = auth.currentUser;
      if (refreshed?.emailVerified) {
        setFirebaseUser(refreshed);
        await syncWithServer(refreshed);
      }
    }
  }

  async function refreshBalance() {
    if (firebaseUser) {
      try {
        let pb = await api.getUser(firebaseUser.uid).catch(() => null);
        if (!pb) {
          pb = await api.syncUser({
            firebaseUid: firebaseUser.uid,
            email: firebaseUser.email ?? '',
            displayName: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || '',
          });
        }
        if (pb) {
          // Client-side fallback: ensure referral code is always set
          if (!pb.referralCode) {
            const storedCode = await AsyncStorage.getItem(`shib_referral_${firebaseUser.uid}`);
            pb = { ...pb, referralCode: storedCode || generateReferralCode() };
            if (!storedCode) {
              await AsyncStorage.setItem(`shib_referral_${firebaseUser.uid}`, pb.referralCode);
            }
          }
          setPbUser(pb);
          setUser(pbToProfile(pb, firebaseUser));
          await AsyncStorage.setItem(`shib_profile_${firebaseUser.uid}`, JSON.stringify(pbToProfile(pb, firebaseUser)));
        }
      } catch (e) {
        console.warn('[Auth] refreshBalance failed', e);
      }
    }
  }

  const isAdmin = firebaseUser?.email?.toLowerCase() === ADMIN_EMAIL;

  const value = useMemo(() => ({
    user, firebaseUser, isLoading, isAdmin, pbUser,
    signUp, signIn, signOut,
    refreshUser, refreshBalance, verifyOtp, resendOtp, forgotPassword,
  }), [user, firebaseUser, isLoading, isAdmin, pbUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
