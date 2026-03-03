import React, { useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming,
  withSequence, Easing, interpolate, FadeInDown,
} from 'react-native-reanimated';
import { useAuth } from '@/context/AuthContext';
import { useWallet } from '@/context/WalletContext';
import { useMining } from '@/context/MiningContext';
import Colors from '@/constants/colors';

const MINING_FEE_PT = 5;
const BOOSTERS = [
  { label: '2x', multiplier: 2, cost: 10, color: '#4CAF50' },
  { label: '4x', multiplier: 4, cost: 25, color: '#2196F3' },
  { label: '6x', multiplier: 6, cost: 50, color: Colors.neonOrange },
  { label: '10x', multiplier: 10, cost: 100, color: Colors.gold },
];

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatShib(val: number) {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(0)}K`;
  return val.toLocaleString();
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { powerTokens, shibBalance, addShib, spendPowerTokens } = useWallet();
  const { status, timeRemaining, progress, startMining, claimReward, shibReward, session } = useMining();

  const rotation = useSharedValue(0);
  const pulse = useSharedValue(1);
  const glowOpacity = useSharedValue(0.4);

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
        withSequence(withTiming(1.08, { duration: 600 }), withTiming(1, { duration: 600 })),
        -1, true
      );
      glowOpacity.value = withTiming(1, { duration: 400 });
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

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  async function handleStartMining(multiplier = 1, cost = MINING_FEE_PT) {
    if (powerTokens < cost) {
      Alert.alert('Insufficient Tokens', `You need ${cost} Power Tokens to start mining.`);
      return;
    }
    const spent = await spendPowerTokens(cost, `Mining fee${multiplier > 1 ? ` (${multiplier}x boost)` : ''}`, 'mining_fee');
    if (!spent) return;
    await startMining(multiplier);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
    Alert.alert(
      `${b.label} Speed Boost`,
      `Spend ${MINING_FEE_PT + b.cost} Power Tokens to mine at ${b.label} speed?\n\nReward: ${formatShib(shibReward * b.multiplier)} SHIB`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start', onPress: () => handleStartMining(b.multiplier, MINING_FEE_PT + b.cost) },
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
        contentInsetAdjustmentBehavior="automatic"
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
              <Text style={styles.balanceText}>{powerTokens} PT</Text>
            </View>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.miningCore}>
          <Animated.View style={[styles.outerGlow, glowStyle]} />
          <Animated.View style={[styles.rotatingRing, ringStyle]}>
            {[...Array(8)].map((_, i) => (
              <View
                key={i}
                style={[
                  styles.ringDot,
                  {
                    transform: [
                      { rotate: `${i * 45}deg` },
                      { translateX: 90 },
                    ],
                    backgroundColor: i % 2 === 0 ? Colors.gold : Colors.neonOrange,
                    opacity: status === 'idle' ? 0.3 : 1,
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
                  ? ['rgba(244,196,48,0.3)', 'rgba(255,107,0,0.2)']
                  : ['rgba(30,30,50,0.9)', 'rgba(20,20,35,0.9)']
              }
              style={styles.core}
            >
              <MaterialCommunityIcons
                name="pickaxe"
                size={48}
                color={status === 'ready_to_claim' ? '#000' : Colors.gold}
              />
              {status === 'mining' && (
                <Text style={styles.timerText}>{formatTime(timeRemaining)}</Text>
              )}
              {status === 'idle' && (
                <Text style={styles.coreLabel}>START</Text>
              )}
              {status === 'ready_to_claim' && (
                <Text style={[styles.coreLabel, { color: '#000', fontFamily: 'Inter_700Bold' }]}>CLAIM!</Text>
              )}
            </LinearGradient>
          </Animated.View>
        </Animated.View>

        {status === 'mining' && (
          <Animated.View entering={FadeInDown.delay(50).springify()} style={styles.progressSection}>
            <View style={styles.progressBar}>
              <Animated.View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(progress * 100)}%` as any },
                ]}
              />
            </View>
            <Text style={styles.progressLabel}>
              {Math.round(progress * 100)}% — Mining {formatShib(shibReward)} SHIB at {session?.multiplier ?? 1}x
            </Text>
          </Animated.View>
        )}

        {status === 'idle' && (
          <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.actionsArea}>
            <Pressable
              style={({ pressed }) => [styles.startBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={() => handleStartMining(1, MINING_FEE_PT)}
            >
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                style={styles.startGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
              >
                <MaterialCommunityIcons name="pickaxe" size={20} color="#000" />
                <Text style={styles.startText}>Start Mining</Text>
                <View style={styles.feeTag}>
                  <Text style={styles.feeText}>{MINING_FEE_PT} PT</Text>
                </View>
              </LinearGradient>
            </Pressable>
            <Text style={styles.rewardPreview}>
              Earns ~{formatShib(shibReward)} SHIB in 60 min
            </Text>
          </Animated.View>
        )}

        {status === 'ready_to_claim' && (
          <Animated.View entering={FadeInDown.delay(50).springify()} style={styles.actionsArea}>
            <Pressable
              style={({ pressed }) => [styles.startBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={handleClaim}
            >
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                style={styles.startGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
              >
                <Ionicons name="checkmark-circle" size={22} color="#000" />
                <Text style={styles.startText}>Claim {formatShib(shibReward)} SHIB</Text>
              </LinearGradient>
            </Pressable>
          </Animated.View>
        )}

        <Animated.View entering={FadeInDown.delay(400).springify()} style={styles.boostersSection}>
          <Text style={styles.sectionTitle}>Speed Boosters</Text>
          <View style={styles.boostersGrid}>
            {BOOSTERS.map((b) => (
              <Pressable
                key={b.label}
                style={({ pressed }) => [styles.boosterCard, { opacity: pressed ? 0.75 : 1, borderColor: b.color + '40' }]}
                onPress={() => handleBooster(b)}
                disabled={status === 'mining' || status === 'ready_to_claim'}
              >
                <Text style={[styles.boosterLabel, { color: b.color }]}>{b.label}</Text>
                <MaterialCommunityIcons name="lightning-bolt" size={18} color={b.color} />
                <Text style={styles.boosterCost}>{MINING_FEE_PT + b.cost} PT</Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(500).springify()} style={styles.statsRow}>
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="bitcoin" size={20} color={Colors.gold} />
            <Text style={styles.statValue}>{formatShib(shibBalance)}</Text>
            <Text style={styles.statLabel}>SHIB Balance</Text>
          </View>
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="lightning-bolt" size={20} color={Colors.neonOrange} />
            <Text style={styles.statValue}>{powerTokens}</Text>
            <Text style={styles.statLabel}>Power Tokens</Text>
          </View>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 120 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 32,
  },
  greeting: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary },
  userName: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary, marginTop: 2 },
  balanceBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(244,196,48,0.12)', borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 7,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.25)',
  },
  balanceText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  miningCore: {
    alignItems: 'center', justifyContent: 'center',
    height: 260, marginBottom: 16,
  },
  outerGlow: {
    position: 'absolute', width: 230, height: 230,
    borderRadius: 115, backgroundColor: Colors.gold,
    opacity: 0.15,
  },
  rotatingRing: {
    position: 'absolute', width: 200, height: 200,
    alignItems: 'center', justifyContent: 'center',
  },
  ringDot: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },
  coreContainer: {
    width: 150, height: 150, borderRadius: 75, overflow: 'hidden',
    borderWidth: 2, borderColor: 'rgba(244,196,48,0.4)',
  },
  core: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  timerText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: Colors.gold },
  coreLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textMuted },
  progressSection: { marginBottom: 16 },
  progressBar: {
    height: 6, backgroundColor: Colors.darkSurface,
    borderRadius: 3, overflow: 'hidden', marginBottom: 8,
  },
  progressFill: {
    height: '100%', borderRadius: 3,
    backgroundColor: Colors.gold,
  },
  progressLabel: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary, textAlign: 'center' },
  actionsArea: { alignItems: 'center', marginBottom: 24 },
  startBtn: { width: '100%' },
  startGradient: {
    height: 56, borderRadius: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  startText: { fontFamily: 'Inter_700Bold', fontSize: 17, color: '#000' },
  feeTag: {
    backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  feeText: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: '#000' },
  rewardPreview: {
    fontFamily: 'Inter_400Regular', fontSize: 12,
    color: Colors.textMuted, marginTop: 8,
  },
  boostersSection: { marginBottom: 24 },
  sectionTitle: {
    fontFamily: 'Inter_600SemiBold', fontSize: 13,
    color: Colors.textSecondary, textTransform: 'uppercase',
    letterSpacing: 1, marginBottom: 12,
  },
  boostersGrid: { flexDirection: 'row', gap: 10 },
  boosterCard: {
    flex: 1, backgroundColor: Colors.darkCard,
    borderRadius: 14, padding: 14, alignItems: 'center',
    gap: 4, borderWidth: 1,
  },
  boosterLabel: { fontFamily: 'Inter_700Bold', fontSize: 18 },
  boosterCost: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },
  statsRow: { flexDirection: 'row', gap: 12 },
  statCard: {
    flex: 1, backgroundColor: Colors.darkCard,
    borderRadius: 16, padding: 16, alignItems: 'center',
    gap: 6, borderWidth: 1, borderColor: Colors.darkBorder,
  },
  statValue: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },
  statLabel: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },
});
