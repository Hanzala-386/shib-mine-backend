import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, Platform, Animated, Easing, Pressable,
  ActivityIndicator, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { getApiUrl } from '@/lib/query-client';
import { POCKETBASE_URL, pb } from '@/lib/pocketbase';
import { BANNER_HEIGHT } from '@/components/StickyBannerAd';
import SpinningCoin from '@/components/SpinningCoin';
import { useTournament, type TournamentEntry } from '@/context/TournamentContext';
import Colors from '@/constants/colors';

/* ── types ── */
interface LeaderEntry {
  rank: number;
  id: string;
  displayName: string;
  shibBalance: number;
}
interface MyRank {
  rank: number;
  id: string;
  displayName: string;
  shibBalance: number;
}
interface TickerItem {
  id: string;
  maskedName: string;
  method: string;
  amount: number;
}

/* ── helpers ── */
function formatShib(val: number) {
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(0)}K`;
  return val.toLocaleString();
}

/* ── Tournament countdown component ────────────────────────────────────── */
const WEEK_MS   = 7 * 24 * 60 * 60 * 1000;
const pad2      = (n: number) => String(n).padStart(2, '0');

function TournamentCountdown({ weekStart }: { weekStart: string }) {
  const endMs = new Date(weekStart).getTime() + WEEK_MS;

  const calc = () => {
    const diff = Math.max(0, endMs - Date.now());
    return {
      days:    Math.floor(diff / 86_400_000),
      hours:   Math.floor((diff % 86_400_000) / 3_600_000),
      minutes: Math.floor((diff % 3_600_000) / 60_000),
      seconds: Math.floor((diff % 60_000) / 1_000),
    };
  };

  const [time, setTime] = useState(calc);

  useEffect(() => {
    setTime(calc());
    const id = setInterval(() => setTime(calc()), 1000);
    return () => clearInterval(id);
  }, [weekStart]);

  return (
    <View style={cdStyles.wrap}>
      <View style={cdStyles.labelRow}>
        <MaterialCommunityIcons name="timer-outline" size={13} color={Colors.gold} />
        <Text style={cdStyles.labelText}>RESETS IN</Text>
      </View>
      <View style={cdStyles.digitRow}>
        <View style={cdStyles.block}>
          <Text style={cdStyles.digit}>{time.days}</Text>
          <Text style={cdStyles.unit}>Days</Text>
        </View>
        <Text style={cdStyles.colon}>:</Text>
        <View style={cdStyles.block}>
          <Text style={cdStyles.digit}>{pad2(time.hours)}</Text>
          <Text style={cdStyles.unit}>Hours</Text>
        </View>
        <Text style={cdStyles.colon}>:</Text>
        <View style={cdStyles.block}>
          <Text style={cdStyles.digit}>{pad2(time.minutes)}</Text>
          <Text style={cdStyles.unit}>Mins</Text>
        </View>
        <Text style={cdStyles.colon}>:</Text>
        <View style={cdStyles.block}>
          <Text style={cdStyles.digit}>{pad2(time.seconds)}</Text>
          <Text style={cdStyles.unit}>Secs</Text>
        </View>
      </View>
    </View>
  );
}

const cdStyles = StyleSheet.create({
  wrap: {
    marginBottom: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(244,196,48,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.18)',
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 8 },
  labelText: { fontFamily: 'Inter_700Bold', fontSize: 9, color: Colors.gold, letterSpacing: 1.5, textTransform: 'uppercase' },
  digitRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  block:     { alignItems: 'center', minWidth: 56 },
  digit:     { fontFamily: 'Inter_700Bold', fontSize: 30, color: Colors.gold, lineHeight: 34 },
  colon:     { fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.gold, opacity: 0.5, marginBottom: 14 },
  unit:      { fontFamily: 'Inter_400Regular', fontSize: 9, color: Colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 2 },
});

async function fetchJson(path: string) {
  const url = new URL(path, getApiUrl());
  const r = await globalThis.fetch(url.toString());
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ── PocketBase direct fallback for when Express backend is unreachable ── */
async function fetchLeaderboard(): Promise<LeaderEntry[]> {
  try {
    return await fetchJson('/api/app/leaderboard');
  } catch {
    try {
      const res = await pb.collection('users').getList(1, 100, {
        sort: '-shib_balance',
        fields: 'id,display_name,shib_balance',
      });
      return (res.items || []).map((u: any, i: number) => {
        let name: string = u.display_name || 'Miner';
        if (name.includes('@')) name = name.split('@')[0];
        return { rank: i + 1, id: u.id, displayName: name, shibBalance: u.shib_balance || 0 };
      });
    } catch {
      return [];
    }
  }
}

async function fetchMyRank(pbId: string): Promise<MyRank | undefined> {
  try {
    return await fetchJson(`/api/app/leaderboard/rank/${pbId}`);
  } catch {
    try {
      const res = await pb.collection('users').getList(1, 500, {
        sort: '-shib_balance',
        fields: 'id,display_name,shib_balance',
      });
      const items = res.items || [];
      const idx = items.findIndex((u: any) => u.id === pbId);
      if (idx < 0) return undefined;
      const u = items[idx];
      return { rank: idx + 1, id: u.id, displayName: u.display_name || 'Miner', shibBalance: u.shib_balance || 0 };
    } catch {
      return undefined;
    }
  }
}

/* ── Ticker marquee ── */
const ITEM_W = 230;
const TICKER_H = 46;
const TICKER_TOTAL_H = TICKER_H + 28;

function WithdrawalTicker({ items }: { items: TickerItem[] }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const quadrupled = [...items, ...items, ...items, ...items];
  const stopped = useRef(false);

  useEffect(() => {
    if (!items.length) return;
    stopped.current = false;
    const totalW = items.length * ITEM_W;

    function runCycle() {
      if (stopped.current) return;
      translateX.setValue(0);
      Animated.timing(translateX, {
        toValue: -totalW,
        duration: totalW * 30,
        easing: Easing.linear,
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished && !stopped.current) runCycle();
      });
    }
    runCycle();
    return () => { stopped.current = true; translateX.stopAnimation(); };
  }, [items.length]);

  if (!items.length) {
    return (
      <View style={tickerStyles.emptyBox}>
        <Text style={tickerStyles.emptyText}>No approved withdrawals yet</Text>
      </View>
    );
  }

  return (
    <View style={tickerStyles.wrapper}>
      <View style={tickerStyles.labelWrap}>
        <MaterialCommunityIcons name="bank-transfer" size={13} color={Colors.gold} />
        <Text style={tickerStyles.label}>LIVE WITHDRAWALS</Text>
      </View>
      <View style={tickerStyles.track}>
        <Animated.View style={[tickerStyles.row, { transform: [{ translateX }] }]}>
          {quadrupled.map((item, i) => (
            <View key={`${item.id}-${i}`} style={[tickerStyles.chip]}>
              <Text style={tickerStyles.name}>{item.maskedName}</Text>
              <View style={tickerStyles.dot} />
              <Text style={tickerStyles.method}>{item.method === 'Binance Email' ? 'Email' : 'BEP-20'}</Text>
              <View style={tickerStyles.dot} />
              <Text style={tickerStyles.amount}>+{formatShib(item.amount)} SHIB</Text>
            </View>
          ))}
        </Animated.View>
      </View>
    </View>
  );
}

const tickerStyles = StyleSheet.create({
  wrapper: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(244,196,48,0.15)',
    backgroundColor: 'rgba(244,196,48,0.04)',
    paddingVertical: 4,
  },
  labelWrap: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 16, paddingBottom: 4 },
  label:     { fontFamily: 'Inter_700Bold', fontSize: 9, color: Colors.gold, letterSpacing: 1.5, textTransform: 'uppercase' },
  track:     { height: TICKER_H, overflow: 'hidden' },
  row:       { flexDirection: 'row', alignItems: 'center', height: TICKER_H },
  chip:      { width: ITEM_W, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: TICKER_H },
  name:      { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textPrimary },
  method:    { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary },
  amount:    { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#4CAF50' },
  dot:       { width: 4, height: 4, borderRadius: 2, backgroundColor: Colors.textMuted },
  emptyBox:  { height: TICKER_H + 22, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
});

/* ── All-Time Rank row ── */
function RankRow({ entry }: { entry: LeaderEntry }) {
  const isFirst  = entry.rank === 1;
  const isSecond = entry.rank === 2;
  const isThird  = entry.rank === 3;
  const isPodium = entry.rank <= 3;

  const rankColor = isFirst ? Colors.gold : isSecond ? '#C0C0C0' : isThird ? '#CD7F32' : Colors.textMuted;
  const cardBg    = isFirst ? 'rgba(244,196,48,0.10)' : isSecond ? 'rgba(192,192,192,0.07)' : isThird ? 'rgba(205,127,50,0.07)' : 'transparent';
  const borderCol = isFirst ? 'rgba(244,196,48,0.28)' : isSecond ? 'rgba(192,192,192,0.18)' : isThird ? 'rgba(205,127,50,0.18)' : Colors.darkBorder;

  return (
    <View style={[rowStyles.row, { backgroundColor: cardBg, borderColor: borderCol }]}>
      <View style={[rowStyles.rankWrap, isPodium && { minWidth: 38 }]}>
        {isFirst ? (
          <View style={rowStyles.crownWrap}>
            <MaterialCommunityIcons name="crown" size={18} color={Colors.gold} />
            <Text style={[rowStyles.rankNum, { color: Colors.gold, fontSize: 11 }]}>1</Text>
          </View>
        ) : (
          <Text style={[rowStyles.rankNum, { color: rankColor }]}>#{entry.rank}</Text>
        )}
      </View>
      <View style={[rowStyles.avatar, isPodium && { borderColor: rankColor + '60', borderWidth: 2 }]}>
        <Text style={rowStyles.avatarText}>{entry.displayName.slice(0, 2).toUpperCase()}</Text>
      </View>
      <Text style={[rowStyles.name, isFirst && rowStyles.nameGold]} numberOfLines={1}>
        {entry.displayName}
      </Text>
      <View style={rowStyles.balanceWrap}>
        <Text style={[rowStyles.balance, { color: rankColor }]}>{formatShib(entry.shibBalance)}</Text>
        <Text style={rowStyles.balanceSub}>SHIB</Text>
      </View>
    </View>
  );
}

/* ══ TOURNAMENT GAMING UI ════════════════════════════════════════════════ */

// Deterministic avatar color from user ID — consistent per user, no server call needed
const AV_COLORS = [
  '#FF6B00', '#F4C430', '#00C853', '#2979FF',
  '#E040FB', '#FF3B30', '#00BCD4', '#FF8F00',
  '#76FF03', '#FFEA00',
];
function avatarColor(id: string): string {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = (((h << 5) + h) ^ id.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

// Circular initials avatar with deterministic neon ring
function TAvatar({ name, id, size = 52, uri }: { name: string; id: string; size?: number; uri?: string }) {
  const color = avatarColor(id);
  if (uri) {
    return (
      <View style={{
        width: size, height: size, borderRadius: size / 2,
        overflow: 'hidden',
        backgroundColor: color + '22',
        borderWidth: 2, borderColor: color,
      }}>
        <Image
          source={{ uri }}
          style={{ width: size, height: size }}
          resizeMode="cover"
        />
      </View>
    );
  }
  return (
    <View style={{
      width: size, height: size, borderRadius: size / 2,
      backgroundColor: color + '22', borderWidth: 2, borderColor: color,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Text style={{ fontFamily: 'Inter_700Bold', fontSize: Math.round(size * 0.30), color }}>
        {name.slice(0, 2).toUpperCase()}
      </Text>
    </View>
  );
}

// Podium meta: rendered left→right as [2nd, 1st, 3rd]
const POD = [
  { rank: 2, size: 58, ringColor: '#A8A8A8', labelColor: '#C8C8C8', label: '🥈', center: false },
  { rank: 1, size: 76, ringColor: Colors.gold,  labelColor: Colors.gold,  label: '👑', center: true  },
  { rank: 3, size: 58, ringColor: '#B87333',     labelColor: '#CD7F32',    label: '🥉', center: false },
] as const;

function TournamentPodium({ top3, pbId }: { top3: TournamentEntry[]; pbId: string }) {
  return (
    <View style={podStyles.row}>
      {POD.map(({ rank, size, ringColor, labelColor, label, center }) => {
        const entry = top3.find(e => e.rank === rank);
        const isMe  = !!entry && entry.id === pbId;
        return (
          <View key={rank} style={[podStyles.col, center && podStyles.colCenter]}>

            {/* Crown above #1, medal emoji for #2 #3 */}
            <Text style={[podStyles.medal, { fontSize: center ? 26 : 20 }]}>{label}</Text>

            {/* Glowing avatar ring */}
            <View style={[
              podStyles.ring,
              { width: size + 8, height: size + 8, borderRadius: (size + 8) / 2, borderColor: ringColor },
              isMe && podStyles.ringMe,
            ]}>
              {entry
                ? <TAvatar name={entry.displayName} id={entry.id} size={size} uri={entry.avatarUrl} />
                : <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: ringColor + '12' }} />
              }
            </View>

            {/* Rank pill */}
            <View style={[podStyles.pill, { backgroundColor: labelColor + '18', borderColor: labelColor + '50' }]}>
              <Text style={[podStyles.pillText, { color: labelColor }]}>#{rank}</Text>
            </View>

            {/* Username */}
            <Text style={podStyles.podName} numberOfLines={1}>
              {entry?.displayName ?? `${rank === 1 ? '1st' : rank === 2 ? '2nd' : '3rd'} Place`}
            </Text>

            {/* Points */}
            <Text style={[podStyles.podPts, { color: labelColor }]}>
              {entry ? `${formatShib(entry.points)} pts` : '—'}
            </Text>

            {/* Expected prize for this rank — configured by admin in reward_structure */}
            {entry && entry.prize > 0 ? (
              <Text style={[podStyles.podPrize, { color: labelColor }]}>
                🏆 {formatShib(entry.prize)} SHIB
              </Text>
            ) : (
              <Text style={podStyles.podPrizeDash}>—</Text>
            )}

          </View>
        );
      })}
    </View>
  );
}

const podStyles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center',
    paddingTop: 8, paddingBottom: 24, paddingHorizontal: 8, gap: 6,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
    marginBottom: 12,
  },
  col:       { flex: 1, alignItems: 'center', gap: 5 },
  // colCenter raises #1 above #2 and #3 — row uses alignItems:'flex-end' baseline
  colCenter: { marginBottom: 28 },
  medal:     { lineHeight: 30 },
  ring:      { borderWidth: 2.5, alignItems: 'center', justifyContent: 'center' },
  ringMe:    { borderColor: Colors.gold, borderWidth: 3 },
  pill:      { borderRadius: 20, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 2 },
  pillText:  { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 0.5 },
  podName:      { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.textPrimary, textAlign: 'center', maxWidth: 96 },
  podPts:       { fontFamily: 'Inter_700Bold', fontSize: 11, textAlign: 'center' },
  podPrize:     { fontFamily: 'Inter_600SemiBold', fontSize: 10, textAlign: 'center', opacity: 0.9 },
  podPrizeDash: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted, textAlign: 'center' },
});

/* ── Rank card for positions 4 and below ────────────────────────────────── */
function TCard({ entry, isMe }: { entry: TournamentEntry; isMe: boolean }) {
  return (
    <View style={[tcardStyles.card, isMe && tcardStyles.cardMe]}>
      {/* Rank number */}
      <Text style={[tcardStyles.rank, isMe && { color: Colors.gold }]}>#{entry.rank}</Text>

      {/* Avatar — real image if PB avatar exists, else initials */}
      <TAvatar name={entry.displayName} id={entry.id} size={40} uri={entry.avatarUrl} />

      {/* Username */}
      <View style={tcardStyles.nameCol}>
        <Text style={[tcardStyles.name, isMe && { color: Colors.gold }]} numberOfLines={1}>
          {entry.displayName}{isMe ? ' (You)' : ''}
        </Text>
      </View>

      {/* Points */}
      <View style={tcardStyles.ptsCol}>
        <Text style={[tcardStyles.pts, isMe && { color: Colors.gold }]}>{formatShib(entry.points)}</Text>
        <Text style={tcardStyles.ptsUnit}>pts</Text>
      </View>

      {/* Expected winning coins — dynamic from admin reward_structure */}
      <View style={tcardStyles.prizeCol}>
        <Text style={[tcardStyles.prizeAmt, entry.prize > 0 && { color: Colors.gold }]}>
          {entry.prize > 0 ? formatShib(entry.prize) : '—'}
        </Text>
        {entry.prize > 0 && <Text style={tcardStyles.prizeUnit}>SHIB</Text>}
      </View>
    </View>
  );
}

const tcardStyles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 14, marginBottom: 6,
    paddingVertical: 11, paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderRadius: 16, borderWidth: 1, borderColor: Colors.darkBorder,
  },
  cardMe: {
    backgroundColor: 'rgba(244,196,48,0.08)',
    borderColor: 'rgba(244,196,48,0.45)',
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  rank:     { fontFamily: 'Inter_700Bold', fontSize: 15, color: Colors.textMuted, minWidth: 38, textAlign: 'center' },
  nameCol:  { flex: 1 },
  name:     { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textPrimary },
  prizeTag: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.neonOrange, marginTop: 2 },
  ptsCol:   { alignItems: 'flex-end' },
  pts:      { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#00C853' },
  ptsUnit:  { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted },
  prizeCol: { alignItems: 'flex-end', minWidth: 58 },
  prizeAmt: { fontFamily: 'Inter_700Bold', fontSize: 12, color: Colors.textMuted },
  prizeUnit:{ fontFamily: 'Inter_500Medium', fontSize: 9, color: Colors.gold + 'aa', marginTop: 1 },
});

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 10, paddingHorizontal: 14, marginHorizontal: 14, marginBottom: 4,
    borderRadius: 14, borderWidth: 1,
  },
  rankWrap:  { width: 36, alignItems: 'center' },
  crownWrap: { alignItems: 'center', gap: 0 },
  rankNum:   { fontFamily: 'Inter_700Bold', fontSize: 14 },
  avatar:    {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,107,0,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText:  { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.neonOrange },
  name:        { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textPrimary },
  nameGold:    { color: Colors.gold, fontFamily: 'Inter_700Bold' },
  balanceWrap: { alignItems: 'flex-end' },
  balance:     { fontFamily: 'Inter_700Bold', fontSize: 15 },
  balanceSub:  { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted },
});

/* ─── Tournament Join CTA ──────────────────────────────────────────────── */
function TournamentJoinCTA({ onJoin, joining }: { onJoin: () => void; joining: boolean }) {
  return (
    <View style={ctaStyles.wrap}>
      <MaterialCommunityIcons name="trophy-outline" size={64} color={Colors.gold} />
      <Text style={ctaStyles.title}>Weekly Tournament</Text>
      <Text style={ctaStyles.sub}>
        Compete against all miners this week! Your mining rewards count as tournament points.
        Top miners win bonus SHIB prizes.
      </Text>
      <Pressable
        onPress={onJoin}
        disabled={joining}
        style={({ pressed }) => [ctaStyles.btn, pressed && { opacity: 0.8 }]}
      >
        <LinearGradient
          colors={['#00C853', '#1B5E20']}
          style={ctaStyles.btnGrad}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        >
          {joining
            ? <ActivityIndicator size="small" color="#fff" />
            : <>
                <MaterialCommunityIcons name="trophy-award" size={18} color="#fff" />
                <Text style={ctaStyles.btnLabel}>JOIN TOURNAMENT</Text>
              </>
          }
        </LinearGradient>
      </Pressable>
      <Text style={ctaStyles.note}>Free to join. Registering doesn't cost any tokens.</Text>
    </View>
  );
}

const ctaStyles = StyleSheet.create({
  wrap:    { alignItems: 'center', paddingHorizontal: 32, paddingVertical: 40, gap: 14 },
  title:   { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary, textAlign: 'center' },
  sub:     { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  btn:     { width: '100%', borderRadius: 16, overflow: 'hidden' },
  btnGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 16 },
  btnLabel:{ fontFamily: 'Inter_700Bold', fontSize: 16, color: '#fff', letterSpacing: 1 },
  note:    { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, textAlign: 'center' },
});

/* ═══════════════════════════════════════════════════════════════════════════ */
export default function LeaderboardScreen() {
  const insets  = useSafeAreaInsets();
  const { pbUser } = useAuth();
  const pbId    = pbUser?.pbId ?? '';

  const [activeTab, setActiveTab] = useState<'alltime' | 'tournament'>('alltime');
  const [joining, setJoining]     = useState(false);

  const {
    config, userJoined, userPoints, leaderboard, leaderboardLoading,
    joinTournament, refreshLeaderboard,
  } = useTournament();

  // Load tournament leaderboard when switching to that tab
  useEffect(() => {
    if (activeTab === 'tournament') refreshLeaderboard();
  }, [activeTab]);

  const { data: board = [], isLoading: boardLoading } = useQuery<LeaderEntry[]>({
    queryKey: ['/api/app/leaderboard'],
    queryFn: fetchLeaderboard,
    staleTime: 60_000,
  });

  const { data: myRank } = useQuery<MyRank | undefined>({
    queryKey: ['/api/app/leaderboard/rank', pbId],
    queryFn: () => fetchMyRank(pbId),
    enabled: !!pbId,
    staleTime: 60_000,
  });

  const { data: ticker = [] } = useQuery<TickerItem[]>({
    queryKey: ['/api/app/withdrawals/approved/recent'],
    queryFn: async () => {
      try {
        const url = new URL('/api/app/withdrawals/approved/recent', getApiUrl()).href;
        const res = await globalThis.fetch(url);
        if (res.ok) return res.json();
      } catch {}
      try {
        const res = await pb.collection('withdrawals').getList(1, 10, {
          filter: 'status = "completed" || status = "approved"',
          sort: '-created',
          fields: 'id,masked_name,method,amount',
        });
        return (res.items || [])
          .filter((w: any) => w.masked_name)
          .map((w: any) => ({
            id: w.id,
            maskedName: w.masked_name as string,
            method: (w.method as string) || 'BEP-20',
            amount: (w.amount as number) || 0,
          }));
      } catch { return []; }
    },
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 60_000,
  });

  const topPad  = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const AD_TOTAL = Platform.OS === 'web' ? 0 : BANNER_HEIGHT + 16 + 8;
  const tabBarH  = Platform.OS === 'web' ? 84 : AD_TOTAL + 56 + insets.bottom;

  // Find my position in tournament leaderboard
  const myTournamentEntry = leaderboard.find(e => e.id === pbId);

  // ── My tournament stats card ─────────────────────────────────────────────
  const myTournamentCard = userJoined && (
    <View style={styles.myRankCard}>
      <LinearGradient
        colors={['rgba(0,200,83,0.15)', 'rgba(0,100,40,0.10)']}
        style={styles.myRankGradient}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      >
        <View style={styles.myRankLeft}>
          <Text style={styles.myRankLabel}>Your Position</Text>
          <Text style={[styles.myRankNum, { color: '#00C853' }]}>
            {myTournamentEntry ? `#${myTournamentEntry.rank}` : 'Unranked'}
          </Text>
          <Text style={styles.myRankName}>{pbUser?.displayName || 'Miner'}</Text>
        </View>
        <View style={styles.myRankRight}>
          <MaterialCommunityIcons name="sword-cross" size={18} color="#00C853" />
          <Text style={[styles.myRankBalance, { color: '#00C853', fontSize: 20 }]}>
            {formatShib(userPoints)}
          </Text>
          <Text style={styles.myRankShibLabel}>pts this week</Text>
        </View>
      </LinearGradient>
    </View>
  );

  // ── Header for FlatList ──────────────────────────────────────────────────
  const ListHeader = (
    <View style={{ paddingTop: topPad + 16, paddingHorizontal: 20, paddingBottom: 10 }}>
      {/* Page header */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.pageTitle}>Leaderboard</Text>
          <Text style={styles.pageSub}>
            {activeTab === 'alltime' ? 'Top 100 SHIB miners worldwide' : 'Weekly tournament rankings'}
          </Text>
        </View>
        <MaterialCommunityIcons
          name={activeTab === 'alltime' ? 'trophy' : 'sword-cross'}
          size={32}
          color={activeTab === 'alltime' ? Colors.gold : '#00C853'}
        />
      </View>

      {/* Tab switcher */}
      <View style={styles.tabRow}>
        <Pressable
          style={[styles.tabBtn, activeTab === 'alltime' && styles.tabBtnActive]}
          onPress={() => setActiveTab('alltime')}
        >
          <MaterialCommunityIcons
            name="trophy"
            size={14}
            color={activeTab === 'alltime' ? Colors.gold : Colors.textMuted}
          />
          <Text style={[styles.tabBtnText, activeTab === 'alltime' && styles.tabBtnTextActive]}>
            All Time
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabBtn, activeTab === 'tournament' && styles.tabBtnTournamentActive]}
          onPress={() => setActiveTab('tournament')}
        >
          <MaterialCommunityIcons
            name="sword-cross"
            size={14}
            color={activeTab === 'tournament' ? '#00C853' : Colors.textMuted}
          />
          <Text style={[
            styles.tabBtnText,
            activeTab === 'tournament' && styles.tabBtnTextTournament,
          ]}>
            Weekly
          </Text>
          {config?.is_active && (
            <View style={styles.liveDot} />
          )}
        </Pressable>
      </View>

      {/* Tournament: live countdown — at the very top of the weekly section */}
      {activeTab === 'tournament' && config?.is_active && !!config.week_start && (
        <TournamentCountdown weekStart={config.week_start} />
      )}

      {/* Tournament: total prize pool — shown directly below countdown */}
      {activeTab === 'tournament' && config?.is_active && (config?.prize_pool_total ?? 0) > 0 && (
        <View style={styles.prizePoolBar}>
          <Text style={styles.prizePoolLabel}>Total Prize Pool</Text>
          <Text style={styles.prizePoolValue}>{formatShib(config!.prize_pool_total)} SHIB</Text>
        </View>
      )}

      {/* All-time: your rank card */}
      {activeTab === 'alltime' && myRank && (
        <View style={styles.myRankCard}>
          <LinearGradient
            colors={['rgba(244,196,48,0.18)', 'rgba(255,107,0,0.10)']}
            style={styles.myRankGradient}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          >
            <View style={styles.myRankLeft}>
              <Text style={styles.myRankLabel}>Your Position</Text>
              <Text style={styles.myRankNum}>#{myRank.rank}</Text>
              <Text style={styles.myRankName}>{myRank.displayName}</Text>
            </View>
            <View style={styles.myRankRight}>
              <SpinningCoin size={18} spinning={false} />
              <Text style={styles.myRankBalance}>{formatShib(myRank.shibBalance)}</Text>
              <Text style={styles.myRankShibLabel}>SHIB</Text>
            </View>
          </LinearGradient>
        </View>
      )}

      {/* Tournament: your stats card */}
      {activeTab === 'tournament' && myTournamentCard}

      {/* Tournament: Top 3 Podium — renders below stats card, above rank-4+ list */}
      {activeTab === 'tournament' && userJoined && leaderboard.length > 0 && (
        <TournamentPodium top3={leaderboard.slice(0, 3)} pbId={pbId} />
      )}

      {/* Section label */}
      {activeTab === 'alltime' && (
        <Text style={styles.sectionTitle}>
          {boardLoading ? 'Loading…' : `${board.length} Players Ranked`}
        </Text>
      )}
      {activeTab === 'tournament' && userJoined && leaderboard.length > 3 && (
        <Text style={[styles.sectionTitle, { color: '#00C853' + 'aa', marginTop: 4 }]}>
          {leaderboardLoading ? 'Loading…' : `Rankings #4 – #${leaderboard.length}`}
        </Text>
      )}
    </View>
  );

  // ── Render ───────────────────────────────────────────────────────────────

  // Tournament tab when NOT joined — show CTA only (no FlatList rows)
  if (activeTab === 'tournament' && !userJoined && config?.is_active) {
    return (
      <View style={styles.container}>
        <LinearGradient
          colors={['rgba(0,200,83,0.10)', 'rgba(0,100,40,0.06)', 'transparent']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 0.5 }}
        />
        <FlatList
          data={[]}
          keyExtractor={() => 'cta'}
          renderItem={() => null}
          ListHeaderComponent={
            <View>
              {ListHeader}
              <TournamentJoinCTA
                onJoin={async () => {
                  setJoining(true);
                  try { await joinTournament(); refreshLeaderboard(); }
                  finally { setJoining(false); }
                }}
                joining={joining}
              />
            </View>
          }
          contentContainerStyle={{ paddingBottom: tabBarH + TICKER_TOTAL_H + 24 }}
          showsVerticalScrollIndicator={false}
        />
        <View style={[styles.tickerFixed, { bottom: tabBarH }]}>
          <WithdrawalTicker items={ticker} />
        </View>
      </View>
    );
  }

  // Tournament tab — no active tournament
  if (activeTab === 'tournament' && !config?.is_active) {
    return (
      <View style={styles.container}>
        <FlatList
          data={[]}
          keyExtractor={() => 'empty'}
          renderItem={() => null}
          ListHeaderComponent={
            <View>
              {ListHeader}
              <View style={styles.emptyState}>
                <MaterialCommunityIcons name="trophy-outline" size={44} color={Colors.textMuted} />
                <Text style={styles.emptyTitle}>No active tournament</Text>
                <Text style={styles.emptyDesc}>Check back soon — the next weekly tournament starts soon!</Text>
              </View>
            </View>
          }
          contentContainerStyle={{ paddingBottom: tabBarH + TICKER_TOTAL_H + 24 }}
          showsVerticalScrollIndicator={false}
        />
        <View style={[styles.tickerFixed, { bottom: tabBarH }]}>
          <WithdrawalTicker items={ticker} />
        </View>
      </View>
    );
  }

  // Tournament leaderboard (joined) — podium shows top 3 in ListHeader; FlatList shows rank 4+
  if (activeTab === 'tournament') {
    const rank4Plus = leaderboard.slice(3);
    return (
      <View style={styles.container}>
        <LinearGradient
          colors={['rgba(0,200,83,0.10)', 'rgba(0,100,40,0.06)', 'transparent']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 0.45 }}
        />
        <FlatList
          data={rank4Plus}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <TCard entry={item} isMe={item.id === pbId} />}
          ListHeaderComponent={ListHeader}
          ListEmptyComponent={
            leaderboardLoading ? (
              <View style={styles.emptyState}>
                <ActivityIndicator color="#00C853" size="large" />
              </View>
            ) : leaderboard.length > 0 ? (
              // Top 3 exist but no rank 4+ — podium already shown, no empty state needed
              <View style={{ height: 16 }} />
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No competitors yet</Text>
                <Text style={styles.emptyDesc}>Start mining to climb the tournament board!</Text>
              </View>
            )
          }
          ListFooterComponent={<View style={{ height: 24 }} />}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: tabBarH + TICKER_TOTAL_H + 24 }}
        />
        <View style={[styles.tickerFixed, { bottom: tabBarH }]}>
          <WithdrawalTicker items={ticker} />
        </View>
      </View>
    );
  }

  // All-time leaderboard (default)
  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 0.45 }}
      />
      <FlatList
        data={board}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <RankRow entry={item} />}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={
          boardLoading ? null : (
            <View style={styles.emptyState}>
              <Ionicons name="podium-outline" size={44} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No miners yet</Text>
              <Text style={styles.emptyDesc}>Be the first to mine SHIB and top the leaderboard!</Text>
            </View>
          )
        }
        ListFooterComponent={<View style={{ height: 24 }} />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: tabBarH + TICKER_TOTAL_H + 24 }}
      />
      <View style={[styles.tickerFixed, { bottom: tabBarH }]}>
        <WithdrawalTicker items={ticker} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.darkBg },

  headerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14,
  },
  pageTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.textPrimary, marginBottom: 4 },
  pageSub:   { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary },

  tabRow: {
    flexDirection: 'row', gap: 8, marginBottom: 16,
  },
  tabBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 9, borderRadius: 12,
    backgroundColor: Colors.darkCard, borderWidth: 1, borderColor: Colors.darkBorder,
  },
  tabBtnActive: {
    borderColor: Colors.gold + '60',
    backgroundColor: 'rgba(244,196,48,0.10)',
  },
  tabBtnTournamentActive: {
    borderColor: '#00C85360',
    backgroundColor: 'rgba(0,200,83,0.10)',
  },
  tabBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textMuted },
  tabBtnTextActive: { color: Colors.gold },
  tabBtnTextTournament: { color: '#00C853' },
  liveDot: {
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: '#00C853',
    marginLeft: 2,
  },

  myRankCard:     { borderRadius: 18, overflow: 'hidden', marginBottom: 16, borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)' },
  myRankGradient: { flexDirection: 'row', alignItems: 'center', padding: 18 },
  myRankLeft:     { flex: 1, gap: 2 },
  myRankLabel:    { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  myRankNum:      { fontFamily: 'Inter_700Bold', fontSize: 30, color: Colors.gold },
  myRankName:     { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textSecondary },
  myRankRight:    { alignItems: 'flex-end', gap: 2 },
  myRankBalance:  { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.gold },
  myRankShibLabel:{ fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },

  sectionTitle: {
    fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8,
  },

  prizePoolBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: 'rgba(244,196,48,0.07)',
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(244,196,48,0.22)',
    paddingVertical: 10, paddingHorizontal: 16,
    marginBottom: 14,
  },
  prizePoolLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textSecondary },
  prizePoolValue: { fontFamily: 'Inter_700Bold', fontSize: 15, color: Colors.gold },

  emptyState: { alignItems: 'center', paddingVertical: 60, gap: 12, paddingHorizontal: 40 },
  emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 17, color: Colors.textSecondary },
  emptyDesc:  { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center', lineHeight: 20 },

  tickerFixed: {
    position: 'absolute', left: 0, right: 0,
    backgroundColor: Colors.darkBg,
    zIndex: 25,
    elevation: 25,
  },
});
