import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Share, ScrollView, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import Colors from '@/constants/colors';

export default function InviteScreen() {
  const insets = useSafeAreaInsets();
  const { user, pbUser } = useAuth();
  const [copied, setCopied] = useState(false);

  const referralCode = user?.referralCode ?? '------';
  const pbId = pbUser?.pbId ?? '';

  const { data: stats } = useQuery({
    queryKey: ['/api/app/user/referral-stats', pbId],
    queryFn: () => api.getReferralStats(pbId),
    enabled: !!pbId,
    staleTime: 30_000,
  });

  const referredCount = stats?.referredCount ?? 0;
  const totalEarnings = stats?.totalEarnings ?? 0;

  async function copyCode() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Clipboard.setStringAsync(referralCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function shareCode() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await Share.share({
        message: `Join me on Shiba Hit and earn crypto by mining! Use my referral code: ${referralCode}\n\nDownload now and start earning SHIB tokens! 🚀`,
        title: 'Join Shiba Hit',
      });
    } catch (e) {
      console.error('Share error', e);
    }
  }

  const steps = [
    { icon: 'share-social', title: 'Share Your Code', desc: 'Send your referral code to friends via WhatsApp, Telegram, or any app.' },
    { icon: 'person-add', title: 'Friend Signs Up', desc: 'Your friend creates an account and enters your referral code. You get 30 PT instantly.' },
    { icon: 'flash', title: 'Earn Commission', desc: 'You automatically earn 10% bonus on every SHIB claim and game reward your friend makes.' },
  ];

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16), paddingBottom: 120 }]}
      >
        <Animated.View entering={FadeInDown.delay(100).springify()}>
          <Text style={styles.pageTitle}>Invite & Earn</Text>
          <Text style={styles.pageSubtitle}>Get 30 PT instantly per referral + 10% lifetime commission</Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.codeCard}>
          <LinearGradient
            colors={['rgba(244,196,48,0.15)', 'rgba(255,107,0,0.1)']}
            style={styles.codeCardGradient}
          >
            <Text style={styles.codeLabel}>Your Referral Code</Text>
            <View style={styles.codeRow}>
              {referralCode.split('').map((char, i) => (
                <View key={i} style={styles.codeChar}>
                  <Text style={styles.codeCharText}>{char}</Text>
                </View>
              ))}
            </View>
            <View style={styles.codeActions}>
              <Pressable
                style={({ pressed }) => [styles.codeBtn, { opacity: pressed ? 0.8 : 1 }]}
                onPress={copyCode}
              >
                <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={18} color={Colors.gold} />
                <Text style={styles.codeBtnText}>{copied ? 'Copied!' : 'Copy'}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.shareBtn, { opacity: pressed ? 0.8 : 1 }]}
                onPress={shareCode}
              >
                <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.shareBtnGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                  <Ionicons name="share-social" size={18} color="#000" />
                  <Text style={styles.shareBtnText}>Share</Text>
                </LinearGradient>
              </Pressable>
            </View>
          </LinearGradient>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.statsRow}>
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="account-group" size={22} color={Colors.neonOrange} />
            <Text style={styles.statValue}>{referredCount}</Text>
            <Text style={styles.statLabel}>Friends Referred</Text>
          </View>
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="bitcoin" size={22} color={Colors.gold} />
            <Text style={styles.statValue}>{totalEarnings.toFixed(totalEarnings < 10 ? 2 : 0)}</Text>
            <Text style={styles.statLabel}>SHIB Earned</Text>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(400).springify()}>
          <Text style={styles.sectionTitle}>How It Works</Text>
          <View style={styles.stepsList}>
            {steps.map((step, i) => (
              <View key={i} style={styles.stepItem}>
                <View style={styles.stepIconWrap}>
                  <LinearGradient colors={[Colors.gold + '30', Colors.neonOrange + '20']} style={styles.stepIconBg}>
                    <Ionicons name={step.icon as any} size={22} color={Colors.gold} />
                  </LinearGradient>
                  {i < steps.length - 1 && <View style={styles.stepConnector} />}
                </View>
                <View style={styles.stepContent}>
                  <Text style={styles.stepTitle}>{step.title}</Text>
                  <Text style={styles.stepDesc}>{step.desc}</Text>
                </View>
              </View>
            ))}
          </View>
        </Animated.View>

        {user?.referredBy && (
          <Animated.View entering={FadeInDown.delay(500).springify()} style={styles.referredBanner}>
            <Ionicons name="gift" size={20} color={Colors.gold} />
            <Text style={styles.referredText}>You were referred — you got <Text style={{ color: Colors.gold }}>30 PT</Text> at signup!</Text>
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 20 },
  pageTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.textPrimary, marginBottom: 6 },
  pageSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary, marginBottom: 28, lineHeight: 20 },
  codeCard: { borderRadius: 24, overflow: 'hidden', marginBottom: 20, borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)' },
  codeCardGradient: { padding: 24, alignItems: 'center', gap: 16 },
  codeLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1 },
  codeRow: { flexDirection: 'row', gap: 8 },
  codeChar: {
    width: 42, height: 52, borderRadius: 10,
    backgroundColor: Colors.darkCard,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  codeCharText: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.gold },
  codeActions: { flexDirection: 'row', gap: 12, width: '100%' },
  codeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.darkCard, borderRadius: 12, height: 46,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  codeBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.gold },
  shareBtn: { flex: 1 },
  shareBtnGradient: {
    flex: 1, height: 46, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  shareBtnText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#000' },
  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 28 },
  statCard: {
    flex: 1, backgroundColor: Colors.darkCard, borderRadius: 16,
    padding: 16, alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  statValue: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary },
  statLabel: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, textAlign: 'center' },
  sectionTitle: {
    fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16,
  },
  stepsList: { gap: 0 },
  stepItem: { flexDirection: 'row', gap: 16, marginBottom: 0 },
  stepIconWrap: { alignItems: 'center', width: 44 },
  stepIconBg: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  stepConnector: { width: 2, flex: 1, minHeight: 16, backgroundColor: Colors.darkBorder, marginVertical: 4 },
  stepContent: { flex: 1, paddingBottom: 20, paddingTop: 10 },
  stepTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 15, color: Colors.textPrimary, marginBottom: 4 },
  stepDesc: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, lineHeight: 19 },
  referredBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(244,196,48,0.08)', borderRadius: 14,
    padding: 14, marginTop: 8,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.2)',
  },
  referredText: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textSecondary, flex: 1 },
});
