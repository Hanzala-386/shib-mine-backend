/* ────────────────────────────────────────────────────────────────────────────
 * Game History — READ-ONLY table of the user's game + redemption activity.
 * Columns: Sr | Game | Win/Loss | Tickets Won / Tokens Lost.
 * Data: PB `game_history` collection (append-only, user-scoped rules); rows are
 * written fire-and-forget at arcade settle / solo claim / ticket redeem time.
 * ──────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Platform, FlatList,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';
import NebulaBg from '@/components/NebulaBg';
import { pb } from '@/lib/pocketbase';
import { fetchGameHistory, type GameHistoryRecord } from '@/lib/gameHistory';

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function resultLabel(r: GameHistoryRecord): { text: string; color: string } {
  switch (r.outcome) {
    case 'win':    return { text: 'Win',    color: '#3DDC84' };
    case 'loss':   return { text: 'Loss',   color: '#FF5252' };
    case 'draw':   return { text: 'Draw',   color: Colors.gold };
    case 'redeem': return { text: 'Redeem', color: '#4FC3F7' };
    default:       return { text: '—',      color: Colors.textSecondary };
  }
}

function amountLabel(r: GameHistoryRecord): { text: string; color: string } {
  if (r.outcome === 'redeem') {
    return { text: `-${r.tokens_lost} Tickets`, color: '#4FC3F7' };
  }
  if (r.outcome === 'win') {
    if (r.tickets_won > 0) return { text: `+${r.tickets_won} Tickets`, color: '#3DDC84' };
    if (r.pt_won > 0)      return { text: `+${r.pt_won} PT`,           color: '#3DDC84' };
    return { text: '—', color: Colors.textSecondary };
  }
  if (r.outcome === 'loss') {
    if (r.tokens_lost > 0) return { text: `-${r.tokens_lost} PT`, color: '#FF5252' };
    return { text: '—', color: Colors.textSecondary };
  }
  // draw → stake refunded
  return { text: 'Refunded', color: Colors.textSecondary };
}

export default function GameHistoryScreen() {
  const insets = useSafeAreaInsets();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;

  const [rows, setRows] = useState<GameHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    const pbId = pb.authStore.record?.id || (pb.authStore as any).model?.id;
    if (!pbId) { setError('Not signed in'); setLoading(false); setRefreshing(false); return; }
    if (isRefresh) setRefreshing(true);
    try {
      const items = await fetchGameHistory(pbId);
      setRows(items);
      setError(null);
    } catch (e: any) {
      // Only surface the error when we have nothing to show — a failed
      // pull-to-refresh over existing rows keeps the stale list visible.
      if (rows.length === 0) setError('Could not load history. Pull to retry.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [rows.length]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const renderRow = useCallback(({ item, index }: { item: GameHistoryRecord; index: number }) => {
    const res = resultLabel(item);
    const amt = amountLabel(item);
    return (
      <View style={[styles.row, index % 2 === 1 && styles.rowAlt]} testID={`history-row-${index}`}>
        <Text style={styles.cellSr}>{index + 1}</Text>
        <View style={styles.cellGame}>
          <Text style={styles.gameName} numberOfLines={1}>{item.game || '—'}</Text>
          <Text style={styles.gameDate}>{fmtDate(item.created)}</Text>
        </View>
        <Text style={[styles.cellResult, { color: res.color }]}>{res.text}</Text>
        <Text style={[styles.cellAmount, { color: amt.color }]} numberOfLines={1}>{amt.text}</Text>
      </View>
    );
  }, []);

  return (
    <View style={styles.root}>
      <NebulaBg />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + webTop + 10 }]}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, { opacity: pressed ? 0.7 : 1 }]}
          testID="history-back-button"
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.gold} />
        </Pressable>
        <Text style={styles.title}>Game History</Text>
        <View style={styles.backBtn} />
      </View>

      {/* Table header */}
      <View style={styles.tableHead}>
        <Text style={[styles.headTxt, styles.cellSr]}>Sr</Text>
        <Text style={[styles.headTxt, { flex: 1 }]}>Game</Text>
        <Text style={[styles.headTxt, styles.cellResult]}>Result</Text>
        <Text style={[styles.headTxt, styles.cellAmount]}>Won / Lost</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.gold} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          renderItem={renderRow}
          scrollEnabled={rows.length > 0}
          contentContainerStyle={{ paddingBottom: 32 + webBottom + insets.bottom }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={Colors.gold}
              colors={[Colors.gold]}
            />
          }
          ListEmptyComponent={
            <View style={styles.center} testID="history-empty">
              <Ionicons
                name={error ? 'cloud-offline-outline' : 'game-controller-outline'}
                size={44}
                color={Colors.textSecondary}
              />
              <Text style={styles.emptyTxt}>
                {error ?? 'No games played yet.\nYour match results and redemptions will appear here.'}
              </Text>
            </View>
          }
          testID="history-list"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: {
    color: Colors.textPrimary,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0.4,
    textShadowColor: 'rgba(244,196,48,0.35)',
    textShadowRadius: 10,
  },

  tableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 14,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(244,196,48,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.25)',
  },
  headTxt: {
    color: Colors.gold,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 14,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  rowAlt: { backgroundColor: 'rgba(255,255,255,0.025)' },

  cellSr: { width: 30, color: Colors.textSecondary, fontSize: 13, fontWeight: '700' },
  cellGame: { flex: 1, paddingRight: 6 },
  gameName: { color: Colors.textPrimary, fontSize: 14, fontWeight: '700' },
  gameDate: { color: Colors.textSecondary, fontSize: 11, marginTop: 2 },
  cellResult: { width: 62, fontSize: 13, fontWeight: '800' },
  cellAmount: { width: 108, fontSize: 13, fontWeight: '700', textAlign: 'right' },

  center: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyTxt: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 21,
  },
});
