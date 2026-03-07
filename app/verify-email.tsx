import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator,
  TextInput,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

export default function VerifyEmailScreen() {
  const insets = useSafeAreaInsets();
  const { firebaseUser, signOut, resendOtp, verifyOtp } = useAuth();
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [resendMsg, setResendMsg] = useState('');

  const inputRefs = useRef<Array<TextInput | null>>([]);
  const verifyAttemptedRef = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (countdown > 0) {
      timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    }
    return () => clearTimeout(timer);
  }, [countdown]);

  const handleOtpChange = (value: string, index: number) => {
    setError(null);
    setResendMsg('');
    const newOtp = [...otp];

    if (value.length > 1) {
      const chars = value.replace(/\D/g, '').slice(0, 6).split('');
      chars.forEach((char, i) => {
        if (index + i < 6) newOtp[index + i] = char;
      });
      setOtp(newOtp);
      const nextIdx = Math.min(index + chars.length, 5);
      inputRefs.current[nextIdx]?.focus();
      if (newOtp.every((d) => d !== '')) {
        submitOtp(newOtp.join(''));
      }
      return;
    }

    newOtp[index] = value;
    setOtp(newOtp);

    if (value !== '' && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    if (newOtp.every((d) => d !== '')) {
      submitOtp(newOtp.join(''));
    }
  };

  const handleKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === 'Backspace' && otp[index] === '' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const submitOtp = async (code: string) => {
    if (isVerifying || verifyAttemptedRef.current) return;
    verifyAttemptedRef.current = true;
    setIsVerifying(true);
    setError(null);
    try {
      const email = firebaseUser?.email || '';
      const result = await verifyOtp(email, code);
      if (!result.success) {
        verifyAttemptedRef.current = false;
        setError(result.error || 'Invalid code. Please try again.');
        setOtp(['', '', '', '', '', '']);
        setTimeout(() => inputRefs.current[0]?.focus(), 50);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
    } catch (e: any) {
      verifyAttemptedRef.current = false;
      setError(e?.message || 'Verification failed. Please try again.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0 || isResending) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setIsResending(true);
    setError(null);
    setResendMsg('');
    try {
      await resendOtp(firebaseUser?.email || '');
      setCountdown(60);
      setResendMsg('New code sent to your email.');
    } catch {
      setError('Could not resend code. Please try again.');
    } finally {
      setIsResending(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={[StyleSheet.absoluteFill, { pointerEvents: 'none' } as any]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.6 }}
      />

      <View
        style={[
          styles.content,
          {
            paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 60),
            paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 40),
          },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <Text style={styles.iconEmoji}>📧</Text>
          </View>
          <Text style={styles.title}>Verify Your Email</Text>
          <Text style={styles.subtitle}>
            Enter the 6-digit code sent to{'\n'}
            <Text style={styles.emailText}>{firebaseUser?.email}</Text>
          </Text>
        </View>

        <View style={styles.otpContainer}>
          {otp.map((digit, idx) => (
            <TextInput
              key={idx}
              ref={(ref) => (inputRefs.current[idx] = ref)}
              style={[
                styles.otpInput,
                digit !== '' && styles.otpInputFilled,
                error !== null && styles.otpInputError,
              ]}
              value={digit}
              onChangeText={(val) => handleOtpChange(val.replace(/\D/g, ''), idx)}
              onKeyPress={(e) => handleKeyPress(e, idx)}
              keyboardType="number-pad"
              maxLength={6}
              selectTextOnFocus
              editable={!isVerifying}
              testID={`otp-input-${idx}`}
            />
          ))}
        </View>

        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : resendMsg ? (
          <Text style={styles.successText}>{resendMsg}</Text>
        ) : (
          <Text style={styles.hintText}>
            {isVerifying ? 'Verifying…' : 'Code expires in 10 minutes'}
          </Text>
        )}

        <View style={styles.footer}>
          {isVerifying ? (
            <ActivityIndicator color={Colors.gold} size="large" style={styles.loader} />
          ) : (
            <>
              <Pressable
                onPress={handleResend}
                disabled={countdown > 0 || isResending}
                style={({ pressed }) => [
                  styles.resendBtn,
                  (countdown > 0 || isResending) && styles.resendBtnDisabled,
                  pressed && styles.resendBtnPressed,
                ]}
                testID="btn-resend"
              >
                {isResending ? (
                  <ActivityIndicator color={Colors.textSecondary} size="small" />
                ) : (
                  <Text style={[styles.resendText, countdown > 0 && styles.resendTextMuted]}>
                    {countdown > 0
                      ? `Resend in 0:${countdown.toString().padStart(2, '0')}`
                      : 'Resend Code'}
                  </Text>
                )}
              </Pressable>

              <Pressable
                onPress={signOut}
                style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.7 }]}
                testID="btn-signout"
              >
                <Text style={styles.signOutText}>Use different email / Sign Out</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: 40 },
  iconCircle: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: Colors.darkCard, borderWidth: 1, borderColor: Colors.darkBorder,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  iconEmoji: { fontSize: 32 },
  title: {
    fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.textPrimary,
    textAlign: 'center', marginBottom: 10,
  },
  subtitle: {
    fontFamily: 'Inter_400Regular', fontSize: 15, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 22,
  },
  emailText: { fontFamily: 'Inter_600SemiBold', color: Colors.gold },
  otpContainer: {
    flexDirection: 'row', justifyContent: 'center',
    gap: 10, marginBottom: 16,
  },
  otpInput: {
    width: 46, height: 56,
    backgroundColor: Colors.darkCard,
    borderRadius: 12, borderWidth: 1.5, borderColor: Colors.darkBorder,
    color: Colors.textPrimary, fontSize: 22,
    fontFamily: 'Inter_700Bold', textAlign: 'center',
  },
  otpInputFilled: { borderColor: Colors.gold, backgroundColor: Colors.darkSurface },
  otpInputError: { borderColor: Colors.error },
  errorText: {
    color: Colors.error, fontFamily: 'Inter_500Medium',
    fontSize: 13, marginBottom: 20, textAlign: 'center',
  },
  successText: {
    color: Colors.neonOrange, fontFamily: 'Inter_500Medium',
    fontSize: 13, marginBottom: 20, textAlign: 'center',
  },
  hintText: {
    color: Colors.textMuted, fontFamily: 'Inter_400Regular',
    fontSize: 13, marginBottom: 20, textAlign: 'center',
  },
  footer: { alignItems: 'center', width: '100%', marginTop: 8 },
  loader: { marginVertical: 20 },
  resendBtn: {
    paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12,
    backgroundColor: Colors.darkSurface, borderWidth: 1, borderColor: Colors.darkBorder,
    marginBottom: 20, minWidth: 180, alignItems: 'center',
  },
  resendBtnDisabled: { opacity: 0.55 },
  resendBtnPressed: { backgroundColor: Colors.darkCard },
  resendText: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.gold },
  resendTextMuted: { color: Colors.textMuted },
  signOutBtn: { paddingVertical: 8 },
  signOutText: {
    fontFamily: 'Inter_500Medium', fontSize: 13,
    color: Colors.textMuted, textDecorationLine: 'underline',
  },
});
