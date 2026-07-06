/* Arcade PvP lobby (Flappy Bounce / Fruit Cut) — pick a PT stake tier, then enter
 * matchmaking. Mirrors the 8-Ball pool lobby; economy (PT stake / Hit Ticket
 * payout / 10% fee) is shared via ARCADE_TIERS + TIER_CONFIGS from @shared/arcade. */

import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Platform, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import Colors from '@/constants/colors';
import { useWallet } from '@/context/WalletContext';
import TicketIcon from '@/components/TicketIcon';
import { InlineBannerAd, BANNER_HEIGHT } from '@/components/StickyBannerAd';
import { TIER_CONFIGS } from '@shared/arcade';

const FLAPPY_ICON = require('@/assets/images/flappy_icon.png');
const FRUITCUT_ICON = require('@/assets/images/fruitcut_icon.jpg');

type GameMeta = { name: string; icon: any; heroTitle: string; heroSub: string; practiceNote: string };
const GAME_META: Record<string, GameMeta> = {
  flappy: {
    name: 'Flappy Bounce',
    icon: FLAPPY_ICON,
    heroTitle: 'Sudden Death 1v1',
    heroSub: 'One life. Outscore your opponent — first hit ends your run.',
    practiceNote: 'Free · 3 lives · no PT staked, no tickets',
  },
  fruitcut: {
    name: 'Fruit Cut',
    icon: FRUITCUT_ICON,
    heroTitle: 'Slice-Off 1v1',
    heroSub: '3 lives. Slice fruit, dodge the bombs — highest score wins the pot.',
    practiceNote: 'Free · 3 lives · no PT staked, no tickets',
  },
};

export default function ArcadeLobbyScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens } = useWallet();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;

  const params = useLocalSearchParams<{ gameId?: string }>();
  const gameId = typeof params.gameId === 'string' && GAME_META[params.gameId] ? params.gameId : 'flappy';
  const meta = GAME_META[gameId];

  const openMatch = (tier: number, practice: boolean) => {
    router.push({
      pathname: '/hub/arcade-match',
      params: { gameId, tier: String(tier), practice: practice ? '1' : '0' },
    } as any);
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + webTop + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back} testID="arcade-lobby-back">
          <Ionicons name="chevron-back" size={24} color={Colors.gold} />
        </Pressable>
        <View style={styles.headTitle}>
          <Text style={styles.title}>{meta.name}</Text>
          <Text style={styles.sub}>Stake PT · win Hit Tickets</Text>
        </View>
        <View style={styles.ptPill}>
          <Ionicons name="flash" size={13} color={Colors.gold} />
          <Text style={styles.ptTxt}>{powerTokens.toLocaleString()}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 + webBottom + BANNER_HEIGHT, gap: 12 }} showsVerticalScrollIndicator={false}>
        {/* Hero */}
        <LinearGradient colors={['#1E1508', '#12121A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
          <Image source={meta.icon} style={styles.heroIcon} resizeMode="cover" />
          <View style={{ flex: 1 }}>
            <Text style={styles.heroTitle}>{meta.heroTitle}</Text>
            <Text style={styles.heroSub}>{meta.heroSub}</Text>
          </View>
        </LinearGradient>

        <Text style={styles.section}>SELECT A ROOM</Text>
        {TIER_CONFIGS.map((t) => {
          const afford = powerTokens >= t.entryPT;
          return (
            <View key={t.entryPT}>
              <Pressable
                disabled={!afford}
                onPress={() => openMatch(t.entryPT, false)}
                testID={`arcade-tier-${t.entryPT}`}
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

        {/* Free practice — no stake, 3 lives */}
        <Pressable onPress={() => openMatch(TIER_CONFIGS[0].entryPT, true)} testID="arcade-practice" style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1 }]}>
          <View style={styles.practiceCard}>
            <Ionicons name="game-controller-outline" size={20} color={Colors.textSecondary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.practiceTitle}>Practice offline</Text>
              <Text style={styles.practiceNote}>{meta.practiceNote}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
          </View>
        </Pressable>

        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={Colors.textSecondary} />
          <Text style={styles.infoTxt}>
            Both players stake equal PT. A 10% platform commission is taken from the pot; the winner is credited Hit Tickets, redeemable for SHIB in the Redemption Center. A tie refunds both stakes.
          </Text>
        </View>
      </ScrollView>

      {/* Banner ad on the game hub / matchmaking funnel */}
      <View style={[styles.bannerBar, { paddingBottom: webBottom }]}>
        <InlineBannerAd />
      </View>
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
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(244,196,48,0.35)' },
  heroIcon: { width: 56, height: 56, borderRadius: 16 },
  heroTitle: { color: Colors.gold, fontSize: 16, fontWeight: '800' },
  heroSub: { color: Colors.textSecondary, fontSize: 12, marginTop: 3, lineHeight: 17 },
  section: { color: Colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 2, marginTop: 4 },
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
  practiceCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: Colors.darkCard, borderColor: Colors.darkBorder, borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 2 },
  practiceTitle: { color: Colors.textPrimary, fontSize: 14, fontWeight: '700' },
  practiceNote: { color: Colors.textMuted, fontSize: 11, marginTop: 2 },
  infoBox: { flexDirection: 'row', gap: 8, backgroundColor: Colors.darkCard, borderColor: Colors.darkBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 6 },
  infoTxt: { flex: 1, color: Colors.textSecondary, fontSize: 12, lineHeight: 17 },
  bannerBar: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', backgroundColor: Colors.darkBg, borderTopColor: Colors.darkBorder, borderTopWidth: 1 },
});
