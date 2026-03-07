import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, Pressable,
  ScrollView, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import Colors from '@/constants/colors';

type Mode = 'signin' | 'signup';

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

  function switchMode(m: Mode) {
    setMode(m);
    setErrorMsg('');
    setShowEmailUnverified(false);
  }

  async function handleSubmit() {
    if (isLoading) return;
    setErrorMsg('');
    setShowEmailUnverified(false);

    if (!email.trim() || !password.trim()) {
      setErrorMsg('Please fill in all required fields.');
      return;
    }
    if (mode === 'signup') {
      if (!displayName.trim()) {
        setErrorMsg('Please enter your display name.');
        return;
      }
      if (password !== confirmPassword) {
        setErrorMsg('Passwords do not match.');
        return;
      }
      if (password.length < 6) {
        setErrorMsg('Password must be at least 6 characters.');
        return;
      }
    }

    setIsLoading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        const trimmedCode = referralCode.trim();
        if (trimmedCode) {
          const check = await api.validateReferralCode(trimmedCode);
          if (!check.valid) {
            setErrorMsg('Invalid Referral Code. Please check and try again.');
            setIsLoading(false);
            return;
          }
        }
        await signUp(email.trim(), password, displayName.trim(), trimmedCode || undefined);
      }
    } catch (e: any) {
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
        : code === 'auth/weak-password' ? 'Password must be at least 6 characters.'
        : e?.message || 'Something went wrong. Please try again.';
      setErrorMsg(msg);
    } finally {
      setIsLoading(false);
    }
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
    if (!email.trim()) {
      setErrorMsg('Enter your email address first.');
      return;
    }
    try {
      await forgotPassword(email.trim());
      Alert.alert('Sent', 'Password reset link sent to your email.');
    } catch (e: any) {
      setErrorMsg(e?.message || 'Could not send reset email.');
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            {
              paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 40),
              paddingBottom: insets.bottom + 32,
            },
          ]}
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
                icon="person-circle-outline"
                label="Display Name"
                value={displayName}
                onChangeText={(v: string) => { setDisplayName(v); setErrorMsg(''); }}
                placeholder="Your name"
                autoCapitalize="words"
                testID="input-displayname"
              />
            )}

            <InputField
              icon="mail-outline"
              label="Email"
              value={email}
              onChangeText={(v: string) => { setEmail(v); setErrorMsg(''); }}
              placeholder="you@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
              testID="input-email"
            />

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={password}
                  onChangeText={(v) => { setPassword(v); setErrorMsg(''); }}
                  placeholder="••••••••"
                  placeholderTextColor={Colors.textMuted}
                  secureTextEntry={!showPassword}
                  testID="input-password"
                />
                <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={18}
                    color={Colors.textMuted}
                  />
                </Pressable>
              </View>
            </View>

            {mode === 'signup' && (
              <>
                <InputField
                  icon="lock-closed-outline"
                  label="Confirm Password"
                  value={confirmPassword}
                  onChangeText={(v: string) => { setConfirmPassword(v); setErrorMsg(''); }}
                  placeholder="••••••••"
                  secureTextEntry={!showPassword}
                  testID="input-confirm-password"
                />
                <InputField
                  icon="gift-outline"
                  label="Referral Code (Optional)"
                  value={referralCode}
                  onChangeText={setReferralCode}
                  placeholder="6-digit code"
                  autoCapitalize="characters"
                  maxLength={6}
                  testID="input-referral"
                />
              </>
            )}

            {errorMsg !== '' && (
              <View style={styles.errorBox} testID="auth-error">
                <Ionicons name="alert-circle-outline" size={16} color={Colors.error} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={styles.errorText}>{errorMsg}</Text>
                  {showEmailUnverified && mode === 'signin' && (
                    <Pressable
                      onPress={handleResendFromSignIn}
                      disabled={isResending}
                      testID="btn-resend-from-signin"
                    >
                      {isResending
                        ? <ActivityIndicator color={Colors.gold} size="small" />
                        : <Text style={styles.resendLinkText}>Resend verification email →</Text>
                      }
                    </Pressable>
                  )}
                </View>
              </View>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.submitBtn,
                { opacity: isLoading ? 0.7 : pressed ? 0.85 : 1 },
              ]}
              onPress={handleSubmit}
              disabled={isLoading}
              testID="btn-submit"
            >
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                style={styles.submitGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
              >
                {isLoading ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.submitText}>
                    {mode === 'signin' ? 'Sign In' : 'Create Account'}
                  </Text>
                )}
              </LinearGradient>
            </Pressable>

            {mode === 'signin' && (
              <Pressable
                onPress={handleForgotPassword}
                style={styles.forgotPasswordBtn}
                testID="btn-forgot"
              >
                <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
              </Pressable>
            )}

            {mode === 'signup' && (
              <Text style={styles.termsText}>
                A verification link will be sent to your email — free, no SMS required.
              </Text>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
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
  logoCircle: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center', marginBottom: 14,
  },
  appName: { fontFamily: 'Inter_700Bold', fontSize: 30, color: Colors.gold, letterSpacing: 1 },
  tagline: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary, marginTop: 4 },
  card: {
    backgroundColor: Colors.darkCard, borderRadius: 24,
    padding: 22, borderWidth: 1, borderColor: Colors.darkBorder,
  },
  modeToggle: {
    flexDirection: 'row', backgroundColor: Colors.darkSurface,
    borderRadius: 12, padding: 4, marginBottom: 20,
  },
  modeBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  modeBtnActive: { backgroundColor: Colors.darkCard, borderWidth: 1, borderColor: Colors.darkBorder },
  modeBtnText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },
  modeBtnTextActive: { color: Colors.gold },
  inputGroup: { marginBottom: 14 },
  label: {
    fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.textSecondary,
    marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.8,
  },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.darkSurface,
    borderRadius: 12, borderWidth: 1, borderColor: Colors.darkBorder,
    paddingHorizontal: 14, height: 50,
  },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 15, color: Colors.textPrimary },
  eyeBtn: { padding: 4 },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(255,68,68,0.1)', borderRadius: 10, padding: 12,
    marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,68,68,0.3)',
  },
  errorText: {
    flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13,
    color: Colors.error, lineHeight: 18,
  },
  submitBtn: { marginTop: 4 },
  submitGradient: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  forgotPasswordBtn: { marginTop: 16, alignItems: 'center' },
  forgotPasswordText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.gold },
  termsText: {
    fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted,
    textAlign: 'center', marginTop: 14, lineHeight: 18,
  },
  resendLinkText: {
    fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold,
  },
});
