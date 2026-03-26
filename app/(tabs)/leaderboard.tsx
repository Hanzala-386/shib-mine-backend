import React, { useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, Platform, Animated, Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { getApiUrl } from '@/lib/query-client';
import { POCKETBASE_URL, pb } from '@/lib/pocketbase';
import { BANNER_HEIGHT } from '@/components/StickyBannerAd';
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

async function fetchJson(path: string) {
  const url = new URL(path, getApiUrl());
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ── PocketBase direct fallback for when Express backend is unreachable ── */
async function fetchLeaderboard(): Promise<LeaderEntry[]> {
  try {
    return await fetchJson('/api/app/leaderboard');
  } catch {
    // PB SDK fallback (authenticated — works even when collection isn't public)
    try {
      const res = await pb.collection('users').getList(1, 100, {
        sort: '-shib_balance',
        fields: 'id,display_name,shib_balance',
      });
      return (res.items || []).map((u: any, i: number) => {
        let name: string = u.display_name || 'Miner';
        if (name.includes('@')) name = name.split('@')[0];
        return {
          rank: i + 1,
          id: u.id,
          displayName: name,
          shibBalance: u.shib_balance || 0,
        };
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
    // PB fallback: use SDK (sends auth token automatically)
    try {
      const res = await pb.collection('users').getList(1, 500, {
        sort: '-shib_balance',
        fields: 'id,display_name,shib_balance',
      });
      const items = res.items || [];
      const idx = items.findIndex((u: any) => u.id === pbId);
      if (idx < 0) return undefined;
      const u = items[idx];
      return {
        rank: idx + 1,
        id: u.id,
        displayName: u.display_name || 'Miner',
        shibBalance: u.shib_balance || 0,
      };
    } catch {
      return undefined;
    }
  }
}

/* ── Ticker marquee ── */
const ITEM_W = 230;
const TICKER_H = 46;
// Full visual height of the WithdrawalTicker widget (label row + track + border + padding)
const TICKER_TOTAL_H = TICKER_H + 28; // 46 track + 28 (label ~16px + paddingVertical 8 + border 1 + gap 3)

function WithdrawalTicker({ items }: { items: TickerItem[] }) {
  const translateX = useRef(new Animated.Value(0)).current;
  // Quadruple for generous buffer — prevents any perceived gap on reset
  const quadrupled = [...items, ...items, ...items, ...items];
  const stopped = useRef(false);

  useEffect(() => {
    if (!items.length) return;
    stopped.current = false;
    const totalW = items.length * ITEM_W; // animate one full copy length

    function runCycle() {
      if (stopped.current) return;
      translateX.setValue(0);
      Animated.timing(translateX, {
        toValue: -totalW,
        duration: totalW * 30,   // 30ms per pixel → smooth moderate speed
        easing: Easing.linear,
        useNativeDriver: false,  // false = works on both web and native
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
  labelWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 16, paddingBottom: 4,
  },
  label: {
    fontFamily: 'Inter_700Bold', fontSize: 9,
    color: Colors.gold, letterSpacing: 1.5, textTransform: 'uppercase',
  },
  track: { height: TICKER_H, overflow: 'hidden' },
  row:   { flexDirection: 'row', alignItems: 'center', height: TICKER_H },
  chip: {
    width: ITEM_W, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, height: TICKER_H,
  },
  name:   { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textPrimary },
  method: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary },
  amount: { fontFamily: 'Inter_700Bold',    fontSize: 13, color: '#4CAF50' },
  dot:    { width: 4, height: 4, borderRadius: 2, backgroundColor: Colors.textMuted },
  emptyBox: { height: TICKER_H + 22, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
});

/* ── Rank row ── */
function RankRow({ entry }: { entry: LeaderEntry }) {
  const isFirst   = entry.rank === 1;
  const isSecond  = entry.rank === 2;
  const isThird   = entry.rank === 3;
  const isPodium  = entry.rank <= 3;

  const rankColor = isFirst ? Colors.gold : isSecond ? '#C0C0C0' : isThird ? '#CD7F32' : Colors.textMuted;
  const cardBg    = isFirst ? 'rgba(244,196,48,0.10)' : isSecond ? 'rgba(192,192,192,0.07)' : isThird ? 'rgba(205,127,50,0.07)' : 'transparent';
  const borderCol = isFirst ? 'rgba(244,196,48,0.28)' : isSecond ? 'rgba(192,192,192,0.18)' : isThird ? 'rgba(205,127,50,0.18)' : Colors.darkBorder;

  return (
    <View style={[rowStyles.row, { backgroundColor: cardBg, borderColor: borderCol }]}>
      {/* Rank badge */}
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

      {/* Avatar circle */}
      <View style={[rowStyles.avatar, isPodium && { borderColor: rankColor + '60', borderWidth: 2 }]}>
        <Text style={rowStyles.avatarText}>
          {entry.displayName.slice(0, 2).toUpperCase()}
        </Text>
      </View>

      {/* Name */}
      <Text style={[rowStyles.name, isFirst && rowStyles.nameGold]} numberOfLines={1}>
        {entry.displayName}
      </Text>

      {/* Balance */}
      <View style={rowStyles.balanceWrap}>
        <Text style={[rowStyles.balance, { color: rankColor }]}>
          {formatShib(entry.shibBalance)}
        </Text>
        <Text style={rowStyles.balanceSub}>SHIB</Text>
      </View>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 10, paddingHorizontal: 14, marginHorizontal: 14, marginBottom: 4,
    borderRadius: 14, borderWidth: 1,
  },
  rankWrap:  { width: 36, alignItems: 'center' },
  crownWrap: { alignItems: 'center', gap: 0 },
  rankNum:   { fontFamily: 'Inter_700Bold', fontSize: 14 },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,107,0,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.neonOrange },
  name:       { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textPrimary },
  nameGold:   { color: Colors.gold, fontFamily: 'Inter_700Bold' },
  balanceWrap:{ alignItems: 'flex-end' },
  balance:    { fontFamily: 'Inter_700Bold', fontSize: 15 },
  balanceSub: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted },
});

/* ═══════════════════════════════════════════════════════════════════════════ */
export default function LeaderboardScreen() {
  const insets    = useSafeAreaInsets();
  const { pbUser } = useAuth();
  const pbId       = pbUser?.pbId ?? '';

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

  // Ticker: try Express, then query PocketBase withdrawals collection directly
  const { data: ticker = [] } = useQuery<TickerItem[]>({
    queryKey: ['/api/app/withdrawals/approved/recent'],
    queryFn: async () => {
      try {
        return await fetchJson('/api/app/withdrawals/approved/recent');
      } catch {
        // PB fallback: query completed withdrawals directly
        try {
          const res = await pb.collection('withdrawals').getList(1, 10, {
            filter: 'status = "completed" || status = "approved"',
            sort: '-created',
            expand: 'user',
          });
          return (res.items || []).map((w: any) => {
            const uname: string = w.expand?.user?.display_name || 'Miner';
            const masked = uname.length > 2
              ? uname.slice(0, 2) + '***'
              : uname + '***';
            return {
              id: w.id,
              maskedName: masked,
              method: w.method || 'BEP-20',
              amount: w.amount || 0,
            };
          });
        } catch {
          return [];
        }
      }
    },
    staleTime: 120_000,
  });

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);

  // Total height of the custom tab bar (banner ad + tab buttons + safe area bottom)
  const tabBarH = Platform.OS === 'web' ? 84 : BANNER_HEIGHT + 56 + insets.bottom;

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.45 }}
      />

      <FlatList
        data={board}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <RankRow entry={item} />}
        ListHeaderComponent={
          <View style={{ paddingTop: topPad + 16, paddingHorizontal: 20, paddingBottom: 10 }}>
            {/* Page header */}
            <View style={styles.headerRow}>
              <View>
                <Text style={styles.pageTitle}>Top Players</Text>
                <Text style={styles.pageSub}>Top 100 SHIB miners worldwide</Text>
              </View>
              <MaterialCommunityIcons name="trophy" size={32} color={Colors.gold} />
            </View>

            {/* Your Rank card */}
            {myRank && (
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
                    <MaterialCommunityIcons name="bitcoin" size={18} color={Colors.gold} />
                    <Text style={styles.myRankBalance}>{formatShib(myRank.shibBalance)}</Text>
                    <Text style={styles.myRankShibLabel}>SHIB</Text>
                  </View>
                </LinearGradient>
              </View>
            )}

            {/* Section divider */}
            <Text style={styles.sectionTitle}>
              {boardLoading ? 'Loading…' : `${board.length} Players Ranked`}
            </Text>
          </View>
        }
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
        contentContainerStyle={{
          // Padding = tabBar (banner+buttons+insets) + ticker height + buffer
          // Ensures the last player row is fully visible above the fixed ticker
          paddingBottom: tabBarH + TICKER_TOTAL_H + 24,
        }}
      />

      {/* Fixed withdrawal ticker — anchored directly above the tab bar */}
      <View style={[styles.tickerFixed, { bottom: tabBarH }]}>
        <WithdrawalTicker items={ticker} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.darkBg },

  headerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18,
  },
  pageTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.textPrimary, marginBottom: 4 },
  pageSub:   { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary },

  myRankCard:     { borderRadius: 18, overflow: 'hidden', marginBottom: 20, borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)' },
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

  emptyState: { alignItems: 'center', paddingVertical: 60, gap: 12, paddingHorizontal: 40 },
  emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 17, color: Colors.textSecondary },
  emptyDesc:  { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center', lineHeight: 20 },

  tickerFixed: {
    position: 'absolute', left: 0, right: 0,
    backgroundColor: Colors.darkBg,
    zIndex: 10,
    elevation: 10,
  },
});
