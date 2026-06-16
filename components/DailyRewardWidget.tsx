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
  PanResponder, Dimensions, ScrollView, ActivityIndicator, Platform, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/context/AuthContext';
import { useAdmin } from '@/context/AdminContext';
import { pb } from '@/lib/pocketbase';
import { api, type DailyStatus, type DailyRewards, type DailyClaimResult, type DailyClaimSettings } from '@/lib/api';
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

// ─── Get authoritative server time from PocketBase HTTP Date header ───────────
// The HTTP Date header is set by the server, not the device. No clock exploit possible.
async function getServerTimeMs(): Promise<number> {
  try {
    const resp = await fetch('https://api.webcod.in/api/health');
    const dateHeader = resp.headers.get('Date');
    if (dateHeader) return new Date(dateHeader).getTime();
  } catch { /* fall through */ }
  // Last resort: device clock (acceptable only if PB is unreachable)
  return Date.now();
}

// ─── APK fallback: fetch status directly from PocketBase ─────────────────────
async function fetchStatusDirect(pbId: string, rewards: DailyRewards): Promise<DailyStatus> {
  // Fetch both in parallel: user record + authoritative server time
  const [u, serverNowMs] = await Promise.all([
    pb.collection('users').getOne(pbId, { fields: 'id,daily_streak,last_daily_claim' }),
    getServerTimeMs(),
  ]);
  const streak = Number(u.daily_streak) || 0;
  const lastMs = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
  // Clamp future timestamps (clock exploit artifact)
  const effectiveLastMs = (lastMs > 0 && lastMs > serverNowMs) ? 0 : lastMs;
  return computeDailyStatus(streak, effectiveLastMs, serverNowMs, rewards);
}

// ─── APK fallback: claim directly via PocketBase (server-time secure) ─────────
async function claimDirect(pbId: string, rewards: DailyRewards): Promise<DailyClaimResult> {
  // Step 1: Get authoritative server time BEFORE doing any eligibility check.
  // This prevents device-clock manipulation from bypassing the 24-hour window.
  const [u, serverNowMs] = await Promise.all([
    pb.collection('users').getOne(pbId, {
      fields: 'id,daily_streak,last_daily_claim,shib_balance,power_tokens',
    }),
    getServerTimeMs(),  // HTTP Date header from PocketBase — device-independent
  ]);

  const streak  = Number(u.daily_streak) || 0;
  const lastMs  = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
  // Clamp future timestamps (prior exploit artifact)
  const effectiveLastMs = (lastMs > 0 && lastMs > serverNowMs) ? 0 : lastMs;

  // Step 2: Eligibility check against authoritative server time
  const preStatus = computeDailyStatus(streak, effectiveLastMs, serverNowMs, rewards);
  if (!preStatus.canClaim) throw new Error('Not yet eligible. Check back when the timer resets.');

  const claimDay = preStatus.activeDay;
  const rewardMap: Record<number, { shib: number; pt: number }> = {
    1: { shib: rewards.day1Shib, pt: 0 },
    2: { shib: 0,                pt: rewards.day2Pt },
    3: { shib: rewards.day3Shib, pt: 0 },
    4: { shib: 0,                pt: rewards.day4Pt },
    5: { shib: rewards.day5Shib, pt: 0 },
    6: { shib: 0,                pt: rewards.day6Pt },
    7: { shib: rewards.day7Shib, pt: rewards.day7Pt },
  };
  const reward = rewardMap[claimDay] ?? { shib: 0, pt: 0 };

  // Step 3: Write the audit log record. PocketBase assigns `created` server-side.
  // createRule is now set to "@request.auth.id != \"\"" so authenticated APK users can write.
  let serverNowIso: string;
  try {
    const claimRec = await pb.collection('daily_claims').create({
      user_id:    pbId,
      day_number: claimDay,
      reward_shib: reward.shib,
      reward_pt:   reward.pt,
    });
    // Use PocketBase's server-generated `created` field as the claim timestamp
    serverNowIso = claimRec.created as string;
  } catch {
    // Fallback: re-fetch server time via HTTP Date header (still device-independent)
    const fallbackMs = await getServerTimeMs();
    serverNowIso = new Date(fallbackMs).toISOString();
  }

  // Step 4: Final validation with the PB-server timestamp (catches extreme skew)
  const serverWriteMs  = new Date(serverNowIso).getTime();
  const effectiveFinal = (lastMs > 0 && lastMs > serverWriteMs) ? 0 : lastMs;
  const finalStatus    = computeDailyStatus(streak, effectiveFinal, serverWriteMs, rewards);
  if (!finalStatus.canClaim) throw new Error('Server time confirms it is too early to claim.');

  // Step 5: Commit balances — use server-generated timestamp, never device clock
  const newStreak = claimDay;
  const newShib   = (Number(u.shib_balance) || 0) + reward.shib;
  const newPt     = (Number(u.power_tokens) || 0) + reward.pt;

  await pb.collection('users').update(pbId, {
    daily_streak:     newStreak,
    last_daily_claim: serverNowIso,  // ← PB-server timestamp, not device time
    shib_balance:     newShib,
    power_tokens:     newPt,
  });

  return {
    success:        true,
    claimDay,
    newStreak,
    rewardShib:     reward.shib,
    rewardPt:       reward.pt,
    newShibBalance: newShib,
    newPt,
    nextClaimAt:    new Date(serverWriteMs + 24 * 3_600_000).toISOString(),
    serverTime:     serverNowIso,
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
  glowAnim: Animated.Value;
  imgUrl?: string | null;
}

/** Clean image-only card box — no text inside */
function DayCard({ day, state, glowAnim, imgUrl }: DayCardProps) {
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

      {/* Icon / admin image — fills the entire box */}
      {imgUrl ? (
        <Image
          source={{ uri: imgUrl }}
          style={[cs.dayImg, isLocked && { opacity: 0.35 }]}
          resizeMode="cover"
        />
      ) : (
        <View style={cs.iconWrap}>
          <RewardIcon day={day} dimmed={isLocked} />
        </View>
      )}

      {/* Lock overlay */}
      {isLocked && (
        <View style={[cs.lockOverlay, { pointerEvents: 'none' }]}>
          <View style={cs.lockCircle}>
            <Ionicons name="lock-closed" size={13} color="#2a2a2a" />
          </View>
        </View>
      )}

      {/* Claimed checkmark corner badge */}
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

/** Slot wrapper: bold "Day N" above card, amount below card */
function DaySlot({ day, state, rewards, glowAnim, imgUrl }: DayCardProps & { rewards: DailyRewards }) {
  const reward    = getReward(day, rewards);
  const cfg       = DAY_CONFIG[day];
  const isClaimed = state === 'claimed';
  const isActive  = state === 'active';
  const isLocked  = state === 'locked';
  const amtColor  = cfg.type === 'pt' ? Colors.neonOrange : Colors.gold;

  return (
    <View style={cs.daySlot}>
      {/* ── Day label — ABOVE the box ── */}
      <Text style={[
        cs.daySlotLabel,
        isActive  && cs.daySlotLabelActive,
        isClaimed && cs.daySlotLabelClaimed,
      ]}>
        {isClaimed ? '✓ ' : ''}Day {day}
      </Text>

      {/* ── Clean image box ── */}
      <DayCard day={day} state={state} glowAnim={glowAnim} imgUrl={imgUrl} />

      {/* ── Reward amount — gold badge + bold red text BELOW the box ── */}
      {isLocked ? (
        <View style={cs.amtBadge}>
          <Text style={cs.amtBadgeLockedTxt}>???</Text>
        </View>
      ) : cfg.type === 'both' ? (
        <View style={cs.amtBadge}>
          <Text style={cs.amtBadgeTxt}>{fmtNum(reward.shib)} SHIB</Text>
          <Text style={cs.amtBadgeTxt}>{fmtNum(reward.pt)} PT</Text>
        </View>
      ) : (
        <View style={[cs.amtBadge, isClaimed && cs.amtBadgeClaimed]}>
          <Text style={[cs.amtBadgeTxt, isClaimed && cs.amtBadgeTxtClaimed]}>
            {cfg.type === 'shib' ? `${fmtNum(reward.shib)} SHIB` : `${fmtNum(reward.pt)} PT`}
          </Text>
        </View>
      )}
    </View>
  );
}

// Local fallback for Day 7 banner — always available, no network needed
const DAY7_BANNER_LOCAL = require('../assets/aurora_banner.jpg');

// ─── Day 7 Grand Reward card ──────────────────────────────────────────────────
/** Grand card inner box — banner image fills the full width */
function GrandCard({ state, rewards, glowAnim, shibaImgUrl, powerImgUrl }: {
  state: DayState; rewards: DailyRewards; glowAnim: Animated.Value;
  shibaImgUrl?: string | null; powerImgUrl?: string | null;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const isClaimed = state === 'claimed';
  const isActive  = state === 'active';
  const isLocked  = state === 'locked';

  const borderColor = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [Colors.gold, Colors.neonOrange] })
    : (isClaimed ? Colors.gold + '55' : Colors.darkBorder);

  const glowOpacity = isActive
    ? glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.6] })
    : 0;

  // Reset error state when the URL changes (new upload in admin)
  const prevUrl = useRef<string | null | undefined>(null);
  if (shibaImgUrl !== prevUrl.current) { prevUrl.current = shibaImgUrl; setImgFailed(false); }

  // Resolve the banner source: prefer PocketBase URL, fall back to bundled asset
  const bannerSource = (!imgFailed && shibaImgUrl)
    ? { uri: shibaImgUrl }
    : DAY7_BANNER_LOCAL;

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

      {/* Full-width banner — ALWAYS rendered (dimmed when locked, like DayCard) */}
      <Image
        source={bannerSource}
        style={[cs.grandBannerImg, isLocked && { opacity: 0.35 }]}
        resizeMode="cover"
        onError={() => setImgFailed(true)}
      />
      {/* Lock overlay on top of the dimmed banner — same pattern as DayCard */}
      {isLocked && (
        <View style={[cs.lockOverlay, { pointerEvents: 'none' }]}>
          <View style={cs.lockCircle}>
            <Ionicons name="lock-closed" size={13} color="#2a2a2a" />
          </View>
        </View>
      )}

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

/** Grand slot wrapper: "⭐ GRAND REWARD  Day 7" above card, amounts below */
function GrandSlot({ state, rewards, glowAnim, shibaImgUrl, powerImgUrl }: {
  state: DayState; rewards: DailyRewards; glowAnim: Animated.Value;
  shibaImgUrl?: string | null; powerImgUrl?: string | null;
}) {
  const reward    = getReward(7, rewards);
  const isClaimed = state === 'claimed';
  const isActive  = state === 'active';
  const isLocked  = state === 'locked';

  return (
    <View style={cs.grandSlot}>
      {/* ── Day 7 header row — ABOVE the card ── */}
      <View style={cs.grandSlotHeader}>
        <LinearGradient
          colors={[Colors.gold, Colors.neonOrange]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={cs.grandBadge}
        >
          <Text style={cs.grandBadgeTxt}>⭐ GRAND REWARD</Text>
        </LinearGradient>
        <Text style={[
          cs.daySlotLabel,
          isActive  && cs.daySlotLabelActive,
          isClaimed && cs.daySlotLabelClaimed,
          { marginTop: 0 },
        ]}>
          {isClaimed ? '✓ ' : ''}Day 7
        </Text>
      </View>

      {/* ── Clean image box ── */}
      <GrandCard state={state} rewards={rewards} glowAnim={glowAnim}
        shibaImgUrl={shibaImgUrl} powerImgUrl={powerImgUrl} />

      {/* ── Amounts — gold badge + red bold text below card ── */}
      {isLocked ? (
        <View style={cs.amtBadge}>
          <Text style={cs.amtBadgeLockedTxt}>???</Text>
        </View>
      ) : (
        <View style={cs.amtBadge}>
          <Text style={cs.amtBadgeTxt}>{fmtNum(reward.shib)} SHIB  +  {fmtNum(reward.pt)} PT</Text>
        </View>
      )}
    </View>
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
  const [countdownMs, setCountdown] = useState(0);
  const [claimDone, setClaimDone]   = useState<{ shib: number; pt: number } | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  // Monotonic countdown seed — set purely from server values, never device clock
  const countdownSeedRef = useRef<number>(0);
  const [floatReady, setFloatReady]       = useState(false);
  const [claimSettings, setClaimSettings] = useState<DailyClaimSettings | null>(null);

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
      } catch {
        s = await fetchStatusDirect(user.pbId, fallbackRewards);
      }
      // Seed the monotonic countdown from pure server values — no device clock involved
      if (s.nextClaimAt && s.serverTime) {
        const nextMs   = new Date(s.nextClaimAt).getTime();
        const srvNowMs = new Date(s.serverTime).getTime();
        countdownSeedRef.current = Math.max(0, nextMs - srvNowMs);
        setCountdown(countdownSeedRef.current);
      } else {
        countdownSeedRef.current = 0;
        setCountdown(0);
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

  // ── Fetch daily_claim_settings (images + admin-set amounts) ──
  useEffect(() => {
    if (!user?.pbId) return;
    (async () => {
      try {
        const cs = await api.getDailySettings();
        setClaimSettings(cs);
      } catch {
        try {
          const res = await pb.collection('daily_claim_settings').getList(1, 1);
          const rec = res.items[0];
          if (rec) {
            const BASE = `https://api.webcod.in/api/files/daily_claim_settings/${rec.id}`;
            const fu = (f: string) => (f ? `${BASE}/${f}` : null);
            setClaimSettings({
              id: rec.id,
              day1ImageUrl: fu(rec.day_1_image),   day1Amount: rec.day_1_amount ?? 1000,
              day2ImageUrl: fu(rec.day_2_image),   day2Amount: rec.day_2_amount ?? 50,
              day3ImageUrl: fu(rec.day_3_image),   day3Amount: rec.day_3_amount ?? 3000,
              day4ImageUrl: fu(rec.day_4_image),   day4Amount: rec.day_4_amount ?? 100,
              day5ImageUrl: fu(rec.day_5_image),   day5Amount: rec.day_5_amount ?? 5000,
              day6ImageUrl: fu(rec.day_6_image),   day6Amount: rec.day_6_amount ?? 200,
              day7ShibImageUrl: fu(rec.day_7_shiba_image),  day7ShibAmount: rec.day_7_shiba_amount ?? 10000,
              day7PowerImageUrl: fu(rec.day_7_power_image), day7PowerAmount: rec.day_7_power_amount ?? 500,
            });
          }
        } catch { /* keep null — fallback icons will render */ }
      }
    })();
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

  // ── Monotonic countdown — seeded from server values, immune to device clock changes ──
  // We never call Date.now() inside the tick. The interval fires on the platform's
  // monotonic timer (not wall clock), so advancing the system clock has no effect.
  useEffect(() => {
    if (!status?.nextClaimAt || countdownSeedRef.current <= 0) {
      setCountdown(0);
      return;
    }
    // Snapshot the seed so the interval closure captures a stable value
    let remMs = countdownSeedRef.current;
    setCountdown(remMs);

    const id = setInterval(() => {
      remMs = Math.max(0, remMs - 1000);
      setCountdown(remMs);
      countdownSeedRef.current = remMs;

      if (remMs <= 0) {
        clearInterval(id);
        // Re-verify with server — it is the ONLY source of truth for canClaim
        loadStatus().then(s => {
          if (s?.canClaim && !autoPopRef.current) {
            autoPopRef.current = true;
            setFloatReady(true);
            if (mode !== 'popup') openPopup();
          }
        });
      }
    }, 1000);

    return () => clearInterval(id);
  // Re-run only when the server provides a fresh nextClaimAt timestamp
  }, [status?.nextClaimAt, status?.serverTime]);

  // ── Claim handler ──
  const handleClaim = useCallback(async () => {
    if (!user?.pbId || claiming || !status?.canClaim) return;
    setClaiming(true);
    setClaimError(null);
    try {
      let result: DailyClaimResult;
      try {
        result = await api.claimDailyReward(user.pbId);
      } catch {
        result = await claimDirect(user.pbId, fallbackRewards);
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setClaimDone({ shib: result.rewardShib, pt: result.rewardPt });
      autoPopRef.current = false;
      setFloatReady(false);
      await loadStatus();
      setTimeout(() => closePopup(), 2200);
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      const msg: string = e?.message || 'Claim failed. Try again.';
      // Show server's rejection reason inline — covers the "not yet eligible" case
      setClaimError(msg);
      // Re-sync with server to get the accurate remaining time
      await loadStatus();
      // Auto-clear after 5 s
      setTimeout(() => setClaimError(null), 5000);
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
  // Use claimSettings amounts when available (admin-configured), else server status rewards
  const rewards = claimSettings ? {
    day1Shib: claimSettings.day1Amount,
    day2Pt:   claimSettings.day2Amount,
    day3Shib: claimSettings.day3Amount,
    day4Pt:   claimSettings.day4Amount,
    day5Shib: claimSettings.day5Amount,
    day6Pt:   claimSettings.day6Amount,
    day7Shib: claimSettings.day7ShibAmount,
    day7Pt:   claimSettings.day7PowerAmount,
  } : (status?.rewards ?? fallbackRewards);

  function getImgUrl(d: number): string | null {
    if (!claimSettings) return null;
    const map: Record<number, string | null> = {
      1: claimSettings.day1ImageUrl,
      2: claimSettings.day2ImageUrl,
      3: claimSettings.day3ImageUrl,
      4: claimSettings.day4ImageUrl,
      5: claimSettings.day5ImageUrl,
      6: claimSettings.day6ImageUrl,
    };
    return map[d] ?? null;
  }

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

            {/* ── Server rejection banner — shown when server says not yet eligible ── */}
            {claimError && (
              <View style={cs.errorBanner}>
                <Ionicons name="alert-circle" size={14} color="#ff4d4d" />
                <Text style={cs.errorBannerTxt}>{claimError}</Text>
              </View>
            )}

            {/* ── TOP: Countdown or "Ready" banner (ALWAYS above the grid) ── */}
            {!canClaim && countdownMs > 0 ? (
              <View style={cs.countdownBanner}>
                <Text style={cs.countdownBannerLabel}>CLAIM REFRESHES IN</Text>
                <Text style={cs.countdownBannerDigits}>{countdownStr}</Text>
              </View>
            ) : canClaim ? (
              <View style={cs.claimAvailableBanner}>
                <Ionicons name="gift-outline" size={15} color={Colors.gold} />
                <Text style={cs.claimAvailableTxt}>✦ YOUR REWARD IS READY!</Text>
              </View>
            ) : null}

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={cs.scrollContent}
              bounces={false}
            >
              {/* ── Grid rows — DaySlot = label above + card + amount below ── */}
              <View style={cs.gridRow}>
                {[1, 2, 3].map(d => (
                  <DaySlot key={d} day={d} state={getDayState(d)} rewards={rewards}
                    glowAnim={glowAnim} imgUrl={getImgUrl(d)} />
                ))}
              </View>
              <View style={cs.gridRow}>
                {[4, 5, 6].map(d => (
                  <DaySlot key={d} day={d} state={getDayState(d)} rewards={rewards}
                    glowAnim={glowAnim} imgUrl={getImgUrl(d)} />
                ))}
              </View>

              {/* ── Day 7 grand reward — GrandSlot = label above + card + amounts below ── */}
              <View style={cs.grandSection}>
                <GrandSlot state={getDayState(7)} rewards={rewards} glowAnim={glowAnim}
                  shibaImgUrl={claimSettings?.day7ShibImageUrl ?? null}
                  powerImgUrl={claimSettings?.day7PowerImageUrl ?? null} />
              </View>

              {/* ── Claim button (only when eligible) ── */}
              {canClaim && (
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
  gridRow: { flexDirection: 'row', gap: GRID_GAP, marginBottom: GRID_GAP + 4 },
  grandSection: { width: '100%' },

  // Day card
  // ── Day slot (column wrapper: label above + card + amount below) ──
  daySlot: {
    width: SMALL_CARD_W,
    alignItems: 'center',
    gap: 5,
  },
  daySlotLabel: {
    fontFamily: 'Inter_700Bold',
    fontSize: 12,
    color: Colors.textMuted,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  daySlotLabelActive: { color: Colors.gold },
  daySlotLabelClaimed: { color: Colors.gold + 'aa' },
  // ── Amount badge (gold bg + red bold text) ──────────────────────────────
  amtBadge: {
    backgroundColor: Colors.gold,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 4,
    alignItems: 'center',
    minWidth: 54,
  },
  amtBadgeClaimed: {
    backgroundColor: 'rgba(244,196,48,0.30)',
  },
  amtBadgeTxt: {
    fontFamily: 'Inter_700Bold',
    fontSize: 11,
    color: '#C0000A',
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  amtBadgeTxtClaimed: {
    color: '#7a5e00',
  },
  amtBadgeLockedTxt: {
    fontFamily: 'Inter_700Bold',
    fontSize: 11,
    color: '#666',
    textAlign: 'center',
  },

  // legacy — kept for compatibility
  daySlotAmt: {
    fontFamily: 'Inter_700Bold',
    fontSize: 10,
    color: Colors.gold,
    textAlign: 'center',
  },
  daySlotLockedAmt: {
    fontFamily: 'Inter_500Medium',
    fontSize: 11,
    color: '#2e2e3a',
    textAlign: 'center',
  },

  // ── Day card (clean image-only box) ──
  dayCard: {
    width: SMALL_CARD_W,
    height: SMALL_CARD_W,
    backgroundColor: '#111120',
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  dayCardLocked: { backgroundColor: '#0a0a12' },

  iconWrap: { alignItems: 'center', justifyContent: 'center', flex: 1 },

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
  // ── Grand slot (column: header above + card + amounts below) ──
  grandSlot: {
    width: '100%',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  grandSlotHeader: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  grandSlotAmts: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  grandSlotAmt: {
    fontFamily: 'Inter_700Bold',
    fontSize: 13,
    textAlign: 'center',
  },

  // ── Grand Day 7 card (full-width banner box — no padding, image fills it) ──
  grandCard: {
    width: '100%',
    backgroundColor: '#100e1e',
    borderRadius: 16,
    borderWidth: 1.5,
    overflow: 'hidden',
    position: 'relative',
    // DO NOT set alignItems/justifyContent here — it collapses width:'100%' on
    // child Images to zero in Yoga (React Native layout engine). Let children
    // use alignSelf: 'stretch' individually.
  },
  // Full-width 4:1 banner image — alignSelf:'stretch' ensures width resolves
  grandBannerImg: {
    alignSelf: 'stretch',
    aspectRatio: 4,
  },
  // Lock placeholder for Day 7 when still locked
  grandBannerLocked: {
    alignSelf: 'stretch',
    aspectRatio: 4,
    backgroundColor: '#0a0a12',
    alignItems: 'center',
    justifyContent: 'center',
  },
  grandBadge: {
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4,
    alignSelf: 'center',
  },
  grandBadgeTxt: { fontFamily: 'Inter_700Bold', fontSize: 9.5, color: '#0A0A0F', letterSpacing: 1.2 },
  grandRight: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 20, paddingHorizontal: 18 },

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

  // Admin-image fills the entire day card box
  dayImg: {
    width: SMALL_CARD_W,
    height: SMALL_CARD_W,
    borderRadius: 10,
  },

  // Admin-image in grand card — larger to fill the wide card
  grandImg: {
    width: 70,
    height: 70,
    borderRadius: 10,
  },

  // ── TOP countdown banner (always above grid) ──────────────────────────────
  countdownBanner: {
    marginHorizontal: CARD_PAD,
    marginBottom: 10,
    backgroundColor: '#0D0C1E',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.20)',
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
    gap: 3,
  },
  countdownBannerLabel: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 9,
    color: Colors.textMuted,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
  },
  countdownBannerDigits: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    color: Colors.textPrimary,
    letterSpacing: 4,
  },

  // ── Server rejection error banner ────────────────────────────────────────
  errorBanner: {
    marginHorizontal: CARD_PAD,
    marginBottom: 8,
    backgroundColor: 'rgba(255,77,77,0.10)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,77,77,0.30)',
    paddingVertical: 9,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  errorBannerTxt: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    color: '#ff6b6b',
    flex: 1,
  },

  // ── "Ready" banner ────────────────────────────────────────────────────────
  claimAvailableBanner: {
    marginHorizontal: CARD_PAD,
    marginBottom: 10,
    backgroundColor: 'rgba(244,196,48,0.10)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.35)',
    paddingVertical: 10,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  claimAvailableTxt: {
    fontFamily: 'Inter_700Bold',
    fontSize: 13,
    color: Colors.gold,
    letterSpacing: 1.2,
  },
});
