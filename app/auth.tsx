import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, StyleSheet, Pressable,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

type Mode = 'signin' | 'signup';

export default function AuthScreen() {
  const insets = useSafeAreaInsets();
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit() {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Error', 'Please fill in all required fields.');
      return;
    }
    if (mode === 'signup' && !displayName.trim()) {
      Alert.alert('Error', 'Please enter your display name.');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsLoading(true);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        await signUp(email.trim(), password, displayName.trim(), referralCode.trim() || undefined);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Something went wrong.');
    } finally {
      setIsLoading(false);
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
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 32 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View entering={FadeInDown.delay(100).springify()} style={styles.logoArea}>
            <LinearGradient
              colors={[Colors.gold, Colors.neonOrange]}
              style={styles.logoCircle}
            >
              <MaterialCommunityIcons name="pickaxe" size={36} color="#000" />
            </LinearGradient>
            <Text style={styles.appName}>SHIB Mine</Text>
            <Text style={styles.tagline}>Mine. Earn. Grow.</Text>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.card}>
            <View style={styles.modeToggle}>
              <Pressable
                style={[styles.modeBtn, mode === 'signin' && styles.modeBtnActive]}
                onPress={() => setMode('signin')}
              >
                <Text style={[styles.modeBtnText, mode === 'signin' && styles.modeBtnTextActive]}>Sign In</Text>
              </Pressable>
              <Pressable
                style={[styles.modeBtn, mode === 'signup' && styles.modeBtnActive]}
                onPress={() => setMode('signup')}
              >
                <Text style={[styles.modeBtnText, mode === 'signup' && styles.modeBtnTextActive]}>Sign Up</Text>
              </Pressable>
            </View>

            {mode === 'signup' && (
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Display Name</Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="person-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    value={displayName}
                    onChangeText={setDisplayName}
                    placeholder="Your name"
                    placeholderTextColor={Colors.textMuted}
                    autoCapitalize="words"
                  />
                </View>
              </View>
            )}

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="mail-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={Colors.textMuted}
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  placeholderTextColor={Colors.textMuted}
                  secureTextEntry={!showPassword}
                />
                <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
                  <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color={Colors.textMuted} />
                </Pressable>
              </View>
            </View>

            {mode === 'signup' && (
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Referral Code <Text style={styles.optional}>(Optional)</Text></Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="gift-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    value={referralCode}
                    onChangeText={setReferralCode}
                    placeholder="Enter 6-digit code"
                    placeholderTextColor={Colors.textMuted}
                    autoCapitalize="characters"
                    maxLength={6}
                  />
                </View>
              </View>
            )}

            <Pressable
              style={({ pressed }) => [styles.submitBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={handleSubmit}
              disabled={isLoading}
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
                  <Text style={styles.submitText}>{mode === 'signin' ? 'Sign In' : 'Create Account'}</Text>
                )}
              </LinearGradient>
            </Pressable>

            {mode === 'signup' && (
              <Text style={styles.termsText}>
                By signing up, you receive 10 Power Tokens to start mining.
              </Text>
            )}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 24 },
  logoArea: { alignItems: 'center', marginBottom: 36 },
  logoCircle: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  appName: {
    fontFamily: 'Inter_700Bold', fontSize: 32,
    color: Colors.gold, letterSpacing: 1,
  },
  tagline: {
    fontFamily: 'Inter_400Regular', fontSize: 15,
    color: Colors.textSecondary, marginTop: 4,
  },
  card: {
    backgroundColor: Colors.darkCard,
    borderRadius: 24, padding: 24,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  modeToggle: {
    flexDirection: 'row', backgroundColor: Colors.darkSurface,
    borderRadius: 12, padding: 4, marginBottom: 24,
  },
  modeBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  modeBtnActive: { backgroundColor: Colors.darkCard, borderWidth: 1, borderColor: Colors.darkBorder },
  modeBtnText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },
  modeBtnTextActive: { color: Colors.gold },
  inputGroup: { marginBottom: 16 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.darkSurface, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.darkBorder,
    paddingHorizontal: 14, height: 52,
  },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 15, color: Colors.textPrimary },
  eyeBtn: { padding: 4 },
  optional: { fontFamily: 'Inter_400Regular', color: Colors.textMuted, textTransform: 'none' },
  submitBtn: { marginTop: 8 },
  submitGradient: {
    height: 52, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  submitText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  termsText: {
    fontFamily: 'Inter_400Regular', fontSize: 12,
    color: Colors.textMuted, textAlign: 'center', marginTop: 16, lineHeight: 18,
  },
});
