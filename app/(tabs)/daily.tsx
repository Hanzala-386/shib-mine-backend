import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable,
  Animated, ActivityIndicator, Platform, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { useAdmin } from '@/context/AdminContext';
import { pb } from '@/lib/pocketbase';
import { api, type DailyStatus, type DailyRewards, type DailyClaimResult } from '@/lib/api';
import Colors from '@/constants/colors';

/* ─── Status computation (mirrors server logic) ────────────────────────────── */
function computeDailyStatus(
  streak: number,
  lastClaimMs: number,
  serverNowMs: number,
  rewards: DailyRewards,
): DailyStatus {
  const diffMs = lastClaimMs ? serverNowMs - lastClaimMs : Infinity;
  const H24 = 24 * 3600_000;
  const H48 = 48 * 3600_000;
  let canClaim = false;
  let activeDay = 1;
  let nextClaimAt: string | null = null;

  if (!lastClaimMs || diffMs >= H48) {
    canClaim = true; activeDay = 1;
  } else if (streak >= 7 && diffMs >= H24) {
    canClaim = true; activeDay = 1;
  } else if (streak >= 7) {
    canClaim = false; activeDay = 7;
    nextClaimAt = new Date(lastClaimMs + H24).toISOString();
  } else if (diffMs >= H24) {
    canClaim = true; activeDay = streak + 1;
  } else {
    canClaim = false; activeDay = streak + 1;
    nextClaimAt = new Date(lastClaimMs + H24).toISOString();
  }
  return { streak, activeDay, canClaim, nextClaimAt, serverTime: new Date(serverNowMs).toISOString(), rewards };
}

/* ─── APK fallback: PB direct ─────────────────────────────────────────────── */
async function fetchStatusDirect(pbId: string, fallbackRewards: DailyRewards): Promise<DailyStatus> {
  const u = await pb.collection('users').getOne(pbId, { fields: 'id,daily_streak,last_daily_claim' });
  const streak = Number(u.daily_streak) || 0;
  const lastClaimMs = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
  return computeDailyStatus(streak, lastClaimMs, Date.now(), fallbackRewards);
}

async function claimDirect(pbId: string, fallbackRewards: DailyRewards): Promise<DailyClaimResult> {
  const u = await pb.collection('users').getOne(pbId, {
    fields: 'id,daily_streak,last_daily_claim,shib_balance,power_tokens',
  });
  const streak = Number(u.daily_streak) || 0;
  const lastClaimMs = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
  const nowMs = Date.now();
  const status = computeDailyStatus(streak, lastClaimMs, nowMs, fallbackRewards);

  if (!status.canClaim) throw new Error('Not yet eligible. Wait for the timer to reach zero.');

  const claimDay = status.activeDay;
  const rewardMap: Record<number, { shib: number; pt: number }> = {
    1: { shib: fallbackRewards.day1Shib, pt: 0 },
    2: { shib: 0, pt: fallbackRewards.day2Pt },
    3: { shib: fallbackRewards.day3Shib, pt: 0 },
    4: { shib: 0, pt: fallbackRewards.day4Pt },
    5: { shib: fallbackRewards.day5Shib, pt: 0 },
    6: { shib: 0, pt: fallbackRewards.day6Pt },
    7: { shib: fallbackRewards.day7Shib, pt: fallbackRewards.day7Pt },
  };
  const reward = rewardMap[claimDay] ?? { shib: 0, pt: 0 };
  const newStreak = claimDay;
  const newShibBalance = (Number(u.shib_balance) || 0) + reward.shib;
  const newPt = (Number(u.power_tokens) || 0) + reward.pt;
  const nowIso = new Date(nowMs).toISOString();

  await pb.collection('users').update(pbId, {
    daily_streak: newStreak,
    last_daily_claim: nowIso,
    shib_balance: newShibBalance,
    power_tokens: newPt,
  });
  pb.collection('daily_claims').create({ user_id: pbId, day_number: claimDay, reward_shib: reward.shib, reward_pt: reward.pt }).catch(() => {});

  return {
    success: true,
    claimDay,
    newStreak,
    rewardShib: reward.shib,
    rewardPt: reward.pt,
    newShibBalance,
    newPt,
    nextClaimAt: new Date(nowMs + 24 * 3600_000).toISOString(),
    serverTime: nowIso,
  };
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
const DAY_TYPE: Record<number, 'shib' | 'pt' | 'both'> = {
  1: 'shib', 2: 'pt', 3: 'shib', 4: 'pt', 5: 'shib', 6: 'pt', 7: 'both',
};

function getRewardForDay(day: number, r: DailyRewards) {
  const m: Record<number, { shib: number; pt: number }> = {
    1: { shib: r.day1Shib, pt: 0 }, 2: { shib: 0, pt: r.day2Pt },
    3: { shib: r.day3Shib, pt: 0 }, 4: { shib: 0, pt: r.day4Pt },
    5: { shib: r.day5Shib, pt: 0 }, 6: { shib: 0, pt: r.day6Pt },
    7: { shib: r.day7Shib, pt: r.day7Pt },
  };
  return m[day] ?? { shib: 0, pt: 0 };
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

/* ─── Coin icons ──────────────────────────────────────────────────────────── */
function ShibIcon({ size, dimmed }: { size: number; dimmed?: boolean }) {
  return (
    <LinearGradient
      colors={['#FFE566', '#F4C430', '#C8A000']}
      style={[styles.coinIcon, { width: size, height: size, borderRadius: size / 2, opacity: dimmed ? 0.4 : 1 }]}
    >
      <Text style={{ fontSize: size * 0.38, fontWeight: '900', color: '#0A0A0F' }}>S</Text>
    </LinearGradient>
  );
}

function PtIcon({ size, dimmed }: { size: number; dimmed?: boolean }) {
  return <Ionicons name="flash" size={size} color={dimmed ? '#444' : Colors.neonOrange} />;
}

/* ─── Day card ─────────────────────────────────────────────────────────────── */
type DayState = 'claimed' | 'active' | 'locked';

interface DayCardProps {
  day: number;
  state: DayState;
  rewards: DailyRewards;
  glowAnim: Animated.Value;
  wide?: boolean;
}

function DayCard({ day, state, rewards, glowAnim, wide }: DayCardProps) {
  const reward = getRewardForDay(day, rewards);
  const type = DAY_TYPE[day];
  const isClaimed = state === 'claimed';
  const isActive = state === 'active';
  const isLocked = state === 'locked';

  const animBorder = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [Colors.gold, Colors.neonOrange] })
    : (isClaimed ? (Colors.gold + '44') : Colors.darkBorder);

  const animGlow = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.22, 0.60] })
    : 0;

  const animBg = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.07] })
    : 0;

  const iconSize = wide ? 30 : isActive ? 28 : 22;

  return (
    <Animated.View
      style={[
        styles.dayCard,
        wide && styles.dayCardWide,
        { borderColor: animBorder },
        isActive && Platform.OS !== 'web' && {
          shadowColor: Colors.gold,
          shadowOpacity: animGlow,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 0 },
          elevation: 10,
        },
        isLocked && styles.dayCardLocked,
        isClaimed && { opacity: 0.72 },
      ]}
    >
      {/* Active pulse bg */}
      {isActive && (
        <Animated.View
          style={[StyleSheet.absoluteFill, { borderRadius: 14, backgroundColor: Colors.gold, opacity: animBg }]}
          pointerEvents="none"
        />
      )}

      {/* Day badge */}
      <View style={[
        styles.dayBadge,
        isActive && styles.dayBadgeActive,
        isClaimed && styles.dayBadgeClaimed,
      ]}>
        <Text style={[styles.dayBadgeText, isActive && styles.dayBadgeTextActive]}>
          {isClaimed ? '✓ ' : ''}{wide ? 'Day 7' : `Day ${day}`}
        </Text>
      </View>

      {/* Icon(s) */}
      {wide ? (
        <View style={styles.grandIcons}>
          <ShibIcon size={iconSize} dimmed={isLocked} />
          <PtIcon size={iconSize} dimmed={isLocked} />
        </View>
      ) : type === 'shib' ? (
        <ShibIcon size={iconSize} dimmed={isLocked} />
      ) : (
        <PtIcon size={iconSize} dimmed={isLocked} />
      )}

      {/* Reward text */}
      {isLocked ? (
        <Text style={styles.lockedText}>???</Text>
      ) : wide ? (
        <View style={styles.grandAmounts}>
          <Text style={[styles.rewardAmt, { color: Colors.gold }]}>{fmtNum(reward.shib)} SHIB</Text>
          <Text style={styles.rewardPlus}>+</Text>
          <Text style={[styles.rewardAmt, { color: Colors.neonOrange }]}>{fmtNum(reward.pt)} PT</Text>
        </View>
      ) : type === 'shib' ? (
        <Text style={[styles.rewardAmt, isClaimed && styles.rewardAmtClaimed]}>{fmtNum(reward.shib)} SHIB</Text>
      ) : (
        <Text style={[styles.rewardAmt, { color: Colors.neonOrange }, isClaimed && styles.rewardAmtClaimed]}>
          {fmtNum(reward.pt)} PT
        </Text>
      )}

      {/* Lock icon */}
      {isLocked && (
        <View style={styles.lockIcon} pointerEvents="none">
          <Ionicons name="lock-closed" size={14} color="#3a3a3a" />
        </View>
      )}
    </Animated.View>
  );
}

/* ─── Main screen ──────────────────────────────────────────────────────────── */
export default function DailyScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { settings } = useAdmin();

  const [status, setStatus] = useState<DailyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [serverOffset, setServerOffset] = useState(0);
  const [countdownMs, setCountdownMs] = useState(0);
  const [claimSuccess, setClaimSuccess] = useState<{ shib: number; pt: number } | null>(null);

  const glowAnim = useRef(new Animated.Value(0)).current;
  const glowLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  const fallbackRewards: DailyRewards = {
    day1Shib: settings?.dailyRewardDay1Shib ?? 1000,
    day2Pt:   settings?.dailyRewardDay2Pt   ?? 50,
    day3Shib: settings?.dailyRewardDay3Shib ?? 3000,
    day4Pt:   settings?.dailyRewardDay4Pt   ?? 100,
    day5Shib: settings?.dailyRewardDay5Shib ?? 5000,
    day6Pt:   settings?.dailyRewardDay6Pt   ?? 200,
    day7Shib: settings?.dailyRewardDay7Shib ?? 10000,
    day7Pt:   settings?.dailyRewardDay7Pt   ?? 500,
  };

  const loadStatus = useCallback(async () => {
    if (!user?.pbId) return;
    try {
      let s: DailyStatus;
      try {
        s = await api.getDailyStatus(user.pbId);
        setServerOffset(new Date(s.serverTime).getTime() - Date.now());
      } catch {
        s = await fetchStatusDirect(user.pbId, fallbackRewards);
      }
      setStatus(s);
    } catch (e: any) {
      console.warn('[Daily] loadStatus:', e.message);
    } finally {
      setLoading(false);
    }
  }, [user?.pbId, settings]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Glow pulse loop
  useEffect(() => {
    glowLoopRef.current?.stop();
    glowAnim.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1100, useNativeDriver: false }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1100, useNativeDriver: false }),
      ]),
    );
    glowLoopRef.current = loop;
    loop.start();
    return () => loop.stop();
  }, [status?.activeDay]);

  // Countdown tick
  useEffect(() => {
    if (!status?.nextClaimAt) { setCountdownMs(0); return; }
    const tick = () => {
      const rem = new Date(status.nextClaimAt!).getTime() - (Date.now() + serverOffset);
      if (rem <= 0) { setCountdownMs(0); loadStatus(); return; }
      setCountdownMs(rem);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status?.nextClaimAt, serverOffset]);

  const handleClaim = useCallback(async () => {
    if (!user?.pbId || claiming || !status?.canClaim) return;
    setClaiming(true);
    setClaimSuccess(null);
    try {
      let result: DailyClaimResult;
      try {
        result = await api.claimDailyReward(user.pbId);
      } catch {
        result = await claimDirect(user.pbId, fallbackRewards);
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setClaimSuccess({ shib: result.rewardShib, pt: result.rewardPt });
      await loadStatus();
      setTimeout(() => setClaimSuccess(null), 3500);
    } catch (e: any) {
      Alert.alert('Claim Failed', e.message || 'Something went wrong. Please try again.');
    } finally {
      setClaiming(false);
    }
  }, [user?.pbId, claiming, status?.canClaim, fallbackRewards, loadStatus]);

  /* ── Loading state ── */
  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.darkBg, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={Colors.gold} size="large" />
        <Text style={styles.loadingText}>Loading rewards…</Text>
      </View>
    );
  }

  const activeDay = status?.activeDay ?? 1;
  const canClaim  = status?.canClaim  ?? false;
  const streak    = status?.streak    ?? 0;
  const rewards   = status?.rewards   ?? fallbackRewards;

  function getDayState(day: number): DayState {
    if (day < activeDay) return 'claimed';
    if (day === activeDay) return 'active';
    return 'locked';
  }

  const hh = Math.floor(countdownMs / 3_600_000);
  const mm = Math.floor((countdownMs % 3_600_000) / 60_000);
  const ss = Math.floor((countdownMs % 60_000) / 1_000);
  const countdownStr = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.07)', 'transparent', 'rgba(255,107,0,0.04)']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
      />

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 14), paddingBottom: 140 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.title}>DAILY REWARDS</Text>
          <Text style={styles.subtitle}>Return every day to grow your streak</Text>
          {streak > 0 && (
            <View style={styles.streakBadge}>
              <Ionicons name="flame" size={13} color={Colors.neonOrange} />
              <Text style={styles.streakText}>
                {streak >= 7 ? '🏆 7-Day Streak Complete!' : `${streak}-Day Streak`}
              </Text>
            </View>
          )}
        </View>

        {/* ── Status card ── */}
        <View style={[styles.statusCard, canClaim && styles.statusCardReady]}>
          {canClaim ? (
            <>
              <Ionicons name="gift" size={20} color={Colors.gold} />
              <Text style={styles.readyText}>Your reward is waiting!</Text>
            </>
          ) : (
            <>
              <Ionicons name="timer-outline" size={18} color={Colors.textMuted} />
              <Text style={styles.nextLabel}>NEXT REWARD IN</Text>
              <Text style={styles.countdown}>{countdownStr}</Text>
            </>
          )}
        </View>

        {/* ── Success banner ── */}
        {claimSuccess && (
          <View style={styles.successBanner}>
            <Ionicons name="checkmark-circle" size={18} color={Colors.gold} />
            <Text style={styles.successText}>
              Claimed!
              {claimSuccess.shib > 0 ? `  +${fmtNum(claimSuccess.shib)} SHIB` : ''}
              {claimSuccess.pt > 0   ? `  +${fmtNum(claimSuccess.pt)} PT`     : ''}
            </Text>
          </View>
        )}

        {/* ── Grid row 1: Days 1–3 ── */}
        <View style={styles.gridRow}>
          {[1, 2, 3].map(d => (
            <DayCard key={d} day={d} state={getDayState(d)} rewards={rewards} glowAnim={glowAnim} />
          ))}
        </View>

        {/* ── Grid row 2: Days 4–6 ── */}
        <View style={styles.gridRow}>
          {[4, 5, 6].map(d => (
            <DayCard key={d} day={d} state={getDayState(d)} rewards={rewards} glowAnim={glowAnim} />
          ))}
        </View>

        {/* ── Grand reward: Day 7 ── */}
        <View style={styles.grandSection}>
          <LinearGradient
            colors={[Colors.gold, Colors.neonOrange]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.grandBadge}
          >
            <Text style={styles.grandBadgeText}>⭐  GRAND REWARD  ⭐</Text>
          </LinearGradient>
          <DayCard day={7} state={getDayState(7)} rewards={rewards} glowAnim={glowAnim} wide />
        </View>

        {/* ── Claim button ── */}
        <Pressable
          style={({ pressed }) => [styles.claimBtn, (!canClaim || claiming) && styles.claimBtnOff, pressed && canClaim && { opacity: 0.84 }]}
          onPress={handleClaim}
          disabled={!canClaim || claiming}
        >
          <LinearGradient
            colors={canClaim ? [Colors.gold, Colors.neonOrange] : ['#1e1e1e', '#1e1e1e']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.claimGrad}
          >
            {claiming ? (
              <ActivityIndicator color={canClaim ? '#0A0A0F' : Colors.textMuted} size="small" />
            ) : (
              <Text style={[styles.claimText, !canClaim && styles.claimTextOff]}>
                {canClaim ? `✦  CLAIM DAY ${activeDay}` : `Come back in ${countdownStr}`}
              </Text>
            )}
          </LinearGradient>
        </Pressable>

        <Text style={styles.hint}>Miss 2+ days? Your streak resets to Day 1.</Text>
      </ScrollView>
    </View>
  );
}

/* ─── Styles ────────────────────────────────────────────────────────────────── */
const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 14 },
  loadingText: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, marginTop: 12 },

  header: { alignItems: 'center', marginBottom: 16, gap: 4 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 21, color: Colors.textPrimary, letterSpacing: 2.5 },
  subtitle: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
  streakBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Colors.neonOrange + '1A', borderWidth: 1, borderColor: Colors.neonOrange + '55',
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4, marginTop: 4,
  },
  streakText: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.neonOrange },

  statusCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, backgroundColor: Colors.darkCard, borderRadius: 16,
    borderWidth: 1, borderColor: Colors.darkBorder,
    paddingVertical: 13, paddingHorizontal: 20, marginBottom: 12,
  },
  statusCardReady: { borderColor: Colors.gold + '80', backgroundColor: Colors.gold + '0F' },
  readyText: { fontFamily: 'Inter_600SemiBold', fontSize: 15, color: Colors.gold },
  nextLabel: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted, letterSpacing: 1.5 },
  countdown: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary, letterSpacing: 2 },

  successBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.gold + '15', borderWidth: 1, borderColor: Colors.gold + '55',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12,
  },
  successText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },

  gridRow: { flexDirection: 'row', gap: 9, marginBottom: 9 },

  dayCard: {
    flex: 1,
    backgroundColor: Colors.darkCard,
    borderRadius: 14,
    borderWidth: 1.5,
    paddingVertical: 12,
    paddingHorizontal: 6,
    alignItems: 'center',
    gap: 6,
    minHeight: 116,
    overflow: 'hidden',
  },
  dayCardWide: {
    flex: 0,
    width: '100%',
    flexDirection: 'row',
    minHeight: 72,
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 0,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dayCardLocked: { backgroundColor: '#111' },

  dayBadge: {
    backgroundColor: Colors.darkSurface ?? '#18181f',
    borderRadius: 20, paddingHorizontal: 7, paddingVertical: 2,
  },
  dayBadgeActive: { backgroundColor: Colors.gold + '22', borderWidth: 1, borderColor: Colors.gold + '70' },
  dayBadgeClaimed: { backgroundColor: Colors.gold + '12' },
  dayBadgeText: { fontFamily: 'Inter_600SemiBold', fontSize: 9, color: Colors.textMuted, letterSpacing: 0.4 },
  dayBadgeTextActive: { color: Colors.gold },

  coinIcon: { alignItems: 'center', justifyContent: 'center' },
  rewardAmt: { fontFamily: 'Inter_700Bold', fontSize: 10, color: Colors.gold, textAlign: 'center' },
  rewardAmtClaimed: { color: Colors.textMuted },
  lockedText: { fontFamily: 'Inter_500Medium', fontSize: 10, color: '#3a3a3a' },
  lockIcon: { position: 'absolute', bottom: 7, right: 7 },

  grandIcons: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grandAmounts: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rewardPlus: { fontFamily: 'Inter_700Bold', fontSize: 11, color: Colors.textMuted },

  grandSection: { marginBottom: 18, gap: 6 },
  grandBadge: { borderRadius: 20, alignSelf: 'center', paddingHorizontal: 18, paddingVertical: 5 },
  grandBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 11, color: '#0A0A0F', letterSpacing: 1.5 },

  claimBtn: { borderRadius: 16, overflow: 'hidden', marginBottom: 10 },
  claimBtnOff: { opacity: 0.55 },
  claimGrad: { paddingVertical: 16, alignItems: 'center', justifyContent: 'center', minHeight: 52 },
  claimText: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#0A0A0F', letterSpacing: 0.5 },
  claimTextOff: { color: Colors.textMuted },

  hint: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, textAlign: 'center', marginTop: 2 },
});
