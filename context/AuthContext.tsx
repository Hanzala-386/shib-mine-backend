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
import { pb, POCKETBASE_URL } from '@/lib/pocketbase';

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

// ── Direct PocketBase fallback (when Express backend unreachable from device) ──
// Password pattern is the same one the Express `confirm-verified` route uses.
function pbPassword(firebaseUid: string) { return `SHIB_${firebaseUid}_SECURE`; }

// Convert raw PocketBase record (snake_case) → PBUser (camelCase) — mirrors
// the `formatUser()` function in server/routes.ts so both paths produce identical shape.
function formatRawPbUser(u: any): PBUser {
  return {
    pbId: u.id,
    firebaseUid: u.firebase_uid,
    email: u.email,
    displayName: u.display_name || u.name || '',
    referralCode: u.referral_code || '',
    referredBy: u.referred_by || '',
    referralEarnings: u.referral_earnings || 0,
    referralBalance: u.referral_balance || 0,
    shibBalance: u.shib_balance || 0,
    powerTokens: u.power_tokens ?? 10,
    totalClaims: u.total_claims || 0,
    totalWins: u.total_wins || 0,
    is_verified: !!u.is_verified,
    isVerified: !!u.is_verified,
    activeBoosterMultiplier: u.active_booster_multiplier || 1,
    boosterExpires: u.booster_expires || u.booster_expiry || '',
    fraudAttempts: u.fraud_attempts || 0,
    status: u.status || 'active',
    created: u.created,
  } as PBUser;
}

const PB_SESSION_KEY = 'pb_auth_session_v1';

// Saves the PocketBase auth token+model to storage so we don't need to
// re-authenticate on every app launch.
async function savePbSession(): Promise<void> {
  try {
    if (!pb.authStore.isValid) return;
    const payload = JSON.stringify({ token: pb.authStore.token, model: pb.authStore.model });
    await storage.setItem(PB_SESSION_KEY, payload);
  } catch { /* non-critical */ }
}

// Restores a previously saved PocketBase session. Called on app startup
// before Firebase auth resolves, so mining/balance calls succeed immediately.
export async function restorePbSession(): Promise<void> {
  try {
    const raw = await storage.getItem(PB_SESSION_KEY);
    if (!raw) return;
    const { token, model } = JSON.parse(raw);
    if (token && model) {
      pb.authStore.save(token, model);
    }
  } catch { /* non-critical */ }
}

// Authenticates the PocketBase SDK client as the user, then returns their record.
// This bypasses the Express backend entirely — works as long as PocketBase is reachable.
async function pbDirectLogin(email: string, firebaseUid: string): Promise<PBUser | null> {
  try {
    const authData = await pb.collection('users').authWithPassword(email, pbPassword(firebaseUid));
    if (authData?.record) {
      await savePbSession(); // persist auth so app restarts don't re-login
      return formatRawPbUser(authData.record);
    }
  } catch { /* login failed — user may not exist in PB yet */ }
  return null;
}

// Reads the authenticated user's own record from PocketBase (requires pbDirectLogin first).
async function pbGetSelf(): Promise<PBUser | null> {
  try {
    if (!pb.authStore.isValid) return null;
    const model = pb.authStore.model as any;
    if (!model?.id) return null;
    const fresh = await pb.collection('users').getOne(model.id);
    return formatRawPbUser(fresh);
  } catch {
    return null;
  }
}

// Module-level flag to block onAuthStateChanged during active sign-in/sign-up
let isAuthAction = false;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [pbUser, setPbUser] = useState<PBUser | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Restore PB session first so SDK is authenticated before auth state fires
    restorePbSession().catch(() => {});

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

  // Confirms verification in PB and loads user profile.
  // PRIMARY path: PocketBase SDK direct auth — works for ALL clients (APK + web preview).
  // The PB SDK is ALWAYS authenticated before this function returns, eliminating the
  // race condition where mining ops fired before the SDK had a valid auth token.
  async function confirmAndLoadUser(fbUser: FirebaseUser): Promise<void> {
    try {
      const cached = await storage.getItem(`shib_pending_${fbUser.uid}`);
      const pending = cached ? JSON.parse(cached) : {};

      let pbRecord: PBUser | null = null;

      // ── Step 1: PocketBase direct auth (primary — both APK and web preview) ─
      // This authenticates the SDK immediately. All subsequent PB SDK calls
      // (pbStartMining, pbClaimMining, pbActivateAndMine) are guaranteed to have
      // a valid auth token — no race condition, no 403 from unauthenticated SDK.
      pbRecord = await pbDirectLogin(fbUser.email ?? '', fbUser.uid);

      if (!pbRecord) {
        // ── Step 2: User not in PB yet (first login after sign-up) ──────────
        // Try Express first — it has admin creds and handles referral processing.
        try {
          await api.confirmVerified({
            firebaseUid: fbUser.uid,
            email: fbUser.email ?? '',
            displayName: pending.displayName || fbUser.email?.split('@')[0] || '',
            referralCode: pending.referralCode || generateReferralCode(),
            referredBy: pending.referredBy || '',
          });
          // Express created the PB record — now authenticate as that user
          pbRecord = await pbDirectLogin(fbUser.email ?? '', fbUser.uid);
        } catch (expressErr: any) {
          const errCode = expressErr?.data?.error || expressErr?.code || '';
          const isHardBlock = expressErr?.status === 403 || errCode === 'ACCOUNT_BLOCKED' || errCode === 'EMAIL_PERMANENTLY_BANNED';
          if (isHardBlock) throw expressErr;

          // ── Step 3: Express unreachable — create PB record directly ────────
          console.warn('[Auth] Express unreachable for new user, creating directly in PB');
          try {
            const pass = pbPassword(fbUser.uid);
            const code = pending.referralCode || generateReferralCode();
            const createdRecord = await pb.collection('users').create({
              email:            fbUser.email ?? '',
              password:         pass,
              passwordConfirm:  pass,
              emailVisibility:  false,
              firebase_uid:     fbUser.uid,
              display_name:     pending.displayName || (fbUser.email ?? '').split('@')[0],
              referral_code:    code,
              referred_by:      pending.referredBy || '',
              shib_balance:     100,
              power_tokens:     500,
              referral_balance: 0,
              referral_earnings: 0,
              total_claims:     0,
              total_wins:       0,
              fraud_attempts:   0,
              status:           'active',
              is_verified:      true,
            });
            pb.collection('public_referrals').create({
              code: code,
              user_id: createdRecord.id,
            }).catch(() => {});
            pbRecord = await pbDirectLogin(fbUser.email ?? '', fbUser.uid);
            console.warn('[Auth] PB user created and logged in directly ✓');
          } catch (createErr: any) {
            console.warn('[Auth] PB direct creation failed:', createErr?.message);
          }
        }
      }

      if (cached) await storage.removeItem(`shib_pending_${fbUser.uid}`);

      if (!pbRecord) {
        setPbUser(null);
        setUser(null);
        setIsLoading(false);
        return;
      }

      if (pbRecord.status === 'blocked') {
        setPbUser(null);
        setUser(null);
        setIsLoading(false);
        try { await firebaseSignOut(auth); } catch {}
        return;
      }

      setPbUser(pbRecord);
      setUser(pbToProfile(pbRecord, fbUser));
      await storage.setItem(`shib_profile_${fbUser.uid}`, JSON.stringify(pbToProfile(pbRecord, fbUser)));
    } catch (e: any) {
      console.warn('[Auth] confirmAndLoadUser failed:', e);
      const errCode = e?.data?.error || e?.code || '';
      const isHardBlock = e?.status === 403 || errCode === 'ACCOUNT_BLOCKED' || errCode === 'EMAIL_PERMANENTLY_BANNED';
      if (isHardBlock) {
        setPbUser(null);
        setUser(null);
        setIsLoading(false);
        try { await firebaseSignOut(auth); } catch {}
        const msg = e?.data?.message || e?.message || 'Your account has been permanently disabled.';
        const cleanErr = Object.assign(new Error(msg), { status: 403, data: e?.data ?? {}, code: errCode });
        throw cleanErr;
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
      const errCode = e?.data?.error || e?.code || '';
      if (e?.status === 403 || errCode === 'ACCOUNT_BLOCKED' || errCode === 'EMAIL_PERMANENTLY_BANNED') {
        const title = errCode === 'ACCOUNT_BLOCKED' ? 'ACCOUNT BANNED!' : 'Account Permanently Banned';
        Alert.alert(title, e.message || 'Your account has been permanently disabled.', [{ text: 'OK' }]);
        throw e;
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
      let pbRecord = await api.getUser(fbUser.uid).catch(async (e: any) => {
        if (e?.data?.error === 'ACCOUNT_BLOCKED' || e?.status === 403) throw e;
        // Express unreachable → try PocketBase directly
        return pbGetSelf();
      });
      if (!pbRecord) return;
      if (pbRecord.status === 'blocked') {
        Alert.alert('ACCOUNT BANNED!', 'Your account has been permanently disabled due to multiple fraud attempts.');
        await signOut(); return;
      }
      if (pbRecord.is_verified) {
        setPbUser(pbRecord);
        setUser(pbToProfile(pbRecord, fbUser));
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
      let pbRecord = await api.getUser(fbUser.uid).catch(async (e: any) => {
        if (e?.data?.error === 'ACCOUNT_BLOCKED' || e?.status === 403) throw e;
        // Express unreachable → try PocketBase directly
        return pbGetSelf();
      });
      if (!pbRecord) return;
      if (pbRecord.status === 'blocked') {
        Alert.alert('ACCOUNT BANNED!', 'Your account has been permanently disabled due to multiple fraud attempts.');
        await signOut();
        return;
      }
      setPbUser(pbRecord);
      if (pbRecord.is_verified) setUser(pbToProfile(pbRecord, fbUser));
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
