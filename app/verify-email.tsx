import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

export default function VerifyEmailScreen() {
  const insets = useSafeAreaInsets();
  const { firebaseUser, signOut, resendVerificationEmail, checkVerificationStatus } = useAuth();

  const [isSending, setIsSending] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  const startCooldown = () => {
    setResendCooldown(60);
    const interval = setInterval(() => {
      setResendCooldown((c) => {
        if (c <= 1) { clearInterval(interval); return 0; }
        return c - 1;
      });
    }, 1000);
  };

  const handleResend = async () => {
    if (isSending || resendCooldown > 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setIsSending(true);
    setStatusMsg('');
    setErrorMsg('');
    try {
      await resendVerificationEmail();
      setStatusMsg('Verification email sent! Check your inbox (and spam folder).');
      startCooldown();
    } catch (e: any) {
      const msg = e?.code === 'auth/too-many-requests'
        ? 'Too many requests. Please wait a moment before trying again.'
        : 'Could not send email. Please try again.';
      setErrorMsg(msg);
    } finally {
      setIsSending(false);
    }
  };

  const handleCheckVerified = async () => {
    if (isChecking) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setIsChecking(true);
    setStatusMsg('');
    setErrorMsg('');
    try {
      const result = await checkVerificationStatus();
      if (!result.verified) {
        setErrorMsg("Your email hasn't been verified yet. Please click the link in the email we sent.");
      }
      // If verified, checkVerificationStatus navigates to /(tabs) automatically
    } catch {
      setErrorMsg('Could not check status. Please try again.');
    } finally {
      setIsChecking(false);
    }
  };

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 60);
  const botPad = insets.bottom + (Platform.OS === 'web' ? 34 : 40);

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={[StyleSheet.absoluteFill, { pointerEvents: 'none' } as any]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.6 }}
      />

      <View style={[styles.content, { paddingTop: topPad, paddingBottom: botPad }]}>

        <View style={styles.iconCircle}>
          <Ionicons name="mail-open-outline" size={40} color={Colors.gold} />
        </View>

        <Text style={styles.title}>Check Your Email</Text>

        <Text style={styles.subtitle}>
          We sent a verification link to{'\n'}
          <Text style={styles.emailText}>{firebaseUser?.email}</Text>
        </Text>

        <View style={styles.stepsCard}>
          <StepRow number="1" text="Open the email from SHIB Mine" />
          <StepRow number="2" text="Click the verification link" />
          <StepRow number="3" text={"Tap \"I've verified\" below"} />
        </View>

        {statusMsg !== '' && (
          <View style={styles.successBox}>
            <Ionicons name="checkmark-circle-outline" size={16} color="#00c864" />
            <Text style={styles.successText}>{statusMsg}</Text>
          </View>
        )}

        {errorMsg !== '' && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={Colors.error} />
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        )}

        {/* Primary CTA — check if verified */}
        <Pressable
          style={({ pressed }) => [
            styles.primaryBtn,
            { opacity: isChecking ? 0.7 : pressed ? 0.85 : 1 },
          ]}
          onPress={handleCheckVerified}
          disabled={isChecking}
          testID="btn-check-verified"
        >
          <LinearGradient
            colors={[Colors.gold, Colors.neonOrange]}
            style={styles.primaryGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
          >
            {isChecking ? (
              <ActivityIndicator color="#000" />
            ) : (
              <>
                <Ionicons name="checkmark-circle-outline" size={20} color="#000" />
                <Text style={styles.primaryBtnText}>I've verified my email</Text>
              </>
            )}
          </LinearGradient>
        </Pressable>

        {/* Resend */}
        <Pressable
          style={({ pressed }) => [
            styles.secondaryBtn,
            (isSending || resendCooldown > 0) && styles.secondaryBtnDisabled,
            pressed && styles.secondaryBtnPressed,
          ]}
          onPress={handleResend}
          disabled={isSending || resendCooldown > 0}
          testID="btn-resend"
        >
          {isSending ? (
            <ActivityIndicator color={Colors.gold} size="small" />
          ) : (
            <Text style={styles.secondaryBtnText}>
              {resendCooldown > 0
                ? `Resend in 0:${resendCooldown.toString().padStart(2, '0')}`
                : 'Resend verification email'}
            </Text>
          )}
        </Pressable>

        {/* Sign out */}
        <Pressable
          onPress={signOut}
          style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.6 }]}
          testID="btn-signout"
        >
          <Text style={styles.signOutText}>Use a different email / Sign Out</Text>
        </Pressable>

      </View>
    </View>
  );
}

function StepRow({ number, text }: { number: string; text: string }) {
  return (
    <View style={stepStyles.row}>
      <View style={stepStyles.badge}>
        <Text style={stepStyles.badgeText}>{number}</Text>
      </View>
      <Text style={stepStyles.text}>{text}</Text>
    </View>
  );
}

const stepStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  badge: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Colors.gold, alignItems: 'center', justifyContent: 'center',
    marginRight: 12,
  },
  badgeText: { fontFamily: 'Inter_700Bold', fontSize: 12, color: '#000' },
  text: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary, flex: 1 },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1, paddingHorizontal: 24,
    alignItems: 'center', justifyContent: 'center',
  },
  iconCircle: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Colors.darkCard, borderWidth: 1, borderColor: Colors.darkBorder,
    alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  title: {
    fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.textPrimary,
    textAlign: 'center', marginBottom: 12,
  },
  subtitle: {
    fontFamily: 'Inter_400Regular', fontSize: 15, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 22, marginBottom: 28,
  },
  emailText: { fontFamily: 'Inter_600SemiBold', color: Colors.gold },
  stepsCard: {
    width: '100%', backgroundColor: Colors.darkCard,
    borderRadius: 16, padding: 20, marginBottom: 24,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  successBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(0,200,100,0.1)', borderRadius: 10, padding: 12,
    marginBottom: 16, width: '100%',
    borderWidth: 1, borderColor: 'rgba(0,200,100,0.3)',
  },
  successText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, color: '#00c864', lineHeight: 18 },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(255,68,68,0.1)', borderRadius: 10, padding: 12,
    marginBottom: 16, width: '100%',
    borderWidth: 1, borderColor: 'rgba(255,68,68,0.3)',
  },
  errorText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.error, lineHeight: 18 },
  primaryBtn: { width: '100%', marginBottom: 14 },
  primaryGradient: {
    height: 54, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  primaryBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  secondaryBtn: {
    width: '100%', height: 50, borderRadius: 14,
    backgroundColor: Colors.darkSurface, borderWidth: 1, borderColor: Colors.darkBorder,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  secondaryBtnDisabled: { opacity: 0.55 },
  secondaryBtnPressed: { backgroundColor: Colors.darkCard },
  secondaryBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.gold },
  signOutBtn: { paddingVertical: 8 },
  signOutText: {
    fontFamily: 'Inter_500Medium', fontSize: 13,
    color: Colors.textMuted, textDecorationLine: 'underline',
  },
});
