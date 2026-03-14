import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Alert, Platform,
  Animated as RNAnimated, ActivityIndicator, Modal,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming,
  withSequence, Easing, FadeInDown, FadeIn,
} from 'react-native-reanimated';
import { useAuth } from '@/context/AuthContext';
import { useWallet } from '@/context/WalletContext';
import { useMining } from '@/context/MiningContext';
import { useAdmin } from '@/context/AdminContext';
import { adService } from '@/lib/AdService';
import Colors from '@/constants/colors';

// ── Pure helpers ───────────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  if (!ms || !isFinite(ms) || ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatShib(val: number): string {
  const v = isFinite(val) ? val : 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function useRollingNumber(target: number, duration = 600): number {
  const safeTarget = isFinite(target) ? target : 0;
  const [displayed, setDisplayed] = useState(safeTarget);
  const animVal = useRef(new RNAnimated.Value(safeTarget)).current;
  useEffect(() => {
    const t = isFinite(target) ? target : 0;
    RNAnimated.timing(animVal, { toValue: t, duration, useNativeDriver: false }).start();
    const id = animVal.addListener(({ value }) => setDisplayed(isFinite(value) ? value : 0));
    return () => animVal.removeListener(id);
  }, [target]);
  return displayed;
}

// ── Booster data ───────────────────────────────────────────────────────────────

const BOOSTER_COLORS: Record<string, string> = {
  '2x': '#4CAF50',
  '4x': '#2196F3',
  '6x': '#FF6B00',
  '10x': '#F4C430',
};

// ── Home screen ────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, pbUser } = useAuth();
  const { powerTokens, shibBalance } = useWallet();
  const {
    status, timeRemaining, progress, startMining, claimReward,
    shibReward, session, displayedShibBalance,
    miningEntryCost, activeBooster, activateBooster, startMiningWithBooster, isClaiming,
  } = useMining();
  const { settings } = useAdmin();

  const [showAdLoader, setShowAdLoader] = useState(false);
  const [showLowPtWarning, setShowLowPtWarning] = useState(false);

  // Booster modal state
  type BoosterItem = { label: string; multiplier: number; cost: number; color: string };
  const [selectedBooster, setSelectedBooster] = useState<BoosterItem | null>(null);

  // 1-second clock for booster countdown
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Zero-NaN safe values ─────────────────────────────────────────────────
  const safePT           = (typeof powerTokens === 'number' && isFinite(powerTokens)) ? powerTokens : 0;
  const safeShib         = (typeof shibBalance === 'number' && isFinite(shibBalance)) ? shibBalance : 0;
  const safeDisplayed    = (typeof displayedShibBalance === 'number' && isFinite(displayedShibBalance)) ? displayedShibBalance : 0;
  const safeMultiplier   = (session && typeof session.multiplier === 'number' && isFinite(session.multiplier)) ? session.multiplier : 1;
  const safeProgress     = (typeof progress === 'number' && isFinite(progress)) ? Math.min(1, Math.max(0, progress)) : 0;
  const safeShibReward   = (typeof shibReward === 'number' && isFinite(shibReward)) ? shibReward : 0;
  const safeTimeRemaining = (typeof timeRemaining === 'number' && isFinite(timeRemaining)) ? Math.max(0, timeRemaining) : 0;

  const liveBalance = status === 'mining' ? safeShib + safeDisplayed : safeShib;

  const displayedPT       = useRollingNumber(safePT, 400);
  const displayedShibFinal = useRollingNumber(liveBalance, status === 'mining' ? 100 : 800);

  // Animations
  const rotation   = useSharedValue(0);
  const pulse      = useSharedValue(1);
  const glowOpacity = useSharedValue(0.4);

  const boostCosts = settings?.boostCosts ?? { '2x': 200, '4x': 400, '6x': 600, '10x': 800 };
  const BOOSTERS: BoosterItem[] = [
    { label: '2x',  multiplier: 2,  cost: boostCosts['2x'],  color: BOOSTER_COLORS['2x'] },
    { label: '4x',  multiplier: 4,  cost: boostCosts['4x'],  color: BOOSTER_COLORS['4x'] },
    { label: '6x',  multiplier: 6,  cost: boostCosts['6x'],  color: BOOSTER_COLORS['6x'] },
    { label: '10x', multiplier: 10, cost: boostCosts['10x'], color: BOOSTER_COLORS['10x'] },
  ];

  useEffect(() => {
    rotation.value = withRepeat(withTiming(360, { duration: 8000, easing: Easing.linear }), -1, false);
  }, []);

  useEffect(() => {
    if (status === 'mining') {
      pulse.value = withRepeat(
        withSequence(withTiming(1.05, { duration: 1000 }), withTiming(1, { duration: 1000 })),
        -1, true,
      );
      glowOpacity.value = withRepeat(
        withSequence(withTiming(0.8, { duration: 1500 }), withTiming(0.3, { duration: 1500 })),
        -1, true,
      );
    } else if (status === 'ready_to_claim') {
      pulse.value = withRepeat(
        withSequence(withTiming(1.1, { duration: 500 }), withTiming(1, { duration: 500 })),
        -1, true,
      );
      glowOpacity.value = withTiming(1, { duration: 300 });
    } else {
      pulse.value = withTiming(1, { duration: 300 });
      glowOpacity.value = withTiming(0.4, { duration: 300 });
    }
  }, [status]);

  const ringStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  const coreStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glowOpacity.value }));

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function withAd(action: () => Promise<{ success: boolean; error?: string }>) {
    setShowAdLoader(true);
    await adService.showUnityInterstitial(
      async () => {
        setShowAdLoader(false);
        const result = await action();
        if (result.success) {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          Alert.alert('Cannot Start Mining', result.error || 'Failed to start mining.');
        }
      },
      () => setShowAdLoader(false),
    );
  }

  async function handleStartMining() {
    if (!pbUser) { Alert.alert('Not Ready', 'Account sync in progress. Please wait.'); return; }
    if (safePT < miningEntryCost) { setShowLowPtWarning(true); return; }
    setShowLowPtWarning(false);
    await withAd(startMining);
  }

  async function handleClaim() {
    if (isClaiming) return;
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const reward = await claimReward();
    if (reward > 0) Alert.alert('Reward Claimed! 🎉', `You earned ${formatShib(reward)} SHIB!`);
  }

  // Open the glassmorphism booster modal
  function handleBoosterTap(b: BoosterItem) {
    setSelectedBooster(b);
  }

  // Called from modal when user confirms START MINING
  async function handleBoosterConfirm(b: BoosterItem) {
    setSelectedBooster(null);
    const isMining = status === 'mining';
    if (isMining) {
      const res = await activateBooster(b.multiplier);
      if (!res.success) Alert.alert('Error', res.error || 'Failed to activate booster.');
      else await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setShowLowPtWarning(false);
      await withAd(() => startMiningWithBooster(b.multiplier));
    }
  }

  // ── Booster Modal ──────────────────────────────────────────────────────────

  function BoosterModal() {
    if (!selectedBooster) return null;
    const b = selectedBooster;
    const isMining = status === 'mining';
    const totalCost = isMining ? b.cost : b.cost + miningEntryCost;
    const canAfford = safePT >= totalCost;
    const isActive = !!(activeBooster && activeBooster.multiplier === b.multiplier && activeBooster.expiresAt > now);

    return (
      <Modal transparent animationType="fade" visible onRequestClose={() => setSelectedBooster(null)}>
        <Pressable style={modal.backdrop} onPress={() => setSelectedBooster(null)}>
          <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
        </Pressable>

        <Animated.View entering={FadeIn.duration(180)} style={modal.sheet}>
          <LinearGradient
            colors={['rgba(26,26,40,0.97)', 'rgba(18,18,30,0.99)']}
            style={modal.card}
          >
            {/* Close button */}
            <Pressable style={modal.closeBtn} onPress={() => setSelectedBooster(null)}>
              <Ionicons name="close" size={20} color={Colors.textMuted} />
            </Pressable>

            {/* Booster badge */}
            <View style={[modal.badge, { borderColor: b.color + '60', backgroundColor: b.color + '18' }]}>
              <Text style={[modal.badgeText, { color: b.color }]}>{b.label}</Text>
              <Text style={[modal.badgeSub, { color: b.color + 'CC' }]}>SPEED BOOST</Text>
            </View>

            {/* Title */}
            <Text style={modal.title}>
              {isMining ? `Upgrade to ${b.label} Booster` : `Start Mining at ${b.label} Speed`}
            </Text>

            {/* Cost breakdown */}
            <View style={[modal.costBox, { borderColor: canAfford ? b.color + '40' : 'rgba(255,80,80,0.3)' }]}>
              <View style={modal.costRow}>
                <Text style={modal.costLabel}>
                  <MaterialCommunityIcons name="lightning-bolt" size={13} color={b.color} /> Booster
                </Text>
                <Text style={[modal.costVal, { color: b.color }]}>{b.cost} PT</Text>
              </View>
              {!isMining && (
                <View style={modal.costRow}>
                  <Text style={modal.costLabel}>
                    <MaterialCommunityIcons name="pickaxe" size={13} color={Colors.textSecondary} /> Mining entry
                  </Text>
                  <Text style={modal.costVal}>{miningEntryCost} PT</Text>
                </View>
              )}
              <View style={[modal.costDivider, { backgroundColor: canAfford ? b.color + '30' : 'rgba(255,80,80,0.2)' }]} />
              <View style={modal.costRow}>
                <Text style={[modal.costLabel, { color: Colors.textPrimary }]}>Total cost</Text>
                <Text style={[modal.costVal, { color: canAfford ? Colors.textPrimary : '#FF5050', fontFamily: 'Inter_700Bold' }]}>
                  {totalCost} PT
                </Text>
              </View>
              <View style={modal.costRow}>
                <Text style={modal.costLabel}>Your balance</Text>
                <Text style={[modal.costVal, { color: safePT >= totalCost ? Colors.gold : '#FF5050' }]}>
                  {Math.floor(safePT)} PT
                </Text>
              </View>
            </View>

            {/* Action area */}
            {canAfford ? (
              <>
                {isActive && (
                  <Text style={modal.renewNote}>
                    Renewing will reset your current {b.label} booster timer to +1 hour.
                  </Text>
                )}
                <Pressable
                  style={({ pressed }) => [modal.startBtn, { opacity: pressed ? 0.85 : 1 }]}
                  onPress={() => handleBoosterConfirm(b)}
                >
                  <LinearGradient
                    colors={[b.color, b.color + 'BB']}
                    style={modal.startBtnInner}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  >
                    <MaterialCommunityIcons name="pickaxe" size={20} color="#000" />
                    <Text style={modal.startBtnText}>
                      {isMining ? 'Activate Booster' : 'Start Mining'}
                    </Text>
                  </LinearGradient>
                </Pressable>
              </>
            ) : (
              <>
                <View style={modal.insufficientBox}>
                  <Ionicons name="warning-outline" size={22} color="#FF5050" />
                  <Text style={modal.insufficientText}>Insufficient Power Tokens</Text>
                  <Text style={modal.insufficientSub}>
                    You need {totalCost - Math.floor(safePT)} more PT to activate this booster.
                  </Text>
                </View>
                <Pressable
                  style={({ pressed }) => [modal.gamesBtn, { opacity: pressed ? 0.85 : 1 }]}
                  onPress={() => { setSelectedBooster(null); router.push('/(tabs)/games'); }}
                >
                  <LinearGradient
                    colors={[Colors.neonOrange, Colors.gold]}
                    style={modal.startBtnInner}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  >
                    <Ionicons name="game-controller-outline" size={20} color="#000" />
                    <Text style={modal.startBtnText}>Play Games to Earn PT</Text>
                  </LinearGradient>
                </Pressable>
              </>
            )}

            <Pressable onPress={() => setSelectedBooster(null)} style={modal.cancelBtn}>
              <Text style={modal.cancelText}>Cancel</Text>
            </Pressable>
          </LinearGradient>
        </Animated.View>
      </Modal>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.15)', 'rgba(255,107,0,0.1)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />

      <BoosterModal />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16) }]}
      >
        {/* Header */}
        <Animated.View entering={FadeInDown.delay(100).springify()}>
          <View style={styles.header}>
            <View>
              <Text style={styles.greeting}>Welcome back,</Text>
              <Text style={styles.userName}>{user?.displayName ?? 'Miner'}</Text>
            </View>
            <View style={styles.balanceBadge}>
              <MaterialCommunityIcons name="lightning-bolt" size={14} color={Colors.gold} />
              <Text style={styles.balanceText}>{Math.floor(displayedPT)} PT</Text>
            </View>
          </View>
        </Animated.View>

        {/* Live balance card — only while mining */}
        {status === 'mining' && (
          <Animated.View entering={FadeInDown.delay(50).springify()} style={styles.liveBalanceCard}>
            <LinearGradient
              colors={['rgba(244,196,48,0.1)', 'rgba(255,107,0,0.05)']}
              style={styles.liveBalanceInner}
            >
              <Text style={styles.liveLabel}>Mining in progress — Live Balance</Text>
              <Text style={styles.liveValue}>{formatShib(displayedShibFinal)} SHIB</Text>
              {activeBooster && activeBooster.expiresAt > now && (
                <Text style={styles.liveBoostLabel}>
                  {activeBooster.multiplier}x booster · {formatTime(activeBooster.expiresAt - now).substring(3)} left
                </Text>
              )}
            </LinearGradient>
          </Animated.View>
        )}

        {/* Mining Core */}
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
                    backgroundColor:
                      i % 3 === 0 ? Colors.gold
                      : i % 3 === 1 ? Colors.neonOrange
                      : 'rgba(244,196,48,0.3)',
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
                <Text style={styles.timerText}>{formatTime(safeTimeRemaining)}</Text>
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

        {/* Progress bar — only while mining */}
        {status === 'mining' && (
          <Animated.View entering={FadeInDown.delay(50).springify()} style={styles.progressSection}>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${Math.round(safeProgress * 100)}%` as any }]} />
            </View>
            <Text style={styles.progressLabel}>
              {Math.round(safeProgress * 100)}% · {safeMultiplier}x speed · ~{formatShib(safeShibReward)} SHIB
            </Text>
          </Animated.View>
        )}

        {/* ── IDLE: Start Mining button ─────────────────────────────────── */}
        {status === 'idle' && (
          <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.actionsArea}>
            {showLowPtWarning && (
              <Animated.View entering={FadeInDown.springify()} style={styles.warningCard}>
                <View style={styles.warningHeader}>
                  <MaterialCommunityIcons name="lightning-bolt" size={18} color={Colors.neonOrange} />
                  <Text style={styles.warningTitle}>Not enough Power Tokens!</Text>
                </View>
                <Text style={styles.warningText}>Play games to win free PT and start mining.</Text>
                <Pressable
                  style={({ pressed }) => [styles.warningBtn, { opacity: pressed ? 0.8 : 1 }]}
                  onPress={() => router.push('/(tabs)/games')}
                >
                  <Text style={styles.warningBtnText}>Play Games →</Text>
                </Pressable>
              </Animated.View>
            )}
            <Pressable
              style={({ pressed }) => [styles.actionBtn, { opacity: (pressed || showAdLoader) ? 0.85 : 1 }]}
              onPress={handleStartMining}
              disabled={showAdLoader}
            >
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                style={styles.actionGradient}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              >
                <MaterialCommunityIcons name="pickaxe" size={20} color="#000" />
                <Text style={styles.actionText}>{showAdLoader ? 'Loading…' : 'Start Mining'}</Text>
                <View style={styles.feeTag}>
                  <MaterialCommunityIcons name="lightning-bolt" size={12} color="#000" />
                  <Text style={styles.feeText}>{miningEntryCost} PT</Text>
                </View>
              </LinearGradient>
            </Pressable>
            <Text style={styles.rewardPreview}>
              Earns ~{formatShib(safeShibReward)} SHIB in {settings?.miningDurationMinutes ?? 60} min
            </Text>
          </Animated.View>
        )}

        {/* ── READY TO CLAIM ───────────────────────────────────────────── */}
        {status === 'ready_to_claim' && (
          <Animated.View entering={FadeInDown.delay(50).springify()} style={styles.actionsArea}>
            <Pressable
              style={({ pressed }) => [styles.actionBtn, { opacity: (pressed || isClaiming) ? 0.6 : 1 }]}
              onPress={handleClaim}
              disabled={isClaiming}
            >
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                style={styles.actionGradient}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              >
                {isClaiming
                  ? <ActivityIndicator size="small" color="#000" />
                  : <Ionicons name="checkmark-circle" size={22} color="#000" />}
                <Text style={styles.actionText}>
                  {isClaiming ? 'Claiming…' : `Claim ~${formatShib(safeShibReward)} SHIB`}
                </Text>
              </LinearGradient>
            </Pressable>
            <Text style={styles.rewardPreview}>Mining complete — tap to collect your SHIB</Text>
          </Animated.View>
        )}

        {/* ── Speed Boosters (idle or mining, NOT ready_to_claim) ───────── */}
        {status !== 'ready_to_claim' && (
          <Animated.View entering={FadeInDown.delay(350).springify()} style={styles.boostersSection}>
            <Text style={styles.sectionTitle}>
              {status === 'idle' ? 'Activate a Booster to Start Mining' : 'Speed Boosters'}
            </Text>
            <View style={styles.boostersGrid}>
              {BOOSTERS.map((b) => {
                const isActive = !!(activeBooster && activeBooster.multiplier === b.multiplier && activeBooster.expiresAt > now);
                const anyActive = !!(activeBooster && activeBooster.expiresAt > now);
                const timeLeft = isActive ? Math.max(0, activeBooster!.expiresAt - now) : 0;

                return (
                  <Pressable
                    key={b.label}
                    style={({ pressed }) => [
                      styles.boosterCard,
                      {
                        opacity: pressed ? 0.7 : 1,
                        borderColor: isActive ? b.color : anyActive ? Colors.darkBorder : b.color + '35',
                        backgroundColor: isActive ? b.color + '15' : Colors.darkCard,
                      },
                    ]}
                    onPress={() => handleBoosterTap(b)}
                    disabled={showAdLoader}
                  >
                    <Text style={[styles.boosterLabel, { color: b.color }]}>{b.label}</Text>
                    {isActive ? (
                      <Text style={[styles.boosterTimer, { color: b.color }]}>
                        {formatTime(timeLeft).substring(3)}
                      </Text>
                    ) : (
                      <>
                        <MaterialCommunityIcons name="lightning-bolt" size={16} color={b.color} />
                        <Text style={styles.boosterCost}>{b.cost} PT</Text>
                      </>
                    )}
                  </Pressable>
                );
              })}
            </View>
            {status === 'idle' && (
              <Text style={styles.boosterHint}>Tap a booster to open its activation panel</Text>
            )}
          </Animated.View>
        )}

        {/* Stats row */}
        <Animated.View entering={FadeInDown.delay(450).springify()} style={styles.statsRow}>
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="bitcoin" size={20} color={Colors.gold} />
            <Text style={styles.statValue}>{formatShib(displayedShibFinal)}</Text>
            <Text style={styles.statLabel}>SHIB Balance</Text>
          </View>
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="lightning-bolt" size={20} color={Colors.neonOrange} />
            <Text style={styles.statValue}>{Math.floor(displayedPT)}</Text>
            <Text style={styles.statLabel}>Power Tokens</Text>
          </View>
        </Animated.View>

        {/* Ad banner placeholder */}
        <View style={styles.adBanner}>
          <LinearGradient
            colors={['rgba(255,107,0,0.08)', 'rgba(244,196,48,0.05)']}
            style={styles.adBannerInner}
          >
            <Ionicons name="tv-outline" size={14} color={Colors.textMuted} />
            <Text style={styles.adBannerText}>AdMob Banner Ad</Text>
          </LinearGradient>
        </View>
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

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
  liveBoostLabel: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.neonOrange, marginTop: 4 },
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
  feeTag: { backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', gap: 2 },
  feeText: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: '#000' },
  warningCard: {
    backgroundColor: 'rgba(255,107,0,0.1)', borderRadius: 16, padding: 16, width: '100%',
    marginBottom: 16, borderWidth: 1, borderColor: 'rgba(255,107,0,0.3)', alignItems: 'center',
  },
  warningHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  warningTitle: { fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.neonOrange },
  warningText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary, textAlign: 'center', marginBottom: 12 },
  warningBtn: { backgroundColor: Colors.neonOrange, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  warningBtnText: { fontFamily: 'Inter_700Bold', fontSize: 12, color: '#000' },
  rewardPreview: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, marginTop: 8, textAlign: 'center' },
  boostersSection: { marginBottom: 22 },
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  boostersGrid: { flexDirection: 'row', gap: 10 },
  boosterCard: { flex: 1, backgroundColor: Colors.darkCard, borderRadius: 14, padding: 12, alignItems: 'center', gap: 4, borderWidth: 1 },
  boosterLabel: { fontFamily: 'Inter_700Bold', fontSize: 17 },
  boosterCost: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted },
  boosterTimer: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  boosterHint: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, textAlign: 'center', marginTop: 8 },
  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: Colors.darkCard, borderRadius: 16, padding: 16, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: Colors.darkBorder },
  statValue: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },
  statLabel: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },
  adBanner: { borderRadius: 10, overflow: 'hidden' },
  adBannerInner: { height: 50, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, borderWidth: 1, borderColor: Colors.darkBorder, borderRadius: 10 },
  adBannerText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
});

// ── Modal styles ───────────────────────────────────────────────────────────────

const modal = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  card: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 28,
    paddingBottom: 40,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 18,
    right: 20,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 16,
  },
  badge: {
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    marginTop: 4,
  },
  badgeText: { fontFamily: 'Inter_700Bold', fontSize: 30 },
  badgeSub: { fontFamily: 'Inter_600SemiBold', fontSize: 9, letterSpacing: 1 },
  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 19,
    color: Colors.textPrimary,
    marginBottom: 20,
    textAlign: 'center',
  },
  costBox: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 10,
    marginBottom: 20,
  },
  costRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  costLabel: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary },
  costVal: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textPrimary },
  costDivider: { height: 1, marginVertical: 2 },
  renewNote: {
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
    color: Colors.textMuted,
    textAlign: 'center',
    marginBottom: 12,
    paddingHorizontal: 8,
  },
  startBtn: { width: '100%', marginBottom: 12 },
  gamesBtn: { width: '100%', marginBottom: 12 },
  startBtnInner: {
    height: 56,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  startBtnText: { fontFamily: 'Inter_700Bold', fontSize: 17, color: '#000' },
  insufficientBox: {
    alignItems: 'center',
    gap: 6,
    marginBottom: 20,
    backgroundColor: 'rgba(255,80,80,0.08)',
    borderRadius: 14,
    padding: 16,
    width: '100%',
    borderWidth: 1,
    borderColor: 'rgba(255,80,80,0.25)',
  },
  insufficientText: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#FF5050' },
  insufficientSub: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary, textAlign: 'center' },
  cancelBtn: { paddingVertical: 8 },
  cancelText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },
});
