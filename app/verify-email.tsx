import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

export default function VerifyEmailScreen() {
  const insets = useSafeAreaInsets();
  const { firebaseUser, signOut, resendVerification, refreshUser } = useAuth();
  const [isChecking, setIsChecking] = useState(false);
  const [isResending, setIsResending] = useState(false);

  async function handleCheck() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsChecking(true);
    try {
      await refreshUser();
    } finally {
      setIsChecking(false);
    }
  }

  async function handleResend() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsResending(true);
    try {
      await resendVerification();
      Alert.alert('Sent!', 'A new verification email has been sent. Check your inbox and spam folder.');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not send verification email.');
    } finally {
      setIsResending(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.6 }}
      />
      <View style={[styles.content, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40 }]}>
        <Animated.View entering={FadeInDown.delay(100).springify()} style={styles.iconWrap}>
          <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.iconCircle}>
            <Ionicons name="mail" size={40} color="#000" />
          </LinearGradient>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.textArea}>
          <Text style={styles.title}>Verify Your Email</Text>
          <Text style={styles.subtitle}>
            We sent a verification link to:
          </Text>
          <Text style={styles.email}>{firebaseUser?.email}</Text>
          <Text style={styles.instructions}>
            Open the link in your email to activate your account. Check your spam folder if you don't see it.
          </Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.actions}>
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, { opacity: pressed ? 0.85 : 1 }]}
            onPress={handleCheck}
            disabled={isChecking}
          >
            <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.btnGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
              {isChecking ? <ActivityIndicator color="#000" /> : (
                <>
                  <Ionicons name="refresh" size={18} color="#000" />
                  <Text style={styles.primaryBtnText}>I've Verified My Email</Text>
                </>
              )}
            </LinearGradient>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, { opacity: pressed ? 0.7 : 1 }]}
            onPress={handleResend}
            disabled={isResending}
          >
            {isResending ? <ActivityIndicator color={Colors.textSecondary} /> : (
              <>
                <Ionicons name="send-outline" size={16} color={Colors.textSecondary} />
                <Text style={styles.secondaryBtnText}>Resend Verification Email</Text>
              </>
            )}
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.signOutBtn, { opacity: pressed ? 0.7 : 1 }]}
            onPress={signOut}
          >
            <Text style={styles.signOutText}>Back to Sign In</Text>
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 28, justifyContent: 'center', gap: 32 },
  iconWrap: { alignItems: 'center' },
  iconCircle: { width: 90, height: 90, borderRadius: 45, alignItems: 'center', justifyContent: 'center' },
  textArea: { alignItems: 'center', gap: 10 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.textPrimary, textAlign: 'center' },
  subtitle: { fontFamily: 'Inter_400Regular', fontSize: 15, color: Colors.textSecondary, textAlign: 'center' },
  email: { fontFamily: 'Inter_600SemiBold', fontSize: 15, color: Colors.gold, textAlign: 'center' },
  instructions: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center', lineHeight: 20, marginTop: 4 },
  actions: { gap: 14 },
  primaryBtn: {},
  btnGradient: { height: 54, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  primaryBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 50, borderRadius: 14, backgroundColor: Colors.darkCard,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  secondaryBtnText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textSecondary },
  signOutBtn: { alignItems: 'center', paddingVertical: 12 },
  signOutText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },
});
