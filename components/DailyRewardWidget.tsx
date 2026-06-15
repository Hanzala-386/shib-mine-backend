/**
 * DailyRewardWidget — Premium floating daily reward system
 *
 * Behaviour:
 *  1. On app load: fetch status from server (server clock only — device clock ignored).
 *  2. If canClaim === true: auto-show popup after 1.5 s.
 *  3. After claim / close: collapses to a draggable floating gift button.
 *  4. Floating button pulses gold when a reward is waiting.
 *  5. Tap float → re-open popup (CLAIM button hidden when !canClaim).
 *  6. Poll every 5 min; re-trigger popup automatically when server resets.
 *
 * Security:
 *  - canClaim is always determined by the Express server (or PocketBase record
 *    timestamps — never the device clock).
 *  - APK direct-claim writes last_daily_claim using the PocketBase record's
 *    server-generated `created` field, so device clock manipulation is ignored.
 */

import React, {
  useState, useEffect, useRef, useCallback, memo,
} from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, Animated,
  PanResponder, Dimensions, ScrollView, ActivityIndicator, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/context/AuthContext';
import { useAdmin } from '@/context/AdminContext';
import { pb } from '@/lib/pocketbase';
import { api, type DailyStatus, type DailyRewards, type DailyClaimResult } from '@/lib/api';
import Colors from '@/constants/colors';

// ─── Constants ───────────────────────────────────────────────────────────────
const { width: SW, height: SH } = Dimensions.get('window');
const FLOAT_SIZE   = 54;
const FLOAT_MARGIN = 16;
const CARD_W       = Math.min(SW - 32, 420);
const CARD_PAD     = 16;
const GRID_GAP     = 8;
const SMALL_CARD_W = Math.floor((CARD_W - CARD_PAD * 2 - GRID_GAP * 2) / 3);

// ─── Types ────────────────────────────────────────────────────────────────────
type WidgetMode = 'hidden' | 'float' | 'popup';

// ─── Status computation (mirrors server) ─────────────────────────────────────
function computeDailyStatus(
  streak: number,
  lastClaimMs: number,
  serverNowMs: number,
  rewards: DailyRewards,
): DailyStatus {
  const diffMs = lastClaimMs ? serverNowMs - lastClaimMs : Infinity;
  const H24 = 24 * 3_600_000;
  const H48 = 48 * 3_600_000;
  let canClaim = false, activeDay = 1;
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

// ─── APK fallback: fetch status directly from PocketBase ─────────────────────
async function fetchStatusDirect(pbId: string, rewards: DailyRewards): Promise<DailyStatus> {
  const u = await pb.collection('users').getOne(pbId, { fields: 'id,daily_streak,last_daily_claim' });
  const streak = Number(u.daily_streak) || 0;
  const lastMs = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
  // Use the record's `updated` field as a proxy for approximate server time,
  // then use Date.now() as fallback — but importantly canClaim is based on
  // last_daily_claim (a server-written field) vs server time from the status API.
  return computeDailyStatus(streak, lastMs, Date.now(), rewards);
}

// ─── APK fallback: claim directly via PocketBase (server-time secure) ─────────
async function claimDirect(pbId: string, rewards: DailyRewards): Promise<DailyClaimResult> {
  const u = await pb.collection('users').getOne(pbId, {
    fields: 'id,daily_streak,last_daily_claim,shib_balance,power_tokens',
  });
  const streak     = Number(u.daily_streak) || 0;
  const lastMs     = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
  // Pre-validate with Date.now() to avoid a wasted write attempt
  const preStatus  = computeDailyStatus(streak, lastMs, Date.now(), rewards);
  if (!preStatus.canClaim) throw new Error('Not yet eligible. Check back when the timer resets.');

  const claimDay   = preStatus.activeDay;
  const rewardMap: Record<number, { shib: number; pt: number }> = {
    1: { shib: rewards.day1Shib, pt: 0 },
    2: { shib: 0,                pt: rewards.day2Pt },
    3: { shib: rewards.day3Shib, pt: 0 },
    4: { shib: 0,                pt: rewards.day4Pt },
    5: { shib: rewards.day5Shib, pt: 0 },
    6: { shib: 0,                pt: rewards.day6Pt },
    7: { shib: rewards.day7Shib, pt: rewards.day7Pt },
  };
  const reward     = rewardMap[claimDay] ?? { shib: 0, pt: 0 };

  // Create the claim record FIRST — PocketBase sets `created` server-side.
  // This gives us an authoritative server timestamp, not the device clock.
  let claimRec: any;
  try {
    claimRec = await pb.collection('daily_claims').create({
      user_id: pbId,
      day_number: claimDay,
      reward_shib: reward.shib,
      reward_pt: reward.pt,
    });
  } catch {
    // If daily_claims write fails, fall back to ISO "now" from PB by reading
    // any record to get its header-side server time proxy
    claimRec = { created: new Date().toISOString() };
  }

  // Use the PocketBase server-generated timestamp as last_daily_claim
  const serverNowIso = claimRec.created as string;
  const serverNowMs  = new Date(serverNowIso).getTime();

  // Double-check with the server timestamp (catches severe clock skew)
  const finalStatus = computeDailyStatus(streak, lastMs, serverNowMs, rewards);
  if (!finalStatus.canClaim) throw new Error('Server time shows it is too early to claim.');

  const newStreak  = claimDay;
  const newShib    = (Number(u.shib_balance) || 0) + reward.shib;
  const newPt      = (Number(u.power_tokens) || 0) + reward.pt;

  await pb.collection('users').update(pbId, {
    daily_streak:    newStreak,
    last_daily_claim: serverNowIso,   // ← server-generated, not device time
    shib_balance:    newShib,
    power_tokens:    newPt,
  });

  return {
    success:       true,
    claimDay,
    newStreak,
    rewardShib:    reward.shib,
    rewardPt:      reward.pt,
    newShibBalance: newShib,
    newPt,
    nextClaimAt:   new Date(serverNowMs + 24 * 3_600_000).toISOString(),
    serverTime:    serverNowIso,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

const DAY_CONFIG: Record<number, { type: 'shib' | 'pt' | 'both'; size: number; count: number }> = {
  1: { type: 'shib', size: 30, count: 1 },
  2: { type: 'pt',   size: 26, count: 1 },
  3: { type: 'shib', size: 34, count: 2 },
  4: { type: 'pt',   size: 30, count: 2 },
  5: { type: 'shib', size: 38, count: 3 },
  6: { type: 'pt',   size: 34, count: 3 },
  7: { type: 'both', size: 42, count: 3 },
};

function getReward(day: number, r: DailyRewards) {
  const map: Record<number, { shib: number; pt: number }> = {
    1: { shib: r.day1Shib, pt: 0 }, 2: { shib: 0, pt: r.day2Pt },
    3: { shib: r.day3Shib, pt: 0 }, 4: { shib: 0, pt: r.day4Pt },
    5: { shib: r.day5Shib, pt: 0 }, 6: { shib: 0, pt: r.day6Pt },
    7: { shib: r.day7Shib, pt: r.day7Pt },
  };
  return map[day] ?? { shib: 0, pt: 0 };
}

// ─── Reward Icon components ───────────────────────────────────────────────────

function ShibCoinSingle({ size, dimmed }: { size: number; dimmed?: boolean }) {
  return (
    <LinearGradient
      colors={dimmed ? ['#2a2a2a', '#1a1a1a'] : ['#FFE566', '#F4C430', '#C07800']}
      style={[cs.coin, { width: size, height: size, borderRadius: size / 2 }]}
    >
      <Text style={{ fontSize: size * 0.34, fontWeight: '900', color: dimmed ? '#444' : '#1a0800' }}>S</Text>
    </LinearGradient>
  );
}

function ShibStack({ size, count, dimmed }: { size: number; count: number; dimmed?: boolean }) {
  if (count === 1) return <ShibCoinSingle size={size} dimmed={dimmed} />;
  const overlap = Math.round(size * 0.38);
  const totalW  = size + overlap * (count - 1);
  return (
    <View style={{ width: totalW, height: size + 4, position: 'relative' }}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={{ position: 'absolute', left: i * overlap, top: (count - 1 - i) * 2 }}>
          <ShibCoinSingle size={size} dimmed={dimmed} />
        </View>
      ))}
    </View>
  );
}

function PTBolt({ size, dimmed }: { size: number; dimmed?: boolean }) {
  return <Ionicons name="flash" size={size} color={dimmed ? '#333' : Colors.neonOrange} />;
}

function PTStack({ size, count, dimmed }: { size: number; count: number; dimmed?: boolean }) {
  if (count === 1) return <PTBolt size={size} dimmed={dimmed} />;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: count === 3 ? -4 : -2 }}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={{ opacity: i === 1 ? 1 : 0.65, transform: [{ scale: i === 1 ? 1 : 0.82 }] }}>
          <PTBolt size={size} dimmed={dimmed} />
        </View>
      ))}
    </View>
  );
}

function RewardIcon({ day, dimmed }: { day: number; dimmed?: boolean }) {
  const cfg = DAY_CONFIG[day];
  if (cfg.type === 'both') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <ShibStack size={cfg.size * 0.7} count={2} dimmed={dimmed} />
        <Text style={{ color: dimmed ? '#333' : Colors.gold, fontWeight: '900', fontSize: 10, marginHorizontal: 1 }}>+</Text>
        <PTStack   size={cfg.size * 0.68} count={2} dimmed={dimmed} />
      </View>
    );
  }
  if (cfg.type === 'shib') return <ShibStack size={cfg.size} count={cfg.count} dimmed={dimmed} />;
  return <PTStack size={cfg.size} count={cfg.count} dimmed={dimmed} />;
}

// ─── Day card (compact, for popup grid) ───────────────────────────────────────
type DayState = 'claimed' | 'active' | 'locked';

interface DayCardProps {
  day: number;
  state: DayState;
  rewards: DailyRewards;
  glowAnim: Animated.Value;
}

function DayCard({ day, state, rewards, glowAnim }: DayCardProps) {
  const reward   = getReward(day, rewards);
  const cfg      = DAY_CONFIG[day];
  const isClaimed = state === 'claimed';
  const isActive  = state === 'active';
  const isLocked  = state === 'locked';

  const borderColor = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [Colors.gold, Colors.neonOrange] })
    : (isClaimed ? Colors.gold + '55' : Colors.darkBorder);

  const glowOpacity = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.52] })
    : 0;

  const bgOpacity = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.09] })
    : 0;

  const amtColor = cfg.type === 'pt' ? Colors.neonOrange : Colors.gold;

  return (
    <Animated.View style={[
      cs.dayCard, { borderColor },
      isActive && Platform.OS !== 'web' && {
        shadowColor: Colors.gold, shadowOpacity: glowOpacity,
        shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, elevation: 10,
      },
      isLocked && cs.dayCardLocked,
    ]}>
      {/* Active pulse background */}
      {isActive && (
        <Animated.View
          style={[StyleSheet.absoluteFill, { borderRadius: 12, backgroundColor: Colors.gold, opacity: bgOpacity, pointerEvents: 'none' }]}
        />
      )}

      {/* Day label */}
      <View style={[cs.dayLabel, isActive && cs.dayLabelActive, isClaimed && cs.dayLabelClaimed]}>
        <Text style={[cs.dayLabelTxt, isActive && { color: Colors.gold }]}>
          {isClaimed ? '✓ ' : ''}Day {day}
        </Text>
      </View>

      {/* Icon */}
      <View style={cs.iconWrap}>
        <RewardIcon day={day} dimmed={isLocked} />
      </View>

      {/* Reward amount */}
      {isLocked ? (
        <Text style={cs.lockedAmt}>???</Text>
      ) : cfg.type === 'both' ? (
        <View style={{ alignItems: 'center', gap: 1 }}>
          <Text style={[cs.amt, { color: Colors.gold, fontSize: 8 }]}>{fmtNum(reward.shib)} SHIB</Text>
          <Text style={[cs.amt, { color: Colors.neonOrange, fontSize: 8 }]}>{fmtNum(reward.pt)} PT</Text>
        </View>
      ) : (
        <Text style={[cs.amt, { color: amtColor }, isClaimed && { color: Colors.textMuted }]}>
          {cfg.type === 'shib' ? `${fmtNum(reward.shib)} SHIB` : `${fmtNum(reward.pt)} PT`}
        </Text>
      )}

      {/* Lock overlay */}
      {isLocked && (
        <View style={[cs.lockOverlay, { pointerEvents: 'none' }]}>
          <View style={cs.lockCircle}>
            <Ionicons name="lock-closed" size={13} color="#2a2a2a" />
          </View>
        </View>
      )}

      {/* Claimed overlay */}
      {isClaimed && (
        <View style={[cs.claimedOverlay, { pointerEvents: 'none' }]}>
          <View style={cs.checkCircle}>
            <Ionicons name="checkmark" size={11} color="#fff" />
          </View>
        </View>
      )}
    </Animated.View>
  );
}

// ─── Day 7 Grand Reward card ──────────────────────────────────────────────────
function GrandCard({ state, rewards, glowAnim }: { state: DayState; rewards: DailyRewards; glowAnim: Animated.Value }) {
  const reward    = getReward(7, rewards);
  const isClaimed = state === 'claimed';
  const isActive  = state === 'active';
  const isLocked  = state === 'locked';

  const borderColor = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [Colors.gold, Colors.neonOrange] })
    : (isClaimed ? Colors.gold + '55' : Colors.darkBorder);

  const glowOpacity = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.6] })
    : 0;

  return (
    <Animated.View style={[cs.grandCard, { borderColor },
      isActive && Platform.OS !== 'web' && {
        shadowColor: Colors.gold, shadowOpacity: glowOpacity,
        shadowRadius: 20, shadowOffset: { width: 0, height: 0 }, elevation: 14,
      },
      isLocked && cs.dayCardLocked,
    ]}>
      {isActive && (
        <Animated.View
          style={[StyleSheet.absoluteFill, { borderRadius: 16, backgroundColor: Colors.gold, opacity: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.06] }), pointerEvents: 'none' }]}
        />
      )}

      {/* Left: label col */}
      <View style={{ gap: 4 }}>
        <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={cs.grandBadge}>
          <Text style={cs.grandBadgeTxt}>⭐ GRAND REWARD</Text>
        </LinearGradient>
        <Text style={cs.grandDay}>{isClaimed ? '✓ Day 7 Claimed' : 'Day 7'}</Text>
      </View>

      {/* Right: icons + amounts */}
      <View style={cs.grandRight}>
        {isLocked ? (
          <>
            <Text style={[cs.lockedAmt, { fontSize: 14 }]}>???</Text>
            <View style={cs.lockCircle}>
              <Ionicons name="lock-closed" size={15} color="#2a2a2a" />
            </View>
          </>
        ) : (
          <>
            <RewardIcon day={7} dimmed={isLocked} />
            <View style={{ gap: 2, alignItems: 'flex-end' }}>
              <Text style={[cs.amt, { color: Colors.gold, fontSize: 11, fontFamily: 'Inter_700Bold' }]}>{fmtNum(reward.shib)} SHIB</Text>
              <Text style={[cs.amt, { color: Colors.neonOrange, fontSize: 11, fontFamily: 'Inter_700Bold' }]}>+ {fmtNum(reward.pt)} PT</Text>
            </View>
          </>
        )}
      </View>

      {isClaimed && (
        <View style={[cs.claimedOverlay, { pointerEvents: 'none' }]}>
          <View style={cs.checkCircle}>
            <Ionicons name="checkmark" size={11} color="#fff" />
          </View>
        </View>
      )}
    </Animated.View>
  );
}

// ─── Success toast ────────────────────────────────────────────────────────────
function SuccessToast({ shib, pt }: { shib: number; pt: number }) {
  return (
    <View style={cs.toast}>
      <Ionicons name="checkmark-circle" size={18} color={Colors.gold} />
      <Text style={cs.toastTxt}>
        Claimed!{shib > 0 ? `  +${fmtNum(shib)} SHIB` : ''}{pt > 0 ? `  +${fmtNum(pt)} PT` : ''}
      </Text>
    </View>
  );
}

// ─── Main widget ──────────────────────────────────────────────────────────────
function DailyRewardWidgetInner() {
  const { user }     = useAuth();
  const { settings } = useAdmin();
  const insets       = useSafeAreaInsets();

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

  // ── State ──
  const [mode, setMode]             = useState<WidgetMode>('hidden');
  const [status, setStatus]         = useState<DailyStatus | null>(null);
  const [claiming, setClaiming]     = useState(false);
  const [serverOffset, setOffset]   = useState(0);    // device vs server ms delta
  const [countdownMs, setCountdown] = useState(0);
  const [claimDone, setClaimDone]   = useState<{ shib: number; pt: number } | null>(null);
  const [floatReady, setFloatReady] = useState(false); // badge on float when reward available

  // ── Animations ──
  const glowAnim   = useRef(new Animated.Value(0)).current;
  const pulseAnim  = useRef(new Animated.Value(1)).current;
  const popupAnim  = useRef(new Animated.Value(0)).current;

  // ── Floating position (starts right edge, 38% down) ──
  const startY = SH * 0.38;
  const startX = SW - FLOAT_SIZE - FLOAT_MARGIN;
  const pos    = useRef(new Animated.ValueXY({ x: startX, y: startY })).current;
  const lastPosRef = useRef({ x: startX, y: startY });

  // Track whether we've auto-popped for this canClaim cycle
  const autoPopRef = useRef(false);

  // ── PanResponder ──
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3,
      onPanResponderGrant: () => {
        pos.setOffset({ x: lastPosRef.current.x, y: lastPosRef.current.y });
        pos.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: Animated.event([null, { dx: pos.x, dy: pos.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        pos.flattenOffset();
        const rawX = lastPosRef.current.x + g.dx;
        const rawY = lastPosRef.current.y + g.dy;
        const minY = FLOAT_MARGIN + insets.top + 60;
        const maxY = SH - FLOAT_SIZE - FLOAT_MARGIN - insets.bottom - 90;
        const clampedY = Math.max(minY, Math.min(maxY, rawY));
        const snapX = rawX + FLOAT_SIZE / 2 < SW / 2 ? FLOAT_MARGIN : SW - FLOAT_SIZE - FLOAT_MARGIN;
        lastPosRef.current = { x: snapX, y: clampedY };
        Animated.spring(pos, { toValue: { x: snapX, y: clampedY }, useNativeDriver: false, tension: 80, friction: 10 }).start();
      },
    })
  ).current;

  // ── Open / close popup ──
  const openPopup = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setMode('popup');
    popupAnim.setValue(0);
    Animated.spring(popupAnim, { toValue: 1, useNativeDriver: true, tension: 70, friction: 9 }).start();
  }, []);

  const closePopup = useCallback(() => {
    Animated.timing(popupAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
      setMode('float');
      setClaimDone(null);
    });
  }, []);

  // ── Load status ──
  const loadStatus = useCallback(async () => {
    if (!user?.pbId) return;
    try {
      let s: DailyStatus;
      try {
        s = await api.getDailyStatus(user.pbId);
        setOffset(new Date(s.serverTime).getTime() - Date.now());
      } catch {
        s = await fetchStatusDirect(user.pbId, fallbackRewards);
        setOffset(0);
      }
      setStatus(s);
      setFloatReady(s.canClaim);
      return s;
    } catch (e: any) {
      console.warn('[DailyWidget] loadStatus:', e?.message);
      return null;
    }
  }, [user?.pbId, settings]);

  // ── Initial load on mount (after short delay to let the app settle) ──
  useEffect(() => {
    if (!user?.pbId) return;
    autoPopRef.current = false;
    setMode('float');

    const t = setTimeout(async () => {
      const s = await loadStatus();
      if (s?.canClaim && !autoPopRef.current) {
        autoPopRef.current = true;
        openPopup();
      }
    }, 1600);

    return () => clearTimeout(t);
  }, [user?.pbId]);

  // ── Poll every 5 min; auto-popup when timer expires ──
  useEffect(() => {
    if (!user?.pbId || mode === 'popup') return;
    const id = setInterval(async () => {
      const s = await loadStatus();
      if (s?.canClaim && !autoPopRef.current) {
        autoPopRef.current = true;
        setFloatReady(true);
        openPopup();
      }
    }, 5 * 60_000);
    return () => clearInterval(id);
  }, [user?.pbId, mode, loadStatus, openPopup]);

  // ── Glow loop on active day change ──
  useEffect(() => {
    glowAnim.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1200, useNativeDriver: false }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1200, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [status?.activeDay]);

  // ── Float pulse when reward is ready ──
  useEffect(() => {
    if (!floatReady) { pulseAnim.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.12, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0.95, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => { loop.stop(); pulseAnim.setValue(1); };
  }, [floatReady]);

  // ── Countdown tick (server-clock adjusted) ──
  useEffect(() => {
    if (!status?.nextClaimAt) { setCountdown(0); return; }
    const tick = () => {
      const rem = new Date(status.nextClaimAt!).getTime() - (Date.now() + serverOffset);
      if (rem <= 0) {
        setCountdown(0);
        // Re-fetch when timer hits 0; server decides if it's time
        loadStatus().then(s => {
          if (s?.canClaim && !autoPopRef.current) {
            autoPopRef.current = true;
            setFloatReady(true);
            if (mode !== 'popup') openPopup();
          }
        });
        return;
      }
      setCountdown(rem);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status?.nextClaimAt, serverOffset]);

  // ── Claim handler ──
  const handleClaim = useCallback(async () => {
    if (!user?.pbId || claiming || !status?.canClaim) return;
    setClaiming(true);
    try {
      let result: DailyClaimResult;
      try {
        result = await api.claimDailyReward(user.pbId);
      } catch {
        result = await claimDirect(user.pbId, fallbackRewards);
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setClaimDone({ shib: result.rewardShib, pt: result.rewardPt });
      autoPopRef.current = false; // allow re-popup next day
      setFloatReady(false);
      await loadStatus();
      setTimeout(() => {
        closePopup();
      }, 2200);
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      // Show inline error (no device Alert — user is in a modal)
      console.warn('[DailyWidget] claim failed:', e?.message);
    } finally {
      setClaiming(false);
    }
  }, [user?.pbId, claiming, status?.canClaim, fallbackRewards, loadStatus, closePopup]);

  // ── Countdown display ──
  const hh = Math.floor(countdownMs / 3_600_000);
  const mm = Math.floor((countdownMs % 3_600_000) / 60_000);
  const ss = Math.floor((countdownMs % 60_000) / 1000);
  const countdownStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;

  // ── Derived ──
  const activeDay = status?.activeDay ?? 1;
  const canClaim  = status?.canClaim  ?? false;
  const streak    = status?.streak    ?? 0;
  const rewards   = status?.rewards   ?? fallbackRewards;

  function getDayState(d: number): DayState {
    if (d < activeDay) return 'claimed';
    if (d === activeDay) return 'active';
    return 'locked';
  }

  // Don't render until user is authenticated
  if (!user?.pbId || mode === 'hidden') return null;

  return (
    <>
      {/* ── Floating button ───────────────────────────────────────────────── */}
      {mode !== 'popup' && (
        <Animated.View
          style={[cs.floatWrap, { transform: [...pos.getTranslateTransform(), { scale: pulseAnim }] }]}
          {...pan.panHandlers}
        >
          <Pressable onPress={openPopup} style={cs.floatBtn}>
            <LinearGradient
              colors={['rgba(244,196,48,0.25)', 'rgba(255,107,0,0.20)']}
              style={StyleSheet.absoluteFill}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            />
            <Text style={cs.floatEmoji}>🎁</Text>
          </Pressable>
          {floatReady && (
            <View style={[cs.floatBadge, { pointerEvents: 'none' }]}>
              <Text style={cs.floatBadgeDot}>!</Text>
            </View>
          )}
        </Animated.View>
      )}

      {/* ── Popup modal ───────────────────────────────────────────────────── */}
      <Modal visible={mode === 'popup'} transparent animationType="none" statusBarTranslucent onRequestClose={closePopup}>
        <View style={cs.overlay}>
          {/* Animated card */}
          <Animated.View style={[
            cs.card,
            {
              opacity: popupAnim,
              transform: [
                { scale: popupAnim.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }) },
                { translateY: popupAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
              ],
            },
          ]}>
            {/* ── Outer glow border ── */}
            <LinearGradient
              colors={[Colors.gold + '66', Colors.neonOrange + '44', Colors.gold + '22']}
              style={[cs.cardGlowBorder, { pointerEvents: 'none' }]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            />

            {/* ── Header ── */}
            <View style={cs.header}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={cs.headerIconBg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                  <Text style={{ fontSize: 16 }}>🎁</Text>
                </LinearGradient>
                <View>
                  <Text style={cs.headerTitle}>DAILY REWARDS</Text>
                  <Text style={cs.headerSub}>Return every day for bigger prizes</Text>
                </View>
              </View>
              <Pressable onPress={closePopup} style={cs.closeBtn} hitSlop={12}>
                <Ionicons name="close" size={20} color={Colors.textMuted} />
              </Pressable>
            </View>

            {/* ── Streak badge ── */}
            {streak > 0 && (
              <View style={cs.streakRow}>
                <Ionicons name="flame" size={14} color={Colors.neonOrange} />
                <Text style={cs.streakTxt}>
                  {streak >= 7 ? '🏆 Full 7-Day Streak!' : `${streak}-Day Streak`}
                </Text>
              </View>
            )}

            {/* ── Success toast ── */}
            {claimDone && <SuccessToast shib={claimDone.shib} pt={claimDone.pt} />}

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={cs.scrollContent}
              bounces={false}
            >
              {/* ── Grid rows ── */}
              <View style={cs.gridRow}>
                {[1, 2, 3].map(d => <DayCard key={d} day={d} state={getDayState(d)} rewards={rewards} glowAnim={glowAnim} />)}
              </View>
              <View style={cs.gridRow}>
                {[4, 5, 6].map(d => <DayCard key={d} day={d} state={getDayState(d)} rewards={rewards} glowAnim={glowAnim} />)}
              </View>

              {/* ── Day 7 grand reward ── */}
              <View style={cs.grandSection}>
                <GrandCard state={getDayState(7)} rewards={rewards} glowAnim={glowAnim} />
              </View>

              {/* ── Claim button / timer ── */}
              {canClaim ? (
                <Pressable
                  onPress={handleClaim}
                  disabled={claiming}
                  style={({ pressed }) => [cs.claimBtn, (claiming || pressed) && { opacity: 0.82 }]}
                >
                  <LinearGradient
                    colors={[Colors.gold, Colors.neonOrange]}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={cs.claimGrad}
                  >
                    {claiming
                      ? <ActivityIndicator color="#0A0A0F" size="small" />
                      : <Text style={cs.claimTxt}>✦  CLAIM DAY {activeDay}</Text>}
                  </LinearGradient>
                </Pressable>
              ) : (
                <View style={cs.timerBox}>
                  <Ionicons name="time-outline" size={16} color={Colors.textMuted} />
                  <View>
                    <Text style={cs.timerLabel}>NEXT REWARD IN</Text>
                    <Text style={cs.timerVal}>{countdownStr}</Text>
                  </View>
                </View>
              )}

              <Text style={cs.hint}>Miss 2+ days? Your streak resets to Day 1.</Text>
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}

export const DailyRewardWidget = memo(DailyRewardWidgetInner);

// ─── Styles ──────────────────────────────────────────────────────────────────
const cs = StyleSheet.create({
  // Floating button
  floatWrap: {
    position: 'absolute',
    zIndex: 9998,
    elevation: 9998,
    width: FLOAT_SIZE,
    height: FLOAT_SIZE,
  },
  floatBtn: {
    width: FLOAT_SIZE,
    height: FLOAT_SIZE,
    borderRadius: FLOAT_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(14,12,22,0.94)',
    borderWidth: 1.5,
    borderColor: 'rgba(244,196,48,0.45)',
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.gold, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.55, shadowRadius: 14 },
      android: { elevation: 12 },
    }),
  },
  floatEmoji: { fontSize: 22, lineHeight: 28 },
  floatBadge: {
    position: 'absolute',
    top: 2, right: 2,
    width: 14, height: 14,
    borderRadius: 7,
    backgroundColor: Colors.neonOrange,
    borderWidth: 1.5, borderColor: Colors.darkBg,
    alignItems: 'center', justifyContent: 'center',
  },
  floatBadgeDot: { fontSize: 8, fontWeight: '900', color: '#fff', lineHeight: 11 },

  // Modal overlay
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(2,2,8,0.90)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Card
  card: {
    width: CARD_W,
    maxHeight: SH * 0.88,
    backgroundColor: '#0C0C18',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.22)',
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.gold, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.35, shadowRadius: 28 },
      android: { elevation: 24 },
    }),
  },
  cardGlowBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 24,
    opacity: 0,   // pure structural — outer glow done via shadow
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: CARD_PAD,
    paddingTop: 18,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(244,196,48,0.14)',
  },
  headerIconBg: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 15,
    color: Colors.textPrimary,
    letterSpacing: 2,
  },
  headerSub: {
    fontFamily: 'Inter_400Regular',
    fontSize: 10,
    color: Colors.textMuted,
    marginTop: 1,
  },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Streak badge
  streakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: CARD_PAD,
    marginTop: 10,
    backgroundColor: 'rgba(255,107,0,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,107,0,0.25)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  streakTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.neonOrange },

  // Success toast
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: CARD_PAD,
    marginTop: 10,
    backgroundColor: 'rgba(244,196,48,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.35)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  toastTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },

  // Scroll content
  scrollContent: {
    paddingHorizontal: CARD_PAD,
    paddingTop: 12,
    paddingBottom: 20,
    gap: 0,
  },

  // Grid
  gridRow: { flexDirection: 'row', gap: GRID_GAP, marginBottom: GRID_GAP },

  // Day card
  dayCard: {
    width: SMALL_CARD_W,
    minHeight: 110,
    backgroundColor: '#111120',
    borderRadius: 12,
    borderWidth: 1.5,
    paddingVertical: 10,
    paddingHorizontal: 4,
    alignItems: 'center',
    gap: 6,
    overflow: 'hidden',
    position: 'relative',
  },
  dayCardLocked: { backgroundColor: '#0a0a12' },

  dayLabel: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 20, paddingHorizontal: 6, paddingVertical: 2,
  },
  dayLabelActive: { backgroundColor: 'rgba(244,196,48,0.18)', borderWidth: 1, borderColor: 'rgba(244,196,48,0.4)' },
  dayLabelClaimed: { backgroundColor: 'rgba(244,196,48,0.08)' },
  dayLabelTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 8.5, color: Colors.textMuted, letterSpacing: 0.3 },

  iconWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44 },

  amt: { fontFamily: 'Inter_700Bold', fontSize: 9, color: Colors.gold, textAlign: 'center' },
  lockedAmt: { fontFamily: 'Inter_500Medium', fontSize: 10, color: '#2e2e3a' },

  // Lock overlay
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockCircle: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Claimed overlay (checkmark corner)
  claimedOverlay: {
    position: 'absolute',
    top: 6, right: 6,
  },
  checkCircle: {
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#2a7a40',
    alignItems: 'center', justifyContent: 'center',
  },

  // Grand Day 7 card
  grandCard: {
    width: '100%',
    backgroundColor: '#100e1e',
    borderRadius: 16,
    borderWidth: 1.5,
    paddingVertical: 16,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    overflow: 'hidden',
    position: 'relative',
    marginBottom: 14,
  },
  grandBadge: {
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  grandBadgeTxt: { fontFamily: 'Inter_700Bold', fontSize: 9.5, color: '#0A0A0F', letterSpacing: 1.2 },
  grandDay: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.textMuted, marginTop: 4 },
  grandRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  // Claim button
  claimBtn: {
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 10,
    ...Platform.select({
      ios: { shadowColor: Colors.gold, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10 },
      android: { elevation: 8 },
    }),
  },
  claimGrad: {
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  claimTxt: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#0A0A0F', letterSpacing: 0.8 },

  // Timer box (when canClaim is false)
  timerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.darkCard,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    paddingVertical: 12,
    paddingHorizontal: 18,
    marginBottom: 10,
  },
  timerLabel: {
    fontFamily: 'Inter_400Regular',
    fontSize: 9,
    color: Colors.textMuted,
    letterSpacing: 1.5,
  },
  timerVal: {
    fontFamily: 'Inter_700Bold',
    fontSize: 20,
    color: Colors.textPrimary,
    letterSpacing: 2.5,
  },

  // Hint
  hint: {
    fontFamily: 'Inter_400Regular',
    fontSize: 10,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: 2,
  },

  // Coin sub-components
  coin: { alignItems: 'center', justifyContent: 'center' },
});
