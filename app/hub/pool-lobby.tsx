/* 8-Ball Pool lobby — pick a PT stake tier, then enter matchmaking. */

import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';
import { useWallet } from '@/context/WalletContext';
import TicketIcon from '@/components/TicketIcon';
import { TIER_CONFIGS } from '@shared/gamehub';

export default function PoolLobbyScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens } = useWallet();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + webTop + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back} testID="lobby-back">
          <Ionicons name="chevron-back" size={24} color={Colors.gold} />
        </Pressable>
        <View style={styles.headTitle}>
          <Text style={styles.title}>8-Ball Pool</Text>
          <Text style={styles.sub}>Stake PT · win Hit Tickets</Text>
        </View>
        <View style={styles.ptPill}>
          <Ionicons name="flash" size={13} color={Colors.gold} />
          <Text style={styles.ptTxt}>{powerTokens.toLocaleString()}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 + webBottom, gap: 12 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.section}>SELECT A ROOM</Text>
        {TIER_CONFIGS.map((t) => {
          const afford = powerTokens >= t.entryPT;
          return (
            <View key={t.entryPT}>
              <Pressable
                disabled={!afford}
                onPress={() => router.push({ pathname: '/hub/pool-match', params: { tier: String(t.entryPT) } } as any)}
                testID={`tier-${t.entryPT}`}
                style={({ pressed }) => [{ opacity: !afford ? 0.5 : pressed ? 0.9 : 1 }]}
              >
                <LinearGradient colors={['#1A1A28', '#12121A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
                  <View style={styles.tierLeft}>
                    <View style={styles.tierBadge}>
                      <Text style={styles.tierBadgeTxt}>{t.label}</Text>
                    </View>
                    <View>
                      <Text style={styles.tierEntry}>{t.entryPT.toLocaleString()} PT entry</Text>
                      <Text style={styles.tierNote}>1v1 · winner takes the pot</Text>
                    </View>
                  </View>
                  <View style={styles.tierRight}>
                    <View style={styles.rewardRow}>
                      <TicketIcon size={16} color={Colors.gold} />
                      <Text style={styles.rewardTxt}>{t.winnerTickets}</Text>
                    </View>
                    <Text style={styles.rewardShib}>≈ {t.winnerShib.toLocaleString()} SHIB</Text>
                  </View>
                </LinearGradient>
              </Pressable>
              {!afford && <Text style={styles.needMore}>Need {(t.entryPT - powerTokens).toLocaleString()} more PT</Text>}
            </View>
          );
        })}

        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={Colors.textSecondary} />
          <Text style={styles.infoTxt}>
            Both players stake equal PT. A 10% platform commission is taken from the pot; the winner is credited Hit Tickets, redeemable for SHIB in the Redemption Center.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headTitle: { flex: 1 },
  title: { color: Colors.textPrimary, fontSize: 20, fontWeight: '800' },
  sub: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  ptPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.darkCard, borderColor: Colors.darkBorder, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  ptTxt: { color: Colors.gold, fontSize: 13, fontWeight: '700' },
  section: { color: Colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 2 },
  card: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 16, borderWidth: 1, borderColor: Colors.darkBorder },
  tierLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tierBadge: { width: 52, height: 52, borderRadius: 14, backgroundColor: 'rgba(244,196,48,0.12)', borderWidth: 1, borderColor: 'rgba(244,196,48,0.4)', alignItems: 'center', justifyContent: 'center' },
  tierBadgeTxt: { color: Colors.gold, fontSize: 18, fontWeight: '800' },
  tierEntry: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  tierNote: { color: Colors.textMuted, fontSize: 12, marginTop: 2 },
  tierRight: { alignItems: 'flex-end' },
  rewardRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rewardTxt: { color: Colors.gold, fontSize: 18, fontWeight: '800' },
  rewardShib: { color: Colors.textSecondary, fontSize: 11, marginTop: 2 },
  needMore: { color: Colors.error, fontSize: 11, marginTop: 4, marginLeft: 4 },
  infoBox: { flexDirection: 'row', gap: 8, backgroundColor: Colors.darkCard, borderColor: Colors.darkBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 6 },
  infoTxt: { flex: 1, color: Colors.textSecondary, fontSize: 12, lineHeight: 17 },
});
