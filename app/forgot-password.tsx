import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
  Image,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { api } from '@/lib/api';
import { pb } from '@/lib/pocketbase';
import Colors from '@/constants/colors';

type Step = 'input' | 'success';

export default function ForgotPasswordScreen() {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSend() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setErrorMsg('Please enter your email address.');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) {
      setErrorMsg('Please enter a valid email address.');
      return;
    }
    setErrorMsg('');
    setIsLoading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

      // Check if email is registered — try Express first, fall back to PB SDK
      let found = false;
      try {
        const res = await api.checkEmailExists(trimmed);
        found = res.found;
      } catch {
        try {
          const res = await pb.collection('users').getList(1, 1, {
            filter: `email = "${trimmed}"`,
            fields: 'id',
          });
          found = res.totalItems > 0;
        } catch {
          // Can't verify — let Firebase handle it gracefully
          found = true;
        }
      }

      if (!found) {
        setErrorMsg('This email is not registered with us.');
        return;
      }
      await sendPasswordResetEmail(auth, trimmed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setStep('success');
    } catch (e: any) {
      const code = e?.code || '';
      if (code === 'auth/invalid-email') {
        setErrorMsg('Please enter a valid email address.');
      } else if (code === 'auth/too-many-requests') {
        setErrorMsg('Too many attempts. Please try again later.');
      } else {
        setErrorMsg(e?.message || 'Something went wrong. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[styles.scroll, {
            paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 24),
            paddingBottom: insets.bottom + 40,
          }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Back button */}
          <Pressable
            style={styles.backBtn}
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); router.back(); }}
            testID="btn-back"
          >
            <Ionicons name="arrow-back" size={22} color={Colors.textSecondary} />
            <Text style={styles.backText}>Back to Sign In</Text>
          </Pressable>

          {/* Icon */}
          <View style={styles.iconWrap}>
            <View style={styles.iconCircle}>
              <Ionicons name="lock-closed-outline" size={40} color={Colors.neonOrange} />
            </View>
          </View>

          {step === 'input' ? (
            <>
              <Text style={styles.title}>Forgot Password?</Text>
              <Text style={styles.subtitle}>
                Enter the email address linked to your account and we'll send you a reset link.
              </Text>

              {/* Email input */}
              <View style={styles.inputWrap}>
                <Ionicons name="mail-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Email address"
                  placeholderTextColor={Colors.textMuted}
                  value={email}
                  onChangeText={(v) => { setEmail(v); setErrorMsg(''); }}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  returnKeyType="send"
                  onSubmitEditing={handleSend}
                  testID="input-email"
                />
              </View>

              {errorMsg !== '' && (
                <View style={styles.errorBox}>
                  <Ionicons name="alert-circle-outline" size={16} color={Colors.error} />
                  <Text style={styles.errorText}>{errorMsg}</Text>
                </View>
              )}

              {/* Send button */}
              <Pressable
                style={[styles.sendBtn, isLoading && styles.sendBtnDisabled]}
                onPress={handleSend}
                disabled={isLoading}
                testID="btn-send"
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color="#000" />
                ) : (
                  <Text style={styles.sendBtnText}>Send Reset Link</Text>
                )}
              </Pressable>

              <Text style={styles.hint}>
                Check your spam folder if you don't see the email within a few minutes.
              </Text>
            </>
          ) : (
            /* Success state */
            <View style={styles.successWrap}>
              <View style={styles.successCircle}>
                <Ionicons name="checkmark-circle" size={64} color="#22c55e" />
              </View>
              <Text style={styles.successTitle}>Email Sent!</Text>
              <Text style={styles.successMsg}>
                Reset link sent successfully!{'\n'}Please check your inbox.
              </Text>
              <Text style={styles.successEmail}>{email.trim().toLowerCase()}</Text>

              <Pressable
                style={styles.backToLoginBtn}
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); router.replace('/auth' as any); }}
                testID="btn-back-to-login"
              >
                <Ionicons name="arrow-back" size={16} color={Colors.darkBg} />
                <Text style={styles.backToLoginText}>Back to Sign In</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 24 },

  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 32,
    alignSelf: 'flex-start',
  },
  backText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 14,
    color: Colors.textSecondary,
  },

  iconWrap: { alignItems: 'center', marginBottom: 28 },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: 'rgba(255,107,0,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,107,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
    paddingHorizontal: 8,
  },

  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    borderRadius: 14,
    paddingHorizontal: 14,
    marginBottom: 14,
    height: 54,
  },
  inputIcon: { marginRight: 10 },
  input: {
    flex: 1,
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    color: Colors.textPrimary,
    height: 54,
  },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,68,68,0.1)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,68,68,0.3)',
  },
  errorText: {
    flex: 1,
    fontFamily: 'Inter_500Medium',
    fontSize: 13,
    color: Colors.error,
    lineHeight: 18,
  },

  sendBtn: {
    backgroundColor: Colors.neonOrange,
    borderRadius: 14,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    shadowColor: Colors.neonOrange,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  sendBtnDisabled: { opacity: 0.6 },
  sendBtnText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
    color: '#000',
    letterSpacing: 0.3,
  },

  hint: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 16,
  },

  /* Success state */
  successWrap: { alignItems: 'center', paddingTop: 16 },
  successCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(34,197,94,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  successTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    color: Colors.textPrimary,
    marginBottom: 12,
  },
  successMsg: {
    fontFamily: 'Inter_500Medium',
    fontSize: 16,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 12,
  },
  successEmail: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
    color: Colors.neonOrange,
    marginBottom: 36,
  },
  backToLoginBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.neonOrange,
    borderRadius: 14,
    paddingHorizontal: 28,
    paddingVertical: 14,
    shadowColor: Colors.neonOrange,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  backToLoginText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 15,
    color: Colors.darkBg,
  },
});
