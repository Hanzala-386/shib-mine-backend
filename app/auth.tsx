import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, StyleSheet, Pressable,
  ScrollView, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert, Modal, Animated,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import Colors from '@/constants/colors';

type Mode = 'signin' | 'signup';

const TERMS_KEY = 'shib_mine_terms_v1';

/* ── Password strength ── */
type StrengthLevel = 0 | 1 | 2 | 3 | 4 | 5;
interface Strength { score: StrengthLevel; label: string; color: string }

function getStrength(pw: string): Strength {
  let score = 0;
  if (pw.length >= 8)              score++;
  if (/[A-Z]/.test(pw))            score++;
  if (/[a-z]/.test(pw))            score++;
  if (/[0-9]/.test(pw))            score++;
  if (/[^A-Za-z0-9]/.test(pw))    score++;

  if (score <= 1) return { score: score as StrengthLevel, label: 'Very Weak',   color: '#f44336' };
  if (score === 2) return { score: 2, label: 'Weak',        color: '#ff5722' };
  if (score === 3) return { score: 3, label: 'Fair',        color: '#ff9800' };
  if (score === 4) return { score: 4, label: 'Strong',      color: '#8bc34a' };
  return              { score: 5, label: 'Very Strong', color: '#4caf50' };
}

function validateStrongPassword(pw: string): string | null {
  if (pw.length < 8)              return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pw))          return 'Add at least one uppercase letter (A-Z).';
  if (!/[a-z]/.test(pw))          return 'Add at least one lowercase letter (a-z).';
  if (!/[0-9]/.test(pw))          return 'Add at least one number (0-9).';
  if (!/[^A-Za-z0-9]/.test(pw))  return 'Add at least one special character (!@#$%^&*).';
  return null;
}

/* ── Strength bar component ── */
function StrengthBar({ password }: { password: string }) {
  const strength = getStrength(password);
  const widthAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: (strength.score / 5) * 100,
      duration: 260,
      useNativeDriver: false,
    }).start();
  }, [strength.score]);

  if (!password) return null;

  return (
    <View style={sBar.wrap}>
      <View style={sBar.track}>
        <Animated.View
          style={[
            sBar.fill,
            {
              width: widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
              backgroundColor: strength.color,
            },
          ]}
        />
      </View>
      <View style={sBar.row}>
        <Text style={[sBar.label, { color: strength.color }]}>{strength.label}</Text>
        <View style={sBar.checks}>
          {[
            { pass: password.length >= 8,           tip: '8+ chars' },
            { pass: /[A-Z]/.test(password),          tip: 'A-Z' },
            { pass: /[a-z]/.test(password),          tip: 'a-z' },
            { pass: /[0-9]/.test(password),          tip: '0-9' },
            { pass: /[^A-Za-z0-9]/.test(password),  tip: '!@#' },
          ].map(({ pass, tip }) => (
            <View key={tip} style={[sBar.chip, { backgroundColor: pass ? strength.color + '25' : 'rgba(255,255,255,0.05)' }]}>
              <Ionicons name={pass ? 'checkmark' : 'close'} size={9} color={pass ? strength.color : Colors.textMuted} />
              <Text style={[sBar.chipText, { color: pass ? strength.color : Colors.textMuted }]}>{tip}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const sBar = StyleSheet.create({
  wrap:  { marginTop: 8, marginBottom: 4, gap: 6 },
  track: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
  fill:  { height: 4, borderRadius: 2 },
  row:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 },
  label: { fontFamily: 'Inter_700Bold', fontSize: 11 },
  checks:{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  chip:  { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5 },
  chipText: { fontFamily: 'Inter_500Medium', fontSize: 9 },
});

/* ── T&C Modal content ── */
const TC_CONTENT = `1. Platform Nature
SHIB Mine is a gamified engagement and rewards platform. No device hardware is used for cryptocurrency mining. Virtual SHIB tokens are earned through in-app sessions, rewarded ads, and mini-games.

2. Data Collection
We collect your email address and display name for account management. We do not collect payment data or government ID.

3. Virtual Rewards
SHIB token balances have no inherent monetary value until approved through our withdrawal reward model. Rewards cannot be transferred between accounts.

4. Withdrawal Processing
Withdrawal requests are reviewed manually within 24 hours. Requests may be rejected for fraudulent activity or invalid wallet details.

5. Advertising
The App displays ads via Google AdMob and other ad networks. Attempting to block or manipulate ad delivery may result in account suspension.

6. Prohibited Conduct
You agree not to use bots, scripts, or multiple accounts to abuse the reward system. Violations will result in account termination and forfeiture of all balances.

7. Age Requirement
You must be at least 13 years old to use this app.

8. Amendments
We may update these Terms at any time. Continued use of the App constitutes acceptance of the revised Terms.

By creating an account, you confirm you have read and agree to our full Privacy Policy and Terms of Service.`;

/* ══════════════════════════════════════════════════════════════════════════ */
export default function AuthScreen() {
  const insets = useSafeAreaInsets();
  const { signIn, signUp, forgotPassword, resendVerificationEmail } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [showEmailUnverified, setShowEmailUnverified] = useState(false);
  const [isResending, setIsResending] = useState(false);

  /* T&C state */
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [termsScrolled, setTermsScrolled] = useState(false);
  const [termsChecked, setTermsChecked] = useState(false);
  const pendingSignupRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(TERMS_KEY).then((v) => setTermsAccepted(v === 'true'));
  }, []);

  function switchMode(m: Mode) {
    setMode(m);
    setErrorMsg('');
    setShowEmailUnverified(false);
  }

  const doSignup = useCallback(async () => {
    if (!email.trim() || !password.trim()) { setErrorMsg('Please fill in all required fields.'); return; }
    if (!displayName.trim()) { setErrorMsg('Please enter your display name.'); return; }
    if (password !== confirmPassword) { setErrorMsg('Passwords do not match.'); return; }
    const pwErr = validateStrongPassword(password);
    if (pwErr) { setErrorMsg(pwErr); return; }
    const ALLOWED = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
    const domain = email.trim().split('@')[1]?.toLowerCase() ?? '';
    if (!ALLOWED.includes(domain)) { setErrorMsg('Only Gmail, Yahoo, Outlook, Hotmail, and iCloud emails are allowed.'); return; }

    setIsLoading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      const trimmedCode = referralCode.trim();
      if (trimmedCode) {
        const check = await api.validateReferralCode(trimmedCode);
        if (!check.valid) { setErrorMsg('Invalid Referral Code. Please check and try again.'); setIsLoading(false); return; }
      }
      await signUp(email.trim(), password, displayName.trim(), trimmedCode || undefined);
    } catch (e: any) {
      handleAuthError(e);
    } finally {
      setIsLoading(false);
    }
  }, [email, password, confirmPassword, displayName, referralCode, signUp]);

  function handleAuthError(e: any) {
    const code = e?.code || '';
    if (code === 'EMAIL_NOT_VERIFIED') {
      setShowEmailUnverified(true);
      setErrorMsg('Your email is not verified. Check your inbox for the verification link.');
      return;
    }
    const msg =
      code === 'auth/email-already-in-use' ? 'An account with this email already exists. Try signing in.'
      : code === 'auth/invalid-email' ? 'Please enter a valid email address.'
      : code === 'auth/wrong-password' || code === 'auth/invalid-credential' ? 'Incorrect email or password.'
      : code === 'auth/user-not-found' ? 'No account found with this email.'
      : code === 'auth/too-many-requests' ? 'Too many attempts. Please try again later.'
      : code === 'auth/network-request-failed' ? 'Network error. Check your connection.'
      : code === 'auth/weak-password' ? 'Password is too weak. Please use a stronger password.'
      : e?.message || 'Something went wrong. Please try again.';
    setErrorMsg(msg);
  }

  async function handleSubmit() {
    if (isLoading) return;
    setErrorMsg('');
    setShowEmailUnverified(false);

    if (mode === 'signin') {
      if (!email.trim() || !password.trim()) { setErrorMsg('Please fill in all required fields.'); return; }
      setIsLoading(true);
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        await signIn(email.trim(), password);
      } catch (e: any) {
        handleAuthError(e);
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // Signup: show T&C first if not yet accepted
    if (!termsAccepted) {
      pendingSignupRef.current = true;
      setTermsScrolled(false);
      setTermsChecked(false);
      setShowTermsModal(true);
      return;
    }
    await doSignup();
  }

  async function handleAcceptTerms() {
    await AsyncStorage.setItem(TERMS_KEY, 'true');
    setTermsAccepted(true);
    setShowTermsModal(false);
    if (pendingSignupRef.current) {
      pendingSignupRef.current = false;
      await doSignup();
    }
  }

  function handleTermsScroll(e: any) {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const isBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 40;
    if (isBottom) setTermsScrolled(true);
  }

  async function handleResendFromSignIn() {
    if (isResending) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setIsResending(true);
    try {
      await resendVerificationEmail();
      Alert.alert('Email Sent', 'A new verification link has been sent to your email.');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not resend verification email.');
    } finally {
      setIsResending(false);
    }
  }

  async function handleForgotPassword() {
    if (!email.trim()) { setErrorMsg('Enter your email address first.'); return; }
    try {
      await forgotPassword(email.trim());
      Alert.alert('Sent', 'Password reset link sent to your email.');
    } catch (e: any) {
      setErrorMsg(e?.message || 'Could not send reset email.');
    }
  }

  const canContinueTerms = termsScrolled && termsChecked;

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[styles.scroll, {
            paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 40),
            paddingBottom: insets.bottom + 32,
          }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.logoArea}>
            <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.logoCircle}>
              <MaterialCommunityIcons name="pickaxe" size={36} color="#000" />
            </LinearGradient>
            <Text style={styles.appName}>SHIB Mine</Text>
            <Text style={styles.tagline}>Mine. Earn. Grow.</Text>
          </View>

          <View style={styles.card}>
            <View style={styles.modeToggle}>
              {(['signin', 'signup'] as Mode[]).map((m) => (
                <Pressable
                  key={m}
                  style={[styles.modeBtn, mode === m && styles.modeBtnActive]}
                  onPress={() => switchMode(m)}
                  testID={`mode-${m}`}
                >
                  <Text style={[styles.modeBtnText, mode === m && styles.modeBtnTextActive]}>
                    {m === 'signin' ? 'Sign In' : 'Sign Up'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {mode === 'signup' && (
              <InputField
                icon="person-circle-outline" label="Display Name"
                value={displayName} onChangeText={(v: string) => { setDisplayName(v); setErrorMsg(''); }}
                placeholder="Your name" autoCapitalize="words" testID="input-displayname"
              />
            )}

            <InputField
              icon="mail-outline" label="Email"
              value={email} onChangeText={(v: string) => { setEmail(v); setErrorMsg(''); }}
              placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address"
              testID="input-email"
            />

            {/* Password with eye toggle */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={password}
                  onChangeText={(v) => { setPassword(v); setErrorMsg(''); }}
                  placeholder={mode === 'signup' ? '8+ chars, A-Z, 0-9, !@#' : '••••••••'}
                  placeholderTextColor={Colors.textMuted}
                  secureTextEntry={!showPassword}
                  testID="input-password"
                />
                <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
                  <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color={Colors.textMuted} />
                </Pressable>
              </View>
              {/* Live strength meter — signup only */}
              {mode === 'signup' && <StrengthBar password={password} />}
            </View>

            {mode === 'signup' && (
              <>
                <InputField
                  icon="lock-closed-outline" label="Confirm Password"
                  value={confirmPassword} onChangeText={(v: string) => { setConfirmPassword(v); setErrorMsg(''); }}
                  placeholder="••••••••" secureTextEntry={!showPassword} testID="input-confirm-password"
                />
                <InputField
                  icon="gift-outline" label="Referral Code (Optional)"
                  value={referralCode} onChangeText={setReferralCode}
                  placeholder="6-digit code" autoCapitalize="characters" maxLength={6} testID="input-referral"
                />
              </>
            )}

            {errorMsg !== '' && (
              <View style={styles.errorBox} testID="auth-error">
                <Ionicons name="alert-circle-outline" size={16} color={Colors.error} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={styles.errorText}>{errorMsg}</Text>
                  {showEmailUnverified && mode === 'signin' && (
                    <Pressable onPress={handleResendFromSignIn} disabled={isResending} testID="btn-resend-from-signin">
                      {isResending
                        ? <ActivityIndicator color={Colors.gold} size="small" />
                        : <Text style={styles.resendLinkText}>Resend verification email →</Text>}
                    </Pressable>
                  )}
                </View>
              </View>
            )}

            <Pressable
              style={({ pressed }) => [styles.submitBtn, { opacity: isLoading ? 0.7 : pressed ? 0.85 : 1 }]}
              onPress={handleSubmit}
              disabled={isLoading}
              testID="btn-submit"
            >
              <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.submitGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                {isLoading
                  ? <ActivityIndicator color="#000" />
                  : <Text style={styles.submitText}>{mode === 'signin' ? 'Sign In' : 'Create Account'}</Text>}
              </LinearGradient>
            </Pressable>

            {mode === 'signin' && (
              <Pressable onPress={handleForgotPassword} style={styles.forgotPasswordBtn} testID="btn-forgot">
                <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
              </Pressable>
            )}

            {mode === 'signup' && (
              <Text style={styles.termsText}>
                By signing up you agree to our Terms & Conditions and Privacy Policy. A verification email will be sent to you.
              </Text>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ══ TERMS & CONDITIONS MODAL ══════════════════════════════════════════ */}
      <Modal visible={showTermsModal} transparent animationType="slide" onRequestClose={() => setShowTermsModal(false)}>
        <View style={tc.overlay}>
          <View style={[tc.sheet, { paddingBottom: insets.bottom + 16 }]}>
            {/* Header */}
            <View style={tc.header}>
              <MaterialCommunityIcons name="shield-check" size={22} color={Colors.gold} />
              <Text style={tc.title}>Terms & Conditions</Text>
            </View>
            <Text style={tc.subhead}>Please read and scroll to the bottom before continuing</Text>

            {/* Scrollable content */}
            <ScrollView
              style={tc.scroll}
              onScroll={handleTermsScroll}
              scrollEventThrottle={100}
              showsVerticalScrollIndicator={true}
            >
              <Text style={tc.body}>{TC_CONTENT}</Text>
              <View style={tc.scrollHint}>
                <Ionicons name="arrow-down-circle" size={18} color={termsScrolled ? '#4caf50' : Colors.textMuted} />
                <Text style={[tc.scrollHintText, termsScrolled && { color: '#4caf50' }]}>
                  {termsScrolled ? 'Scrolled to bottom ✓' : 'Scroll to the bottom to continue'}
                </Text>
              </View>
            </ScrollView>

            {/* Checkbox */}
            <Pressable
              style={[tc.checkRow, !termsScrolled && { opacity: 0.4 }]}
              onPress={() => { if (termsScrolled) setTermsChecked(!termsChecked); }}
              disabled={!termsScrolled}
            >
              <View style={[tc.checkbox, termsChecked && tc.checkboxChecked]}>
                {termsChecked && <Ionicons name="checkmark" size={14} color="#000" />}
              </View>
              <Text style={tc.checkLabel}>I have read and agree to the Terms & Conditions and Privacy Policy</Text>
            </Pressable>

            {/* Continue button */}
            <Pressable
              style={[tc.continueBtn, !canContinueTerms && { opacity: 0.45 }]}
              onPress={handleAcceptTerms}
              disabled={!canContinueTerms}
            >
              <LinearGradient
                colors={canContinueTerms ? [Colors.gold, Colors.neonOrange] : ['#333', '#222']}
                style={tc.continueBtnGradient}
              >
                <Text style={[tc.continueBtnText, !canContinueTerms && { color: Colors.textMuted }]}>
                  {canContinueTerms ? 'Continue & Create Account' : 'Scroll to bottom first'}
                </Text>
              </LinearGradient>
            </Pressable>

            <Pressable onPress={() => setShowTermsModal(false)} style={tc.cancelBtn}>
              <Text style={tc.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function InputField({ icon, label, value, onChangeText, placeholder, autoCapitalize, keyboardType, secureTextEntry, maxLength, testID }: any) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputWrapper}>
        <Ionicons name={icon} size={18} color={Colors.textMuted} style={styles.inputIcon} />
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={Colors.textMuted}
          autoCapitalize={autoCapitalize ?? 'none'}
          keyboardType={keyboardType ?? 'default'}
          secureTextEntry={secureTextEntry ?? false}
          maxLength={maxLength}
          testID={testID}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 24 },
  logoArea: { alignItems: 'center', marginBottom: 32 },
  logoCircle: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  appName: { fontFamily: 'Inter_700Bold', fontSize: 30, color: Colors.gold, letterSpacing: 1 },
  tagline: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary, marginTop: 4 },
  card: { backgroundColor: Colors.darkCard, borderRadius: 24, padding: 22, borderWidth: 1, borderColor: Colors.darkBorder },
  modeToggle: { flexDirection: 'row', backgroundColor: Colors.darkSurface, borderRadius: 12, padding: 4, marginBottom: 20 },
  modeBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  modeBtnActive: { backgroundColor: Colors.darkCard, borderWidth: 1, borderColor: Colors.darkBorder },
  modeBtnText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },
  modeBtnTextActive: { color: Colors.gold },
  inputGroup: { marginBottom: 14 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.textSecondary, marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.8 },
  inputWrapper: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.darkSurface, borderRadius: 12, borderWidth: 1, borderColor: Colors.darkBorder, paddingHorizontal: 14, height: 50 },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 15, color: Colors.textPrimary },
  eyeBtn: { padding: 4 },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,68,68,0.1)', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,68,68,0.3)' },
  errorText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.error, lineHeight: 18 },
  submitBtn: { marginTop: 4 },
  submitGradient: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  forgotPasswordBtn: { marginTop: 16, alignItems: 'center' },
  forgotPasswordText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.gold },
  termsText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, textAlign: 'center', marginTop: 14, lineHeight: 18 },
  resendLinkText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
});

/* T&C modal styles */
const tc = StyleSheet.create({
  overlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  sheet:     { backgroundColor: Colors.darkCard, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: '90%' },
  header:    { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  title:     { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },
  subhead:   { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, marginBottom: 14 },
  scroll:    { maxHeight: 300, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: Colors.darkBorder },
  body:      { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, lineHeight: 22 },
  scrollHint:{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, paddingBottom: 4 },
  scrollHintText: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.textMuted },
  checkRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  checkbox:  { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: Colors.gold, alignItems: 'center', justifyContent: 'center', marginTop: 1, flexShrink: 0 },
  checkboxChecked: { backgroundColor: Colors.gold },
  checkLabel:{ flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textSecondary, lineHeight: 19 },
  continueBtn:       { marginBottom: 8 },
  continueBtnGradient: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  continueBtnText:   { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#000' },
  cancelBtn: { alignItems: 'center', paddingVertical: 8 },
  cancelText:{ fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textMuted },
});
