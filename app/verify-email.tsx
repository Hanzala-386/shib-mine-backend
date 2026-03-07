import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, ActivityIndicator, TextInput, Keyboard } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, useSharedValue, useAnimatedStyle, withSequence, withTiming, withRepeat } from 'react-native-reanimated';
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
  
  const inputRefs = useRef<Array<TextInput | null>>([]);
  const shakeOffset = useSharedValue(0);

  // Auto-send OTP on mount (handles app restart where user is in unverified state)
  useEffect(() => {
    if (firebaseUser?.email) {
      resendOtp(firebaseUser.email).catch(() => {});
    }
  }, []);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (countdown > 0) {
      timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    }
    return () => clearTimeout(timer);
  }, [countdown]);

  const animatedShakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeOffset.value }],
  }));

  const triggerShake = () => {
    shakeOffset.value = withSequence(
      withTiming(-10, { duration: 50 }),
      withRepeat(withTiming(10, { duration: 50 }), 3, true),
      withTiming(0, { duration: 50 })
    );
  };

  const handleOtpChange = (value: string, index: number) => {
    setError(null);
    const newOtp = [...otp];
    
    // Handle paste or multiple characters
    if (value.length > 1) {
      const chars = value.slice(0, 6).split('');
      chars.forEach((char, i) => {
        if (index + i < 6) newOtp[index + i] = char;
      });
      setOtp(newOtp);
      const nextIdx = Math.min(index + chars.length, 5);
      inputRefs.current[nextIdx]?.focus();
      if (newOtp.every(digit => digit !== '')) {
        submitOtp(newOtp.join(''));
      }
      return;
    }

    newOtp[index] = value;
    setOtp(newOtp);

    if (value !== '' && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    if (newOtp.every(digit => digit !== '')) {
      submitOtp(newOtp.join(''));
    }
  };

  const handleKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === 'Backspace' && otp[index] === '' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const submitOtp = async (code: string) => {
    if (isVerifying) return;
    setIsVerifying(true);
    setError(null);
    try {
      const result = await verifyOtp(firebaseUser?.email || '', code);
      if (!result.success) {
        setError(result.error || 'Invalid code');
        triggerShake();
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (e: any) {
      setError(e.message || 'Verification failed');
      triggerShake();
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0 || isResending) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsResending(true);
    setError(null);
    try {
      await resendOtp(firebaseUser?.email || '');
      setCountdown(60);
      Alert.alert('Sent!', 'A new verification code has been sent to your email.');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not resend code.');
    } finally {
      setIsResending(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.6 }}
      />
      <View style={[styles.content, { paddingTop: insets.top + 60, paddingBottom: insets.bottom + 40 }]}>
        <Animated.View entering={FadeInDown.delay(100).springify()} style={styles.header}>
          <Text style={styles.title}>Enter Verification Code</Text>
          <Text style={styles.subtitle}>
            We sent a 6-digit code to:{"\n"}
            <Text style={styles.email}>{firebaseUser?.email}</Text>
          </Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(200).springify()} style={[styles.otpContainer, animatedShakeStyle]}>
          {otp.map((digit, idx) => (
            <TextInput
              key={idx}
              ref={(ref) => (inputRefs.current[idx] = ref)}
              style={[
                styles.otpInput,
                digit !== '' && styles.otpInputFilled,
                error !== null && styles.otpInputError
              ]}
              value={digit}
              onChangeText={(val) => handleOtpChange(val, idx)}
              onKeyPress={(e) => handleKeyPress(e, idx)}
              keyboardType="number-pad"
              maxLength={6}
              selectTextOnFocus
              editable={!isVerifying}
            />
          ))}
        </Animated.View>

        {error && (
          <Animated.Text entering={FadeInDown} style={styles.errorText}>
            {error}
          </Animated.Text>
        )}

        <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.footer}>
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
                  pressed && styles.resendBtnPressed
                ]}
              >
                {isResending ? (
                  <ActivityIndicator color={Colors.textSecondary} size="small" />
                ) : (
                  <Text style={[styles.resendText, countdown > 0 && styles.resendTextMuted]}>
                    {countdown > 0 ? `Resend code in 0:${countdown.toString().padStart(2, '0')}` : 'Resend Code'}
                  </Text>
                )}
              </Pressable>

              <Pressable
                onPress={signOut}
                style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.signOutText}>Change email / Sign Out</Text>
              </Pressable>
            </>
          )}
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 24, alignItems: 'center' },
  header: { alignItems: 'center', marginBottom: 40 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 24, color: Colors.textPrimary, textAlign: 'center', marginBottom: 12 },
  subtitle: { fontFamily: 'Inter_400Regular', fontSize: 15, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  email: { fontFamily: 'Inter_600SemiBold', color: Colors.gold },
  otpContainer: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginBottom: 20 },
  otpInput: {
    width: 45,
    height: 55,
    backgroundColor: Colors.darkCard,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.darkBorder,
    color: Colors.textPrimary,
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
  },
  otpInputFilled: {
    borderColor: Colors.gold,
    backgroundColor: Colors.darkSurface,
  },
  otpInputError: {
    borderColor: Colors.error,
  },
  errorText: {
    color: Colors.error,
    fontFamily: 'Inter_500Medium',
    fontSize: 14,
    marginBottom: 20,
    textAlign: 'center',
  },
  footer: { alignItems: 'center', width: '100%', marginTop: 20 },
  loader: { marginVertical: 20 },
  resendBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    backgroundColor: Colors.darkSurface,
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    marginBottom: 24,
    minWidth: 180,
    alignItems: 'center',
  },
  resendBtnDisabled: {
    opacity: 0.6,
  },
  resendBtnPressed: {
    backgroundColor: Colors.darkCard,
  },
  resendText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
    color: Colors.gold,
  },
  resendTextMuted: {
    color: Colors.textMuted,
  },
  signOutBtn: {
    paddingVertical: 8,
  },
  signOutText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 14,
    color: Colors.textMuted,
    textDecorationLine: 'underline',
  },
});
