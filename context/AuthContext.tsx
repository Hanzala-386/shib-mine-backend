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
import { pbAPI, type PBUser } from '@/lib/pocketbase';

export interface UserProfile {
  uid: string;
  pbId: string;
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

function pbUserToProfile(pbUser: PBUser): UserProfile {
  return {
    uid: pbUser.uid,
    pbId: pbUser.id,
    email: pbUser.email,
    displayName: pbUser.displayName,
    username: pbUser.username,
    referralCode: pbUser.referralCode,
    referredBy: pbUser.referredBy,
    createdAt: new Date(pbUser.created).getTime(),
    emailVerified: true,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser && fbUser.emailVerified) {
        await loadOrCreatePbUser(fbUser);
      } else {
        setUser(null);
      }
      setIsLoading(false);
    });
    return unsubscribe;
  }, []);

  async function loadOrCreatePbUser(fbUser: FirebaseUser): Promise<void> {
    try {
      const pbUser = await pbAPI.getUserByUid(fbUser.uid);
      if (pbUser) {
        setUser(pbUserToProfile(pbUser));
      } else {
        const cached = await AsyncStorage.getItem(`shib_pending_${fbUser.uid}`);
        if (cached) {
          const pending = JSON.parse(cached);
          const created = await pbAPI.createUser({
            uid: fbUser.uid,
            email: fbUser.email ?? '',
            username: pending.username,
            displayName: pending.displayName,
            referralCode: pending.referralCode,
            referredBy: pending.referredBy,
          });
          await AsyncStorage.removeItem(`shib_pending_${fbUser.uid}`);
          setUser(pbUserToProfile(created));
        }
      }
    } catch (e) {
      console.warn('[Auth] PocketBase unavailable, using local cache', e);
      const cached = await AsyncStorage.getItem(`shib_profile_${fbUser.uid}`);
      if (cached) setUser(JSON.parse(cached));
    }
  }

  async function signUp(email: string, password: string, username: string, displayName: string, referralCode?: string): Promise<{ needsVerification: boolean }> {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const pending = {
      uid: cred.user.uid,
      username,
      displayName,
      referralCode: generateReferralCode(),
      referredBy: referralCode?.toUpperCase(),
    };
    await AsyncStorage.setItem(`shib_pending_${cred.user.uid}`, JSON.stringify(pending));
    await sendEmailVerification(cred.user);
    setFirebaseUser(cred.user);
    return { needsVerification: true };
  }

  async function signIn(email: string, password: string): Promise<{ needsVerification: boolean }> {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    if (!cred.user.emailVerified) {
      setFirebaseUser(cred.user);
      return { needsVerification: true };
    }
    await loadOrCreatePbUser(cred.user);
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
      const refreshed = auth.currentUser;
      if (refreshed?.emailVerified) {
        setFirebaseUser(refreshed);
        await loadOrCreatePbUser(refreshed);
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
