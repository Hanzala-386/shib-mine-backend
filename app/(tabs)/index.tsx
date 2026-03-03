import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Alert, Platform,
  Animated as RNAnimated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming,
  withSequence, Easing, FadeInDown,
} from 'react-native-reanimated';
import { useAuth } from '@/context/AuthContext';
import { useWallet } from '@/context/WalletContext';
import { useMining } from '@/context/MiningContext';
import { useAdmin } from '@/context/AdminContext';
import { adService } from '@/lib/AdService';
import Colors from '@/constants/colors';

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatShib(val: number) {
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return val.toLocaleString();
}

function useRollingNumber(target: number, duration = 600) {
  const [displayed, setDisplayed] = useState(target);
  const animVal = useRef(new RNAnimated.Value(target)).current;

  useEffect(() => {
    RNAnimated.timing(animVal, {
      toValue: target,
      duration,
      useNativeDriver: false,
    }).start();
    const listener = animVal.addListener(({ value }) => {
      setDisplayed(Math.round(value));
    });
    return () => animVal.removeListener(listener);
  }, [target]);

  return displayed;
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { powerTokens, shibBalance, addShib, spendPowerTokens } = useWallet();
  const { status, timeRemaining, progress, startMining, claimReward, shibReward, session, baseMiningRate, displayedShibBalance } = useMining();
  const { settings } = useAdmin();
  const [showAdLoader, setShowAdLoader] = useState(false);

  const displayedPT = useRollingNumber(powerTokens, 400);

  const liveBalance = status === 'mining'
    ? shibBalance + displayedShibBalance
    : shibBalance;
  const displayedShibFinal = useRollingNumber(liveBalance, status === 'mining' ? 100 : 800);

  const rotation = useSharedValue(0);
  const pulse = useSharedValue(1);
  const glowOpacity = useSharedValue(0.4);

  const BOOSTERS = [
    { label: '2x', multiplier: 2, cost: settings.boosterCosts['2x'], color: '#4CAF50' },
    { label: '4x', multiplier: 4, cost: settings.boosterCosts['4x'], color: '#2196F3' },
    { label: '6x', multiplier: 6, cost: settings.boosterCosts['6x'], color: Colors.neonOrange },
    { label: '10x', multiplier: 10, cost: settings.boosterCosts['10x'], color: Colors.gold },
  ];

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 8000, easing: Easing.linear }),
      -1, false
    );
  }, []);

  useEffect(() => {
    if (status === 'mining') {
      pulse.value = withRepeat(
        withSequence(withTiming(1.05, { duration: 1000 }), withTiming(1, { duration: 1000 })),
        -1, true
      );
      glowOpacity.value = withRepeat(
        withSequence(withTiming(0.8, { duration: 1500 }), withTiming(0.3, { duration: 1500 })),
        -1, true
      );
    } else if (status === 'ready_to_claim') {
      pulse.value = withRepeat(
        withSequence(withTiming(1.1, { duration: 500 }), withTiming(1, { duration: 500 })),
        -1, true
      );
      glowOpacity.value = withTiming(1, { duration: 300 });
    } else {
      pulse.value = withTiming(1, { duration: 300 });
      glowOpacity.value = withTiming(0.4, { duration: 300 });
    }
  }, [status]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  const coreStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glowOpacity.value }));

  async function handleStartMining(multiplier = 1, boosterCost = 0) {
    const totalCost = settings.miningEntryFee + boosterCost;
    if (powerTokens < totalCost) {
      Alert.alert('Insufficient Tokens', `You need ${totalCost} Power Tokens to start mining.`);
      return;
    }
    const spent = await spendPowerTokens(totalCost, `Mining fee${multiplier > 1 ? ` (${multiplier}x)` : ''}`, 'mining_fee');
    if (!spent) return;

    setShowAdLoader(true);
    await adService.showUnityInterstitial(
      async () => {
        setShowAdLoader(false);
        await startMining(multiplier, settings.baseMiningRate);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      },
      () => setShowAdLoader(false),
    );
  }

  async function handleClaim() {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const reward = await claimReward();
    if (reward > 0) {
      await addShib(reward, 'Mining session reward');
      Alert.alert('Reward Claimed!', `You earned ${formatShib(reward)} SHIB!`);
    }
  }

  async function handleBooster(b: typeof BOOSTERS[0]) {
    const totalCost = settings.miningEntryFee + b.cost;
    Alert.alert(
      `${b.label} Speed Boost`,
      `Spend ${totalCost} Power Tokens to mine at ${b.label} speed?\n\nReward: ${formatShib(shibReward * b.multiplier)} SHIB`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start', onPress: () => handleStartMining(b.multiplier, b.cost) },
      ]
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.15)', 'rgba(255,107,0,0.1)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16) }]}
      >
        <Animated.View entering={FadeInDown.delay(100).springify()}>
          <View style={styles.header}>
            <View>
              <Text style={styles.greeting}>Welcome back,</Text>
              <Text style={styles.userName}>{user?.displayName ?? 'Miner'}</Text>
            </View>
            <View style={styles.balanceBadge}>
              <MaterialCommunityIcons name="lightning-bolt" size={14} color={Colors.gold} />
              <Text style={styles.balanceText}>{displayedPT} PT</Text>
            </View>
          </View>
        </Animated.View>

        {status === 'mining' && (
          <Animated.View entering={FadeInDown.delay(50).springify()} style={styles.liveBalanceCard}>
            <LinearGradient
              colors={['rgba(244,196,48,0.1)', 'rgba(255,107,0,0.05)']}
              style={styles.liveBalanceInner}
            >
              <Text style={styles.liveLabel}>Mining in progress — Live Balance</Text>
              <Text style={styles.liveValue}>{formatShib(displayedShibFinal)} SHIB</Text>
            </LinearGradient>
          </Animated.View>
        )}

        <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.miningCore}>
          <Animated.View style={[styles.outerGlow, glowStyle]} />
          <Animated.View style={[styles.rotatingRing, ringStyle]}>
            {[...Array(12)].map((_, i) => (
              <View
                key={i}
                style={[
                  styles.ringDot,
                  {
                    transform: [{ rotate: `${i * 30}deg` }, { translateX: 100 }],
                    backgroundColor: i % 3 === 0 ? Colors.gold : i % 3 === 1 ? Colors.neonOrange : 'rgba(244,196,48,0.3)',
                    opacity: status === 'idle' ? 0.2 : 1,
                    width: i % 3 === 0 ? 9 : 6,
                    height: i % 3 === 0 ? 9 : 6,
                    borderRadius: 5,
                  },
                ]}
              />
            ))}
          </Animated.View>
          <Animated.View style={[styles.coreContainer, coreStyle]}>
            <LinearGradient
              colors={
                status === 'ready_to_claim'
                  ? [Colors.gold, Colors.neonOrange]
                  : status === 'mining'
                  ? ['rgba(244,196,48,0.25)', 'rgba(255,107,0,0.15)']
                  : ['rgba(26,26,40,0.95)', 'rgba(18,18,26,0.95)']
              }
              style={styles.core}
            >
              <MaterialCommunityIcons
                name="pickaxe"
                size={44}
                color={status === 'ready_to_claim' ? '#000' : Colors.gold}
              />
              {status === 'mining' && (
                <Text style={styles.timerText}>{formatTime(timeRemaining)}</Text>
              )}
              {status === 'idle' && (
                <Text style={styles.coreLabelMuted}>IDLE</Text>
              )}
              {status === 'ready_to_claim' && (
                <Text style={[styles.coreLabel, { color: '#000' }]}>CLAIM!</Text>
              )}
            </LinearGradient>
          </Animated.View>
        </Animated.View>

        {status === 'mining' && (
          <Animated.View entering={FadeInDown.delay(50).springify()} style={styles.progressSection}>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` as any }]} />
            </View>
            <Text style={styles.progressLabel}>
              {Math.round(progress * 100)}% — {session?.multiplier ?? 1}x speed — {formatShib(shibReward)} SHIB
            </Text>
          </Animated.View>
        )}

        {status === 'idle' && (
          <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.actionsArea}>
            <Pressable
              style={({ pressed }) => [styles.actionBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={() => handleStartMining()}
              disabled={showAdLoader}
            >
              <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.actionGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                <MaterialCommunityIcons name="pickaxe" size={20} color="#000" />
                <Text style={styles.actionText}>{showAdLoader ? 'Loading Ad...' : 'Start Mining'}</Text>
                <View style={styles.feeTag}>
                  <Text style={styles.feeText}>{settings.miningEntryFee} PT</Text>
                </View>
              </LinearGradient>
            </Pressable>
            <Text style={styles.rewardPreview}>Earns ~{formatShib(shibReward)} SHIB in 60 min</Text>
          </Animated.View>
        )}

        {status === 'ready_to_claim' && (
          <Animated.View entering={FadeInDown.delay(50).springify()} style={styles.actionsArea}>
            <Pressable style={({ pressed }) => [styles.actionBtn, { opacity: pressed ? 0.85 : 1 }]} onPress={handleClaim}>
              <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.actionGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                <Ionicons name="checkmark-circle" size={22} color="#000" />
                <Text style={styles.actionText}>Claim {formatShib(shibReward)} SHIB</Text>
              </LinearGradient>
            </Pressable>
          </Animated.View>
        )}

        <Animated.View entering={FadeInDown.delay(350).springify()} style={styles.boostersSection}>
          <Text style={styles.sectionTitle}>Speed Boosters</Text>
          <View style={styles.boostersGrid}>
            {BOOSTERS.map((b) => (
              <Pressable
                key={b.label}
                style={({ pressed }) => [
                  styles.boosterCard,
                  { opacity: (pressed || status !== 'idle') ? 0.6 : 1, borderColor: b.color + '35' },
                ]}
                onPress={() => handleBooster(b)}
                disabled={status !== 'idle'}
              >
                <Text style={[styles.boosterLabel, { color: b.color }]}>{b.label}</Text>
                <MaterialCommunityIcons name="lightning-bolt" size={16} color={b.color} />
                <Text style={styles.boosterCost}>{settings.miningEntryFee + b.cost} PT</Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(450).springify()} style={styles.statsRow}>
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="bitcoin" size={20} color={Colors.gold} />
            <Text style={styles.statValue}>{formatShib(displayedShibFinal)}</Text>
            <Text style={styles.statLabel}>SHIB Balance</Text>
          </View>
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="lightning-bolt" size={20} color={Colors.neonOrange} />
            <Text style={styles.statValue}>{displayedPT}</Text>
            <Text style={styles.statLabel}>Power Tokens</Text>
          </View>
        </Animated.View>

        <View style={styles.adBanner}>
          <LinearGradient colors={['rgba(255,107,0,0.08)', 'rgba(244,196,48,0.05)']} style={styles.adBannerInner}>
            <Ionicons name="tv-outline" size={14} color={Colors.textMuted} />
            <Text style={styles.adBannerText}>AdMob Banner Ad</Text>
          </LinearGradient>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 120 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  greeting: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary },
  userName: { fontFamily: 'Inter_700Bold', fontSize: 21, color: Colors.textPrimary, marginTop: 2 },
  balanceBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(244,196,48,0.12)', borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 7,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.25)',
  },
  balanceText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  liveBalanceCard: { marginBottom: 12, borderRadius: 14, overflow: 'hidden' },
  liveBalanceInner: {
    padding: 14, alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.2)', borderRadius: 14,
  },
  liveLabel: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, marginBottom: 4 },
  liveValue: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.gold },
  miningCore: { alignItems: 'center', justifyContent: 'center', height: 270, marginBottom: 16 },
  outerGlow: { position: 'absolute', width: 240, height: 240, borderRadius: 120, backgroundColor: Colors.gold, opacity: 0.12 },
  rotatingRing: { position: 'absolute', width: 220, height: 220, alignItems: 'center', justifyContent: 'center' },
  ringDot: { position: 'absolute' },
  coreContainer: { width: 155, height: 155, borderRadius: 78, overflow: 'hidden', borderWidth: 2, borderColor: 'rgba(244,196,48,0.35)' },
  core: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  timerText: { fontFamily: 'Inter_700Bold', fontSize: 17, color: Colors.gold },
  coreLabel: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  coreLabelMuted: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textMuted },
  progressSection: { marginBottom: 16 },
  progressBar: { height: 6, backgroundColor: Colors.darkSurface, borderRadius: 3, overflow: 'hidden', marginBottom: 7 },
  progressFill: { height: '100%', borderRadius: 3, backgroundColor: Colors.gold },
  progressLabel: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary, textAlign: 'center' },
  actionsArea: { alignItems: 'center', marginBottom: 22 },
  actionBtn: { width: '100%' },
  actionGradient: { height: 56, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  actionText: { fontFamily: 'Inter_700Bold', fontSize: 17, color: '#000' },
  feeTag: { backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  feeText: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: '#000' },
  rewardPreview: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, marginTop: 8 },
  boostersSection: { marginBottom: 22 },
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  boostersGrid: { flexDirection: 'row', gap: 10 },
  boosterCard: { flex: 1, backgroundColor: Colors.darkCard, borderRadius: 14, padding: 12, alignItems: 'center', gap: 4, borderWidth: 1 },
  boosterLabel: { fontFamily: 'Inter_700Bold', fontSize: 17 },
  boosterCost: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted },
  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: Colors.darkCard, borderRadius: 16, padding: 16, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: Colors.darkBorder },
  statValue: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },
  statLabel: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },
  adBanner: { borderRadius: 10, overflow: 'hidden' },
  adBannerInner: { height: 50, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, borderWidth: 1, borderColor: Colors.darkBorder, borderRadius: 10 },
  adBannerText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
});
