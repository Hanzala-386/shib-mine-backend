import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Platform, ActivityIndicator, Alert, Modal,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { api, type VipStatusResult } from '@/lib/api';
import {
  MAX_VIP_LEVEL,
  VIP_REQUIREMENTS,
  vipIncrementPerHr,
  normalizeVipLevel,
  meetsVipRequirements,
  lockedBalanceForVipLevel,
  type VipMetrics,
} from '@shared/vip';
import Colors from '@/constants/colors';
import { InlineBannerAd } from '@/components/StickyBannerAd';

const REQ_META: { key: keyof VipMetrics; label: string; icon: string }[] = [
  { key: 'refs',        label: 'Referrals',     icon: 'account-multiple' },
  { key: 'refIncome',   label: 'Ref Income',    icon: 'cash-multiple' },
  { key: 'balance',     label: 'SHIB Balance',  icon: 'wallet' },
  { key: 'tasks',       label: 'Tasks Done',    icon: 'check-decagram' },
  { key: 'withdrawals', label: 'Withdrawals',   icon: 'bank-transfer-out' },
];

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + 'K';
  return String(Math.floor(n));
}

export default function VipScreen() {
  const insets = useSafeAreaInsets();
  const { user, refreshUser } = useAuth();
  const pbId = user?.pbId;
  const [upgrading, setUpgrading] = useState(false);
  const [showAgreement, setShowAgreement] = useState(false);

  const { data, isLoading, refetch } = useQuery<VipStatusResult>({
    queryKey: ['vip-status', pbId],
    queryFn: () => api.getVipStatus(pbId!),
    enabled: !!pbId,
  });

  const currentLevel   = data ? normalizeVipLevel(data.vipLevel) : (user?.vipLevel ?? 0);
  const metrics: VipMetrics = data?.metrics ?? { refs: 0, refIncome: 0, balance: 0, tasks: 0, withdrawals: 0 };
  const isAdminPromoted = data?.isAdminPromoted ?? user?.isAdminPromoted ?? false;

  const nextLevel  = currentLevel + 1;
  const canUpgrade = nextLevel <= MAX_VIP_LEVEL && meetsVipRequirements(nextLevel, metrics);
  const nextLockedBalance = lockedBalanceForVipLevel(nextLevel);

  const handleUpgrade = async () => {
    if (!pbId || upgrading || nextLevel > MAX_VIP_LEVEL) return;
    setUpgrading(true);
    try {
      const res = await api.vipUpgrade(pbId);
      if (res.success) {
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await Promise.all([refetch(), refreshUser()]);
        Alert.alert('VIP Upgraded! 🎉', `You are now VIP ${res.vipLevel}.`);
      } else {
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Requirements not met', res.error || 'You do not meet the requirements for the next level yet.');
        await refetch();
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not upgrade right now. Please try again.');
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.14)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 0.5 }}
      />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 8) }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>VIP Levels</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 24) + 24,
        }}
      >
        {/* Current status hero */}
        <Animated.View entering={FadeInDown.delay(80).springify()} style={styles.heroCard}>
          <LinearGradient
            colors={['rgba(244,196,48,0.2)', 'rgba(255,107,0,0.1)']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.heroInner}
          >
            <View style={styles.heroCrown}>
              <MaterialCommunityIcons name="crown" size={34} color={Colors.gold} />
            </View>
            <Text style={styles.heroLevel}>VIP {currentLevel}</Text>
            <Text style={styles.heroBonus}>
              {currentLevel > 0
                ? `+${fmt(vipIncrementPerHr(currentLevel))} SHIB / hour bonus`
                : 'No mining bonus yet'}
            </Text>
            {isAdminPromoted && (
              <View style={styles.promotedPill}>
                <Ionicons name="shield-checkmark" size={12} color="#1a1200" />
                <Text style={styles.promotedText}>Admin Promoted</Text>
              </View>
            )}
          </LinearGradient>
        </Animated.View>

        {/* Explanation */}
        <Text style={styles.explain}>
          VIP adds a SHIB-per-hour bonus on top of the base mining rate. Upgrade one level at a
          time by meeting all of its requirements.
        </Text>

        {isLoading && (
          <View style={{ paddingVertical: 30 }}>
            <ActivityIndicator color={Colors.gold} />
          </View>
        )}

        {/* Level cards */}
        {Array.from({ length: MAX_VIP_LEVEL }, (_, i) => i + 1).map((lvl) => {
          const req      = VIP_REQUIREMENTS[lvl];
          const achieved = currentLevel >= lvl;
          const isNext   = lvl === nextLevel;
          return (
            <React.Fragment key={lvl}>
            <Animated.View
              entering={FadeInDown.delay(120 + lvl * 30).springify()}
              style={[
                styles.levelCard,
                achieved && styles.levelCardAchieved,
                isNext && styles.levelCardNext,
              ]}
            >
              <View style={styles.levelHeader}>
                <View style={[styles.levelBadge, achieved && styles.levelBadgeAchieved]}>
                  <MaterialCommunityIcons name="crown" size={15} color={achieved ? '#1a1200' : Colors.gold} />
                  <Text style={[styles.levelBadgeText, achieved && { color: '#1a1200' }]}>{lvl}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.levelTitle}>VIP Level {lvl}</Text>
                  <Text style={styles.levelBonus}>+{fmt(vipIncrementPerHr(lvl))} SHIB / hr</Text>
                </View>
                {achieved && <Ionicons name="checkmark-circle" size={20} color={Colors.success} />}
              </View>

              {/* Requirements grid */}
              <View style={styles.reqGrid}>
                {REQ_META.map(({ key, label, icon }) => {
                  const need = (req as any)[key] as number;
                  if (!need) return null;
                  const have = (metrics as any)[key] as number;
                  const ok   = have >= need;
                  return (
                    <View key={key} style={styles.reqItem}>
                      <MaterialCommunityIcons
                        name={icon as any}
                        size={13}
                        color={ok ? Colors.success : Colors.textMuted}
                      />
                      <Text style={[styles.reqText, ok && { color: Colors.success }]}>
                        {label}: {fmt(have)}/{fmt(need)}
                      </Text>
                    </View>
                  );
                })}
              </View>

              {isNext && (
                <Pressable
                  onPress={() => setShowAgreement(true)}
                  disabled={!canUpgrade || upgrading}
                  style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1, marginTop: 12 }]}
                >
                  <LinearGradient
                    colors={canUpgrade ? [Colors.gold, Colors.neonOrange] : ['#2A2A3F', '#1A1A28']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.upgradeBtn}
                  >
                    {upgrading ? (
                      <ActivityIndicator color="#1a1200" size="small" />
                    ) : (
                      <Text style={[styles.upgradeBtnText, !canUpgrade && { color: Colors.textMuted }]}>
                        {canUpgrade ? `Upgrade to VIP ${lvl}` : 'Requirements not met'}
                      </Text>
                    )}
                  </LinearGradient>
                </Pressable>
              )}
            </Animated.View>
            {/* Banner ad after every 2nd VIP tier card (no trailing banner). */}
            {lvl % 2 === 0 && lvl < MAX_VIP_LEVEL && <InlineBannerAd />}
            </React.Fragment>
          );
        })}
      </ScrollView>

      {/* ══ VIP LOCK-IN AGREEMENT — non-cancelable ════════════════════════ */}
      <Modal
        visible={showAgreement}
        transparent
        animationType="fade"
        onRequestClose={() => { /* non-cancelable: hardware back does nothing */ }}
      >
        <View style={styles.agreeOverlay}>
          <View style={styles.agreeCard}>
            <View style={styles.agreeIconWrap}>
              <MaterialCommunityIcons name="lock-check" size={30} color={Colors.gold} />
            </View>
            <Text style={styles.agreeTitle}>VIP Lock-In Agreement</Text>
            <Text style={styles.agreeBody}>
              By activating VIP {nextLevel}, you agree that{' '}
              <Text style={styles.agreeStrong}>{fmt(nextLockedBalance)} SHIB</Text> — the required
              balance for this VIP tier — will be locked in your wallet and cannot be withdrawn for
              as long as you hold this tier.
              {'\n\n'}
              Only your available balance (total balance minus the locked amount) can be withdrawn.
              To remove your VIP tier and unlock these funds, you must contact{' '}
              <Text style={styles.agreeStrong}>support@shibahit.com</Text>.
              {'\n\n'}
              This action cannot be undone from within the app.
            </Text>
            <Pressable
              onPress={() => { setShowAgreement(false); handleUpgrade(); }}
              disabled={upgrading}
              style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1, width: '100%' }]}
            >
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={styles.agreeAgreeBtn}
              >
                {upgrading ? (
                  <ActivityIndicator color="#1a1200" size="small" />
                ) : (
                  <Text style={styles.agreeAgreeText}>I Agree, Activate VIP</Text>
                )}
              </LinearGradient>
            </Pressable>
            <Pressable
              onPress={() => setShowAgreement(false)}
              disabled={upgrading}
              style={({ pressed }) => [styles.agreeCancelBtn, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={styles.agreeCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 12 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },

  heroCard: { borderRadius: 22, overflow: 'hidden', marginTop: 4, marginBottom: 16 },
  heroInner: {
    alignItems: 'center', paddingVertical: 24, paddingHorizontal: 20,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.35)', borderRadius: 22,
  },
  heroCrown: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(244,196,48,0.15)', marginBottom: 10,
  },
  heroLevel: { fontFamily: 'Inter_700Bold', fontSize: 30, color: Colors.gold },
  heroBonus: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textSecondary, marginTop: 4 },
  promotedPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Colors.gold, borderRadius: 12,
    paddingVertical: 4, paddingHorizontal: 10, marginTop: 12,
  },
  promotedText: { fontFamily: 'Inter_700Bold', fontSize: 11, color: '#1a1200' },

  explain: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, lineHeight: 19, marginBottom: 16 },

  levelCard: {
    borderRadius: 18, padding: 16, marginBottom: 12,
    backgroundColor: Colors.darkCard,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  levelCardAchieved: { borderColor: Colors.success + '55', backgroundColor: 'rgba(0,230,118,0.05)' },
  levelCardNext: { borderColor: 'rgba(244,196,48,0.5)' },

  levelHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  levelBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingVertical: 5, paddingHorizontal: 9, borderRadius: 12,
    backgroundColor: 'rgba(244,196,48,0.15)',
  },
  levelBadgeAchieved: { backgroundColor: Colors.gold },
  levelBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.gold },
  levelTitle: { fontFamily: 'Inter_700Bold', fontSize: 15, color: Colors.textPrimary },
  levelBonus: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.neonOrange, marginTop: 1 },

  reqGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  reqItem: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Colors.darkSurface, borderRadius: 10,
    paddingVertical: 6, paddingHorizontal: 10,
  },
  reqText: { fontFamily: 'Inter_500Medium', fontSize: 11, color: Colors.textMuted },

  upgradeBtn: { paddingVertical: 13, alignItems: 'center', borderRadius: 12 },
  upgradeBtnText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#1a1200' },

  agreeOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  agreeCard: {
    width: '100%', maxWidth: 380, borderRadius: 22, padding: 22, alignItems: 'center',
    backgroundColor: Colors.darkCard, borderWidth: 1, borderColor: 'rgba(244,196,48,0.4)',
  },
  agreeIconWrap: {
    width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(244,196,48,0.15)', marginBottom: 14,
  },
  agreeTitle: { fontFamily: 'Inter_700Bold', fontSize: 20, color: Colors.gold, textAlign: 'center', marginBottom: 12 },
  agreeBody: { fontFamily: 'Inter_400Regular', fontSize: 13.5, lineHeight: 21, color: Colors.textSecondary, textAlign: 'left', marginBottom: 20 },
  agreeStrong: { fontFamily: 'Inter_700Bold', color: Colors.gold },
  agreeAgreeBtn: { paddingVertical: 14, alignItems: 'center', borderRadius: 12, width: '100%' },
  agreeAgreeText: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#1a1200' },
  agreeCancelBtn: { paddingVertical: 13, alignItems: 'center', width: '100%', marginTop: 4 },
  agreeCancelText: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textMuted },
});
