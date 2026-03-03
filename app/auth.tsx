import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, Pressable,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

type Mode = 'signin' | 'signup';

export default function AuthScreen() {
  const insets = useSafeAreaInsets();
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit() {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Error', 'Please fill in all required fields.');
      return;
    }
    if (mode === 'signup') {
      if (!username.trim() || !displayName.trim()) {
        Alert.alert('Error', 'Please enter your username and display name.');
        return;
      }
      if (password !== confirmPassword) {
        Alert.alert('Error', 'Passwords do not match.');
        return;
      }
      if (password.length < 6) {
        Alert.alert('Error', 'Password must be at least 6 characters.');
        return;
      }
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsLoading(true);
    try {
      if (mode === 'signin') {
        const result = await signIn(email.trim(), password);
        if (result.needsVerification) {
          Alert.alert('Email Not Verified', 'Please check your email and verify your account before signing in.');
        }
      } else {
        await signUp(email.trim(), password, username.trim(), displayName.trim(), referralCode.trim() || undefined);
      }
    } catch (e: any) {
      const msg = e.code === 'auth/email-already-in-use'
        ? 'An account with this email already exists.'
        : e.code === 'auth/invalid-email'
        ? 'Please enter a valid email address.'
        : e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential'
        ? 'Incorrect email or password.'
        : e.code === 'auth/user-not-found'
        ? 'No account found with this email.'
        : e.message || 'Something went wrong.';
      Alert.alert('Error', msg);
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
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 40), paddingBottom: insets.bottom + 32 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View entering={FadeInDown.delay(100).springify()} style={styles.logoArea}>
            <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.logoCircle}>
              <MaterialCommunityIcons name="pickaxe" size={36} color="#000" />
            </LinearGradient>
            <Text style={styles.appName}>SHIB Mine</Text>
            <Text style={styles.tagline}>Mine. Earn. Grow.</Text>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.card}>
            <View style={styles.modeToggle}>
              {(['signin', 'signup'] as Mode[]).map((m) => (
                <Pressable key={m} style={[styles.modeBtn, mode === m && styles.modeBtnActive]} onPress={() => setMode(m)}>
                  <Text style={[styles.modeBtnText, mode === m && styles.modeBtnTextActive]}>
                    {m === 'signin' ? 'Sign In' : 'Sign Up'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {mode === 'signup' && (
              <>
                <InputField icon="person-outline" label="Username" value={username} onChangeText={setUsername} placeholder="@username" autoCapitalize="none" />
                <InputField icon="person-circle-outline" label="Display Name" value={displayName} onChangeText={setDisplayName} placeholder="Your name" autoCapitalize="words" />
              </>
            )}

            <InputField icon="mail-outline" label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" />

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
              <>
                <InputField icon="lock-closed-outline" label="Confirm Password" value={confirmPassword} onChangeText={setConfirmPassword} placeholder="••••••••" secureTextEntry={!showPassword} />
                <InputField icon="gift-outline" label="Referral Code (Optional)" value={referralCode} onChangeText={setReferralCode} placeholder="6-digit code" autoCapitalize="characters" maxLength={6} />
              </>
            )}

            <Pressable style={({ pressed }) => [styles.submitBtn, { opacity: pressed ? 0.85 : 1 }]} onPress={handleSubmit} disabled={isLoading}>
              <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.submitGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                {isLoading ? <ActivityIndicator color="#000" /> : (
                  <Text style={styles.submitText}>{mode === 'signin' ? 'Sign In' : 'Create Account'}</Text>
                )}
              </LinearGradient>
            </Pressable>

            {mode === 'signup' && (
              <Text style={styles.termsText}>
                A verification email will be sent to confirm your account. You receive 10 Power Tokens on your first login.
              </Text>
            )}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function InputField({ icon, label, value, onChangeText, placeholder, autoCapitalize, keyboardType, secureTextEntry, maxLength }: any) {
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
  submitBtn: { marginTop: 8 },
  submitGradient: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  termsText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, textAlign: 'center', marginTop: 14, lineHeight: 18 },
});
