import React, { createContext, useContext, useState, useEffect, useRef, useMemo, ReactNode } from 'react';
import { Alert, AppState } from 'react-native';
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
import { pb, POCKETBASE_URL, processPendingReferralEarnings } from '@/lib/pocketbase';
import { normalizeVipLevel } from '@shared/vip';
import { normalizeKycStatus } from '@shared/kyc';

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
  vipLevel: number;
  isAdminPromoted: boolean;
  adminPromotedLevel: number;
  kycStatus: 'none' | 'under_review' | 'verified' | 'rejected';
  kycRejectReason: string;
  kycCountry: string;
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
  refreshKycStatus: () => Promise<void>;
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
    vipLevel: normalizeVipLevel(u.vipLevel),
    isAdminPromoted: !!u.isAdminPromoted,
    adminPromotedLevel: normalizeVipLevel(u.adminPromotedLevel),
    kycStatus: (u.kycStatus as UserProfile['kycStatus']) || 'none',
    kycRejectReason: u.kycRejectReason || '',
    kycCountry: u.kycCountry || '',
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
    hitTickets: u.hit_tickets ?? 0,
    totalClaims: u.total_claims || 0,
    totalWins: u.total_wins || 0,
    is_verified: !!u.is_verified,
    isVerified: !!u.is_verified,
    activeBoosterMultiplier: u.active_booster_multiplier || 1,
    boosterExpires: u.booster_expires || u.booster_expiry || '',
    fraudAttempts: u.fraud_attempts || 0,
    status: u.status || 'active',
    created: u.created,
    vipLevel: normalizeVipLevel(u.vip_level),
    isAdminPromoted: !!u.is_admin_promoted,
    adminPromotedLevel: normalizeVipLevel(u.admin_promoted_level),
    // KYC verification (server-managed; snake_case → camelCase like formatUser())
    kycStatus: (['none', 'under_review', 'verified', 'rejected'].includes(u.kyc_status)
      ? u.kyc_status
      : 'none') as PBUser['kycStatus'],
    kycRejectReason: u.kyc_reject_reason || '',
    kycFullName: u.kyc_full_name || '',
    kycCountry: u.kyc_country || '',
    kycCountryCode: u.kyc_country_code || '',
    kycPhone: u.kyc_phone || '',
    kycBinanceEmail: u.kyc_binance_email || '',
    kycBep20Address: u.kyc_bep20_address || '',
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

// ─── Single-session enforcement ─────────────────────────────────────────────
// A device that logs in claims the session by writing a fresh random token to
// users.session_token (self-update — allowed by PB rules). Devices that later
// see a DIFFERENT non-empty token in PB know they were superseded → forced
// logout. Safety rules:
//  • the local token is stored ONLY after the PB PATCH succeeds
//  • never enforce on an empty PB token (pre-migration users) or read errors
//  • an app restart with a matching token keeps the session; a mismatch signs
//    the device out — it does NOT steal the session back.
const sessionTokenKey = (uid: string) => `shib_session_token_${uid}`;

function generateSessionToken(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

async function claimOrEnforceSession(pbId: string, uid: string): Promise<'ok' | 'superseded'> {
  try {
    const key   = sessionTokenKey(uid);
    const local = await storage.getItem(key);
    // authWithPassword just ran in pbDirectLogin, so the auth record is fresh
    const raw: any = (pb.authStore as any).record ?? pb.authStore.model;
    const remote = String(raw?.session_token ?? '');

    if (!local) {
      // Fresh login on this device (or reinstall) → claim the session
      const token = generateSessionToken();
      await pb.collection('users').update(pbId, { session_token: token });
      await storage.setItem(key, token); // persist ONLY after the PATCH succeeded
      return 'ok';
    }
    if (!remote) {
      // Empty server token (pre-migration) → re-claim with our existing token
      try { await pb.collection('users').update(pbId, { session_token: local }); } catch {}
      return 'ok';
    }
    return remote === local ? 'ok' : 'superseded';
  } catch (e: any) {
    // A network/PB failure must NEVER lock the user out
    console.warn('[Session] claim/enforce skipped (network?):', e?.message);
    return 'ok';
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

  // ── Forced logout when another device claims the session ─────────────────
  const sessionLogoutInFlight = useRef(false);
  async function forceSessionLogout() {
    if (sessionLogoutInFlight.current) return;
    sessionLogoutInFlight.current = true;
    try {
      const uid = auth.currentUser?.uid;
      if (uid) await storage.removeItem(sessionTokenKey(uid)).catch(() => {});
      // Only alert in the foreground — a backgrounded device signs out silently
      if (AppState.currentState === 'active') {
        Alert.alert(
          'Signed Out',
          'Your account was signed in on another device. Only one device can be active at a time.'
        );
      }
      await signOut();
    } catch (e: any) {
      console.warn('[Session] forced logout error:', e?.message);
    } finally {
      sessionLogoutInFlight.current = false;
    }
  }

  // ── Single-session watcher: realtime push + poll + foreground check ──────
  // Realtime is instant (EventSource polyfilled for native in lib/pocketbase);
  // the 45s poll and the AppState listener cover silently-dropped SSE
  // connections. NEVER logs out on read errors or empty server tokens.
  useEffect(() => {
    const pbId = pbUser?.pbId;
    const uid  = firebaseUser?.uid ?? auth.currentUser?.uid;
    if (!pbId || !uid) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const check = async (record?: any) => {
      try {
        const local = await storage.getItem(sessionTokenKey(uid));
        if (!local || cancelled) return; // nothing claimed on this device yet
        let remote = '';
        if (record) {
          remote = String(record.session_token ?? '');
        } else {
          const fresh: any = await pb.collection('users').getOne(pbId, { fields: 'id,session_token' });
          remote = String(fresh?.session_token ?? '');
        }
        if (!cancelled && remote && remote !== local) await forceSessionLogout();
      } catch { /* network error — never logout on read failures */ }
    };

    // 1) Realtime push — instant logout the moment another device claims
    pb.collection('users').subscribe(pbId, (e) => { void check(e.record); })
      .then((u) => { if (cancelled) { try { u(); } catch {} } else unsubscribe = u; })
      .catch((e: any) => console.warn('[Session] realtime unavailable, poll fallback active:', e?.message));

    // 2) Poll fallback (mobile SSE connections can drop silently)
    const iv = setInterval(() => { void check(); }, 45_000);

    // 3) Immediate re-check when the app returns to the foreground
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void check(); });

    return () => {
      cancelled = true;
      clearInterval(iv);
      try { unsubscribe?.(); } catch {}
      sub.remove();
    };
  }, [pbUser?.pbId, firebaseUser?.uid]);

  // ── App startup session restore ──────────────────────────────────────────
  async function handleAuthStateChange(fbUser: FirebaseUser | null) {
    if (!fbUser) {
      setUser(null);
      setPbUser(null);
      setFirebaseUser(null);
      setIsLoading(false);
      return;
    }

    setFirebaseUser(fbUser);

    // ── Fast path: load cached profile instantly ──────────────────────────
    // If we have a profile cached from a previous session, show the home screen
    // immediately (isLoading → false) while the live PocketBase refresh runs in
    // the background. This eliminates the 3-5 second blank-screen delay on
    // every app restart for returning users.
    try {
      const cachedRaw = await storage.getItem(`shib_profile_${fbUser.uid}`);
      if (cachedRaw) {
        const cachedProfile: UserProfile = JSON.parse(cachedRaw);
        if (cachedProfile?.is_verified) {
          setUser(cachedProfile);
          setIsLoading(false); // ← instant: app opens straight to home screen
          // Restore PB SDK session so mining ops don't 403 while refreshing
          await restorePbSession().catch(() => {});
          // Reload Firebase state in background (don't await — we're already shown)
          fbUser.reload().catch(() => {});
          const freshUser = auth.currentUser ?? fbUser;
          setFirebaseUser(freshUser);
          // Live refresh in background — updates balance, booster status, etc.
          confirmAndLoadUser(freshUser).catch((e: any) => {
            console.warn('[Auth] Background refresh failed:', e?.message);
            if (e?.code === 'EMAIL_PERMANENTLY_BANNED' || e?.status === 403) {
              Alert.alert(
                'Account Permanently Banned',
                e.message || 'This email address is permanently banned.',
                [{ text: 'OK' }]
              );
            }
          });
          return; // fast path complete
        }
      }
    } catch { /* cache miss or parse error — fall through to full load */ }

    // ── Full load path (first login or cache miss) ────────────────────────
    try { await fbUser.reload(); } catch {}
    const freshUser = auth.currentUser ?? fbUser;
    setFirebaseUser(freshUser);

    if (freshUser.emailVerified) {
      try {
        await confirmAndLoadUser(freshUser);
      } catch (e: any) {
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

      // ── Single-session enforcement: claim the session or get kicked ──────
      const sessionState = await claimOrEnforceSession(pbRecord.pbId, fbUser.uid);
      if (sessionState === 'superseded') {
        setIsLoading(false);
        await forceSessionLogout();
        return;
      }

      // Process any pending referral commissions for this user (deferred crediting pattern).
      // If this user was referred someone who just claimed, their commission is in the log.
      // This self-updates their own balance (always allowed) and resolves within ~1 second.
      if (pbRecord) {
        const pendingCommission = await processPendingReferralEarnings(pbRecord.pbId);
        if (pendingCommission > 0) {
          // Update the in-memory record so the displayed balance is accurate immediately
          pbRecord = {
            ...pbRecord,
            shibBalance:      (Number(pbRecord.shibBalance)      || 0) + pendingCommission,
            referralBalance:  (Number(pbRecord.referralBalance)  || 0) + pendingCommission,
            referralEarnings: (Number(pbRecord.referralEarnings) || 0) + pendingCommission,
          };
        }
      }

      if (!pbRecord) throw new Error('Failed to load or create the user record');
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
      // ── Security: block permanently-deleted and fraud emails before Firebase account creation ──
      const normEmail = email.toLowerCase().trim();
      try {
        const delRes = await pb.collection('deleted_emails').getList(1, 1, {
          filter: `email = "${normEmail}"`,
          fields: 'id',
        });
        if (delRes.totalItems > 0) {
          throw Object.assign(
            new Error('An account was previously associated with this email. This email is permanently restricted from new registrations.'),
            { code: 'EMAIL_PERMANENTLY_BANNED' },
          );
        }
      } catch (e: any) { if (e?.code === 'EMAIL_PERMANENTLY_BANNED') throw e; /* collection unreachable — allow */ }
      try {
        const fraudRes = await pb.collection('fraud_emails').getList(1, 1, {
          filter: `email = "${normEmail}"`,
          fields: 'id',
        });
        if (fraudRes.totalItems > 0) {
          throw Object.assign(
            new Error('This email has been permanently banned due to fraudulent activity.'),
            { code: 'ACCOUNT_BLOCKED', status: 403 },
          );
        }
      } catch (e: any) { if (e?.code === 'ACCOUNT_BLOCKED') throw e; /* collection unreachable — allow */ }

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
        // ── Security: block deleted and fraud emails (unauthenticated PB query) ──
        // Both collections have listRule:"" (public read) so this works pre-auth.
        const normEmail = email.toLowerCase().trim();
        try {
          const delRes = await pb.collection('deleted_emails').getList(1, 1, {
            filter: `email = "${normEmail}"`,
            fields: 'id',
          });
          if (delRes.totalItems > 0) {
            try { await firebaseSignOut(auth); } catch {}
            throw Object.assign(
              new Error('An account was previously associated with this email. This email is permanently restricted from new registrations.'),
              { code: 'EMAIL_PERMANENTLY_BANNED' },
            );
          }
        } catch (e: any) { if (e?.code === 'EMAIL_PERMANENTLY_BANNED') throw e; }
        try {
          const fraudRes = await pb.collection('fraud_emails').getList(1, 1, {
            filter: `email = "${normEmail}"`,
            fields: 'id',
          });
          if (fraudRes.totalItems > 0) {
            try { await firebaseSignOut(auth); } catch {}
            throw Object.assign(
              new Error('This email has been permanently banned due to fraudulent activity.'),
              { code: 'ACCOUNT_BLOCKED', status: 403 },
            );
          }
        } catch (e: any) { if (e?.code === 'ACCOUNT_BLOCKED') throw e; }

        // ✅ Verified and not blocked — sync with PB and open the app
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
    // Clear ALL persisted session data so the user must log in again
    try { await storage.removeItem(PB_SESSION_KEY); } catch {}
    try {
      const fbUser = auth.currentUser;
      if (fbUser?.uid) {
        await storage.removeItem(`shib_profile_${fbUser.uid}`).catch(() => {});
        // Clear the LOCAL session token only — never the PB field (a newer
        // device may own the session now; the next login here claims fresh).
        await storage.removeItem(sessionTokenKey(fbUser.uid)).catch(() => {});
      }
    } catch {}
    // Clear PocketBase SDK auth store
    try { pb.authStore.clear(); } catch {}
    // Sign out of Firebase (clears AsyncStorage-persisted Firebase session)
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
      // PRIMARY: PocketBase SDK direct — works on APK + web preview without Express
      let pbRecord = await pbGetSelf();
      if (!pbRecord) {
        // Fallback: try Express (e.g. if PB session expired)
        pbRecord = await api.getUser(fbUser.uid).catch(() => null);
      }
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
      // PRIMARY: PocketBase SDK direct — works on APK + web preview without Express
      let pbRecord = await pbGetSelf();
      if (!pbRecord) {
        // Fallback: try Express (e.g. if PB session expired)
        pbRecord = await api.getUser(fbUser.uid).catch(() => null);
      }
      if (!pbRecord) return;
      if (pbRecord.status === 'blocked') {
        Alert.alert('ACCOUNT BANNED!', 'Your account has been permanently disabled due to multiple fraud attempts.');
        await signOut();
        return;
      }
      // Process any pending referral commissions and apply to in-memory record
      if (pbRecord.pbId) {
        const earned = await processPendingReferralEarnings(pbRecord.pbId).catch(() => 0);
        if (earned > 0) {
          // Mirror only referral_balance + referral_earnings — NOT shib_balance (wallet).
          // Referral commissions must be claimed by the user via the Claim button.
          pbRecord = {
            ...pbRecord,
            referralBalance:  (pbRecord.referralBalance  || 0) + earned,
            referralEarnings: (pbRecord.referralEarnings || 0) + earned,
          };
        }
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

  // ── KYC status sync ──────────────────────────────────────────────────────
  // The verification_requests row is the source of truth (an admin may edit
  // its status directly in the PB dashboard). The Express status endpoint
  // self-heals users.kyc_status from that row; the PB-direct read is the APK
  // fallback when Express is unreachable (display-only — users updateRule
  // blocks kyc_* self-writes).
  async function refreshKycStatus() {
    const pbId = pbUser?.pbId;
    if (!pbId) return;
    let status: 'none' | 'under_review' | 'verified' | 'rejected' | null = null;
    let reason = '';
    try {
      const r = await api.getVerificationStatus(pbId);
      status = r.kycStatus;
      reason = r.rejectReason || '';
    } catch {
      try {
        const rows = await pb.collection('verification_requests').getList(1, 1, {
          filter: `user = "${pbId}"`,
          sort: '-created',
        });
        const row: any = rows.items[0];
        if (!row) return;
        status = normalizeKycStatus(row.status);
        reason = String(row.reject_reason || '');
      } catch {
        return;
      }
    }
    if (!status || status === 'none') return;
    const s = status;
    setPbUser((prev) => {
      if (!prev || (prev.kycStatus === s && (prev.kycRejectReason || '') === reason)) return prev;
      return { ...prev, kycStatus: s, kycRejectReason: reason };
    });
    setUser((prev) => {
      if (!prev || (prev.kycStatus === s && (prev.kycRejectReason || '') === reason)) return prev;
      return { ...prev, kycStatus: s, kycRejectReason: reason };
    });
  }

  // ── Background referral commission poll (every 60 s while logged in) ────────
  // Ensures the home-screen SHIB balance reflects new commissions without re-login.
  useEffect(() => {
    if (!pbUser?.pbId) return;
    const id = setInterval(() => { refreshBalance().catch(() => {}); }, 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pbUser?.pbId]);

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
    refreshKycStatus,
    optimisticUpdatePt,
  }), [user, firebaseUser, isLoading, isAdmin, pbUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
