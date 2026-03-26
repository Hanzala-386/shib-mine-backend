import React, { useEffect, useRef, useState, useCallback, memo } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Alert, Platform,
  Animated as RNAnimated, ActivityIndicator, Modal, Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
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
import { useAds } from '@/context/AdContext';
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

// ── Booster Modal — defined OUTSIDE HomeScreen so it never causes a remount ───

interface BoosterItem {
  label: string;
  multiplier: number;
  cost: number;
  color: string;
}

interface BoosterModalProps {
  booster: BoosterItem | null;
  onClose: () => void;
  onConfirm: (b: BoosterItem) => void;
  isMining: boolean;
  miningEntryCost: number;
  safePT: number;
  activeBooster: { multiplier: number; expiresAt: number } | null;
  now: number;
}

const BoosterModal = memo(function BoosterModal({
  booster,
  onClose,
  onConfirm,
  isMining,
  miningEntryCost,
  safePT,
  activeBooster,
  now,
}: BoosterModalProps) {
  const router = useRouter();

  // Fade value for the backdrop overlay
  const backdropOpacity = useRef(new RNAnimated.Value(0)).current;

  useEffect(() => {
    if (booster) {
      RNAnimated.timing(backdropOpacity, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }).start();
    } else {
      backdropOpacity.setValue(0);
    }
  }, [booster]);

  if (!booster) return null;

  const b = booster;
  const totalCost = isMining ? b.cost : b.cost + miningEntryCost;
  const canAfford = safePT >= totalCost;
  const isActive = !!(activeBooster && activeBooster.multiplier === b.multiplier && activeBooster.expiresAt > now);

  return (
    <Modal
      transparent
      animationType="none"
      visible={!!booster}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Animated backdrop — fades in smoothly */}
      <RNAnimated.View style={[modal.backdropOverlay, { opacity: backdropOpacity }]}>
        <BlurView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
      </RNAnimated.View>

      {/* Tap backdrop to dismiss */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

      {/* Bottom sheet card — slides + fades in */}
      <RNAnimated.View
        style={[
          modal.sheet,
          {
            opacity: backdropOpacity,
            transform: [{
              translateY: backdropOpacity.interpolate({
                inputRange: [0, 1],
                outputRange: [60, 0],
              }),
            }],
          },
        ]}
      >
        <LinearGradient
          colors={['rgba(26,26,40,0.98)', 'rgba(14,14,24,0.99)']}
          style={modal.card}
        >
          {/* Close button */}
          <Pressable style={modal.closeBtn} onPress={onClose} hitSlop={12}>
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
                onPress={() => onConfirm(b)}
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
                onPress={() => { onClose(); router.push('/(tabs)/games'); }}
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

          <Pressable onPress={onClose} style={modal.cancelBtn} hitSlop={8}>
            <Text style={modal.cancelText}>Cancel</Text>
          </Pressable>
        </LinearGradient>
      </RNAnimated.View>
    </Modal>
  );
});

// ── Home screen ────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user, pbUser, signOut } = useAuth();
  const { powerTokens, shibBalance } = useWallet();
  const {
    status, timeRemaining, progress, startMining, claimReward,
    shibReward, session, displayedShibBalance,
    miningEntryCost, activeBooster, activateBooster, startMiningWithBooster, isClaiming,
    showRateUs, dismissRateUs, markAppRated,
  } = useMining();
  const { settings } = useAdmin();
  const { showMiningInterstitial } = useAds();

  const [showAdLoader, setShowAdLoader] = useState(false);
  const [showLowPtWarning, setShowLowPtWarning] = useState(false);
  const [showWelcomeBonus, setShowWelcomeBonus] = useState(false);
  const welcomeAnim = useRef(new RNAnimated.Value(0)).current;

  // Booster modal state — simple local flag, does NOT cause mining to reset
  const [selectedBooster, setSelectedBooster] = useState<BoosterItem | null>(null);

  // Toast state for "mining active" message
  const [toastMsg, setToastMsg] = useState('');
  const toastAnim = useRef(new RNAnimated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 1-second clock for booster countdown display only
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Welcome bonus popup — fires once per new signup
  useEffect(() => {
    AsyncStorage.getItem('shib_welcome_bonus_pending').then((val) => {
      if (val === 'true') {
        AsyncStorage.removeItem('shib_welcome_bonus_pending');
        welcomeAnim.setValue(0);
        setShowWelcomeBonus(true);
        RNAnimated.spring(welcomeAnim, { toValue: 1, useNativeDriver: true, tension: 60, friction: 9 }).start();
      }
    });
  }, []);

  // ── Zero-NaN safe values ─────────────────────────────────────────────────
  const safePT            = (typeof powerTokens === 'number' && isFinite(powerTokens)) ? powerTokens : 0;
  const safeShib          = (typeof shibBalance === 'number' && isFinite(shibBalance)) ? shibBalance : 0;
  const safeDisplayed     = (typeof displayedShibBalance === 'number' && isFinite(displayedShibBalance)) ? displayedShibBalance : 0;
  const safeMultiplier    = (session && typeof session.multiplier === 'number' && isFinite(session.multiplier)) ? session.multiplier : 1;
  const safeProgress      = (typeof progress === 'number' && isFinite(progress)) ? Math.min(1, Math.max(0, progress)) : 0;
  const safeShibReward    = (typeof shibReward === 'number' && isFinite(shibReward)) ? shibReward : 0;
  const safeTimeRemaining = (typeof timeRemaining === 'number' && isFinite(timeRemaining)) ? Math.max(0, timeRemaining) : 0;

  const displayedPT        = useRollingNumber(safePT, 400);
  // Top card: ONLY the coins mined in the current session (starts from 0.000 each session)
  // Visual logic: (CurrentTime - StartTime) * MiningRate — driven by MiningContext's setInterval
  const displayedLiveShib  = useRollingNumber(safeDisplayed, 100);
  // Bottom stat card: static wallet balance from DB — only updates after a successful Claim
  const displayedStatShib  = useRollingNumber(safeShib, 800);

  // Animations
  const rotation    = useSharedValue(0);
  const pulse       = useSharedValue(1);
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

  // ── Toast helper ─────────────────────────────────────────────────────────

  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastMsg(msg);
    toastAnim.setValue(0);
    RNAnimated.sequence([
      RNAnimated.timing(toastAnim, { toValue: 1, duration: 240, useNativeDriver: true }),
      RNAnimated.delay(2200),
      RNAnimated.timing(toastAnim, { toValue: 0, duration: 240, useNativeDriver: true }),
    ]).start();
    toastTimer.current = setTimeout(() => setToastMsg(''), 2700);
  }, [toastAnim]);

  // ── Helpers (memoized to avoid passing new refs to BoosterModal) ──────────

  const withAd = useCallback(async (action: () => Promise<{ success: boolean; error?: string }>) => {
    setShowAdLoader(true);
    // Mining/Power buttons — Unity → AppLovin ONLY (no AdMob per policy)
    await new Promise<void>((resolve) => {
      showMiningInterstitial(() => resolve());
    });
    setShowAdLoader(false);
    const result = await action();
    if (result.success) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      Alert.alert('Cannot Start Mining', result.error || 'Failed to start mining.');
    }
  }, [showMiningInterstitial]);

  const handleStartMining = useCallback(async () => {
    if (!pbUser) { Alert.alert('Not Ready', 'Account sync in progress. Please wait.'); return; }
    if (safePT < miningEntryCost) { setShowLowPtWarning(true); return; }
    setShowLowPtWarning(false);
    await withAd(startMining);
  }, [pbUser, safePT, miningEntryCost, withAd, startMining]);

  const handleClaim = useCallback(async () => {
    if (isClaiming) return;
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      const reward = await claimReward();
      if (reward > 0) Alert.alert('Reward Claimed! 🎉', `You earned ${formatShib(reward)} SHIB!`);
    } catch (e: any) {
      const errCode = e?.data?.error || '';
      const serverMsg = e?.data?.message || '';

      if (errCode === 'FRAUD_DETECTED') {
        const strikes = e?.data?.fraudAttempts ?? 0;
        const isBlocked = e?.data?.blocked ?? false;

        if (isBlocked) {
          // Strike 3 — account permanently blocked, sign out on dismiss
          Alert.alert(
            'ACCOUNT BANNED!',
            serverMsg || 'Your account has been permanently disabled due to multiple fraud attempts.',
            [{ text: 'OK', onPress: () => signOut?.() }],
          );
        } else {
          // Strike 1 or 2 — session reset, user must mine again from scratch
          Alert.alert(
            `Claim Rejected — Strike ${strikes}/3`,
            serverMsg || `Time manipulation detected. 0 SHIB credited. Your mining session has been reset.\n\nStrike ${strikes}/3 — 3 strikes results in a permanent ban.`,
            [{ text: 'OK' }],
          );
        }
      } else if (errCode === 'ACCOUNT_BLOCKED') {
        Alert.alert(
          'ACCOUNT BANNED!',
          serverMsg || 'Your account has been permanently disabled due to multiple fraud attempts.',
          [{ text: 'OK', onPress: () => signOut?.() }],
        );
      } else if (errCode === 'CLAIM_TIMEOUT') {
        // Network stall — session already reset by claimReward
        Alert.alert(
          'Connection Timeout',
          'The server took too long to respond. Your session has been reset — please start a new mining session.',
          [{ text: 'OK' }],
        );
      } else {
        Alert.alert('Claim Failed', e?.message || 'Something went wrong. Please try again.');
      }
    }
  }, [isClaiming, claimReward, signOut]);

  // Opens the booster modal — blocked during active mining to prevent double-spend
  const handleBoosterTap = useCallback((b: BoosterItem) => {
    if (status === 'mining') {
      showToast('Mining already in progress. Wait for the timer to finish.');
      return;
    }
    setSelectedBooster(b);
  }, [status, showToast]);

  // Called from modal when user confirms
  const handleBoosterConfirm = useCallback(async (b: BoosterItem) => {
    setSelectedBooster(null);
    const isMiningNow = status === 'mining';
    if (isMiningNow) {
      const res = await activateBooster(b.multiplier);
      if (!res.success) Alert.alert('Error', res.error || 'Failed to activate booster.');
      else await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setShowLowPtWarning(false);
      await withAd(() => startMiningWithBooster(b.multiplier));
    }
  }, [status, activateBooster, withAd, startMiningWithBooster]);

  const handleModalClose = useCallback(() => setSelectedBooster(null), []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.15)', 'rgba(255,107,0,0.1)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />

      {/* Toast notification — floats above everything, auto-dismisses */}
      {!!toastMsg && (
        <RNAnimated.View
          style={[
            styles.toast,
            {
              opacity: toastAnim,
              transform: [{ translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }],
              bottom: insets.bottom + 100,
            },
          ]}
          pointerEvents="none"
        >
          <Ionicons name="lock-closed" size={15} color={Colors.gold} />
          <Text style={styles.toastText}>{toastMsg}</Text>
        </RNAnimated.View>
      )}

      {/* BoosterModal lives OUTSIDE the ScrollView — never causes a scroll reset */}
      <BoosterModal
        booster={selectedBooster}
        onClose={handleModalClose}
        onConfirm={handleBoosterConfirm}
        isMining={status === 'mining'}
        miningEntryCost={miningEntryCost}
        safePT={safePT}
        activeBooster={activeBooster}
        now={now}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16),
            // Tab bar (~56px) + AdMob banner (~50px) + safe-area bottom + buffer
            paddingBottom: insets.bottom + 160,
          },
        ]}
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

        {/* Live balance card — only while mining. Shows the incrementing SHIB counter */}
        {status === 'mining' && (
          <Animated.View entering={FadeInDown.delay(50).springify()} style={styles.liveBalanceCard}>
            <LinearGradient
              colors={['rgba(244,196,48,0.1)', 'rgba(255,107,0,0.05)']}
              style={styles.liveBalanceInner}
            >
              <Text style={styles.liveLabel}>Mined This Session (starts from 0.000)</Text>
              <Text style={styles.liveValue}>{formatShib(displayedLiveShib)} SHIB</Text>
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
                  onPress={() => {}}
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
              style={({ pressed }) => [styles.actionBtn, { opacity: pressed ? 0.8 : 1 }]}
              onPress={handleClaim}
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
            <View style={styles.boostersTitleRow}>
              <Text style={styles.sectionTitle}>
                {status === 'idle' ? 'Activate a Booster to Start Mining' : 'Speed Boosters'}
              </Text>
              {status === 'mining' && (
                <View style={styles.lockedBadge}>
                  <Ionicons name="lock-closed" size={11} color={Colors.textMuted} />
                  <Text style={styles.lockedBadgeText}>Locked</Text>
                </View>
              )}
            </View>
            <View style={styles.boostersGrid}>
              {BOOSTERS.map((b) => {
                const isActive = !!(activeBooster && activeBooster.multiplier === b.multiplier && activeBooster.expiresAt > now);
                const anyActive = !!(activeBooster && activeBooster.expiresAt > now);
                const timeLeft = isActive ? Math.max(0, activeBooster!.expiresAt - now) : 0;
                // Cards are visually dimmed and locked while a session is running
                const isMiningLocked = status === 'mining';

                return (
                  <Pressable
                    key={b.label}
                    style={({ pressed }) => [
                      styles.boosterCard,
                      {
                        opacity: isMiningLocked ? 0.42 : pressed ? 0.7 : 1,
                        borderColor: isMiningLocked
                          ? Colors.darkBorder
                          : isActive ? b.color : anyActive ? Colors.darkBorder : b.color + '35',
                        backgroundColor: isMiningLocked
                          ? Colors.darkCard
                          : isActive ? b.color + '15' : Colors.darkCard,
                      },
                    ]}
                    onPress={() => handleBoosterTap(b)}
                    disabled={showAdLoader}
                  >
                    {isMiningLocked
                      ? <Ionicons name="lock-closed" size={16} color={Colors.textMuted} />
                      : <Text style={[styles.boosterLabel, { color: b.color }]}>{b.label}</Text>
                    }
                    {isMiningLocked ? (
                      <Text style={styles.boosterCost}>{b.label}</Text>
                    ) : isActive ? (
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
            {status === 'mining' && (
              <Text style={styles.boosterHint}>Boosters unlock after mining session ends</Text>
            )}
          </Animated.View>
        )}

        {/* Stats row — bottom boxes */}
        <Animated.View entering={FadeInDown.delay(450).springify()} style={styles.statsRow}>
          {/* SHIB Balance: static wallet value from DB, only updates after claim */}
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="bitcoin" size={20} color={Colors.gold} />
            <Text style={styles.statValue}>{formatShib(displayedStatShib)}</Text>
            <Text style={styles.statLabel}>SHIB Balance</Text>
          </View>
          <View style={styles.statCard}>
            <MaterialCommunityIcons name="lightning-bolt" size={20} color={Colors.neonOrange} />
            <Text style={styles.statValue}>{Math.floor(displayedPT)}</Text>
            <Text style={styles.statLabel}>Power Tokens</Text>
          </View>
        </Animated.View>

      </ScrollView>

      {/* ══ WELCOME BONUS MODAL ════════════════════════════════════════════════ */}
      <Modal
        visible={showWelcomeBonus}
        transparent
        animationType="none"
        onRequestClose={() => setShowWelcomeBonus(false)}
        statusBarTranslucent
      >
        <View style={welcomeStyles.overlay}>
          <RNAnimated.View
            style={[
              welcomeStyles.card,
              {
                opacity: welcomeAnim,
                transform: [{
                  scale: welcomeAnim.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] }),
                }],
              },
            ]}
          >
            <LinearGradient
              colors={['rgba(30,22,4,0.99)', 'rgba(14,10,28,0.99)']}
              style={welcomeStyles.cardInner}
            >
              {/* Shimmer glow ring */}
              <View style={welcomeStyles.glowRing}>
                <LinearGradient
                  colors={[Colors.gold + '40', Colors.neonOrange + '30', Colors.gold + '20']}
                  style={welcomeStyles.glowRingGrad}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                >
                  <MaterialCommunityIcons name="gift" size={44} color={Colors.gold} />
                </LinearGradient>
              </View>

              {/* Confetti dots */}
              <Text style={welcomeStyles.confetti}>🎉</Text>

              <Text style={welcomeStyles.title}>Welcome Bonus!</Text>
              <Text style={welcomeStyles.subtitle}>
                Congratulations! Your account has been credited with:
              </Text>

              {/* Bonus rows */}
              <View style={welcomeStyles.bonusRow}>
                <LinearGradient
                  colors={['rgba(244,196,48,0.15)', 'rgba(244,196,48,0.05)']}
                  style={welcomeStyles.bonusItem}
                >
                  <MaterialCommunityIcons name="bitcoin" size={26} color={Colors.gold} />
                  <Text style={welcomeStyles.bonusAmount}>100</Text>
                  <Text style={welcomeStyles.bonusLabel}>Shiba Inu{'\n'}Coins</Text>
                </LinearGradient>
                <LinearGradient
                  colors={['rgba(255,107,0,0.15)', 'rgba(255,107,0,0.05)']}
                  style={welcomeStyles.bonusItem}
                >
                  <MaterialCommunityIcons name="lightning-bolt" size={26} color={Colors.neonOrange} />
                  <Text style={[welcomeStyles.bonusAmount, { color: Colors.neonOrange }]}>500</Text>
                  <Text style={welcomeStyles.bonusLabel}>Power{'\n'}Tokens</Text>
                </LinearGradient>
              </View>

              <Text style={welcomeStyles.hint}>
                Use Power Tokens to start mining and unlock boosters!
              </Text>

              {/* CTA */}
              <Pressable
                style={({ pressed }) => [welcomeStyles.ctaBtn, { opacity: pressed ? 0.85 : 1 }]}
                onPress={() => setShowWelcomeBonus(false)}
              >
                <LinearGradient
                  colors={[Colors.gold, Colors.neonOrange]}
                  style={welcomeStyles.ctaGrad}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                >
                  <MaterialCommunityIcons name="rocket-launch" size={20} color="#000" />
                  <Text style={welcomeStyles.ctaText}>Start Mining!</Text>
                </LinearGradient>
              </Pressable>
            </LinearGradient>
          </RNAnimated.View>
        </View>
      </Modal>

      {/* ══ RATE US MODAL ══════════════════════════════════════════════════════ */}
      <Modal visible={showRateUs} transparent animationType="fade" onRequestClose={dismissRateUs}>
        <Pressable style={rateStyles.overlay} onPress={dismissRateUs}>
          <Pressable style={rateStyles.card} onPress={(e) => e.stopPropagation()}>
            <LinearGradient colors={['rgba(244,196,48,0.18)', 'rgba(20,14,8,0.98)']} style={rateStyles.gradient}>
              <Text style={rateStyles.stars}>⭐⭐⭐⭐⭐</Text>
              <Text style={rateStyles.title}>Loving Shiba Hit?</Text>
              <Text style={rateStyles.subtitle}>Help us grow by leaving a quick rating on the store!</Text>
              <Pressable
                style={rateStyles.rateBtn}
                onPress={() => {
                  const link = settings?.playStoreUrl || settings?.appStoreLink;
                  if (link) Linking.openURL(link).catch(() => {});
                  markAppRated();
                }}
              >
                <LinearGradient colors={[Colors.neonOrange, Colors.gold]} style={rateStyles.rateBtnGrad}>
                  <Text style={rateStyles.rateBtnText}>Rate the App</Text>
                </LinearGradient>
              </Pressable>
              <Pressable onPress={dismissRateUs} style={{ paddingVertical: 10 }}>
                <Text style={{ color: Colors.textMuted, fontSize: 14, textAlign: 'center' }}>Maybe Later</Text>
              </Pressable>
            </LinearGradient>
          </Pressable>
        </Pressable>
      </Modal>
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
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1 },
  boostersGrid: { flexDirection: 'row', gap: 10 },
  boosterCard: { flex: 1, backgroundColor: Colors.darkCard, borderRadius: 14, padding: 12, alignItems: 'center', gap: 4, borderWidth: 1 },
  boosterLabel: { fontFamily: 'Inter_700Bold', fontSize: 17 },
  boosterCost: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted },
  boosterTimer: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  boosterHint: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, textAlign: 'center', marginTop: 8 },
  boostersTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  lockedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 10,
    paddingHorizontal: 9, paddingVertical: 4,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  lockedBadgeText: { fontFamily: 'Inter_500Medium', fontSize: 11, color: Colors.textMuted },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(20,20,32,0.96)',
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.3)',
    zIndex: 999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 10,
    maxWidth: '88%',
  },
  toastText: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textPrimary, flexShrink: 1 },
  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: Colors.darkCard, borderRadius: 16, padding: 16, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: Colors.darkBorder },
  statValue: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },
  statLabel: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },
});

// ── Modal styles ───────────────────────────────────────────────────────────────

const modal = StyleSheet.create({
  backdropOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.65)',
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
    paddingBottom: 44,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    alignItems: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 18,
    right: 20,
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 17,
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
  cancelBtn: { paddingVertical: 10 },
  cancelText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },
});

const rateStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  card: { width: '100%', maxWidth: 340, borderRadius: 24, overflow: 'hidden' },
  gradient: { padding: 28, alignItems: 'center', gap: 12 },
  stars: { fontSize: 32 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.gold, textAlign: 'center' },
  subtitle: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  rateBtn: { width: '100%', borderRadius: 14, overflow: 'hidden', marginTop: 4 },
  rateBtnGrad: { paddingVertical: 14, alignItems: 'center' },
  rateBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
});

const welcomeStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.35)',
  },
  cardInner: {
    padding: 28,
    alignItems: 'center',
    gap: 0,
  },
  glowRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    overflow: 'hidden',
    marginBottom: 12,
    borderWidth: 2,
    borderColor: 'rgba(244,196,48,0.45)',
  },
  glowRingGrad: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confetti: { fontSize: 26, marginBottom: 4 },
  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 26,
    color: Colors.gold,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 22,
    paddingHorizontal: 8,
  },
  bonusRow: {
    flexDirection: 'row',
    gap: 14,
    width: '100%',
    marginBottom: 18,
  },
  bonusItem: {
    flex: 1,
    borderRadius: 18,
    padding: 18,
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.2)',
  },
  bonusAmount: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    color: Colors.gold,
  },
  bonusLabel: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 16,
  },
  hint: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 17,
    marginBottom: 22,
    paddingHorizontal: 4,
  },
  ctaBtn: { width: '100%' },
  ctaGrad: {
    height: 54,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  ctaText: { fontFamily: 'Inter_700Bold', fontSize: 17, color: '#000' },
});
