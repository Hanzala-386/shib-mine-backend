/* Game Arena tab — entry hub: Solo Play (Knife Hit) vs Multiplayer (8-Ball). */

import React from 'react';
import { View, Text, StyleSheet, Pressable, Platform, ScrollView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';
import { useWallet } from '@/context/WalletContext';
import TicketIcon from '@/components/TicketIcon';

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens, hitTickets } = useWallet();
  const webTop = Platform.OS === 'web' ? 67 : 0;

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + webTop + 12, paddingHorizontal: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Game Arena</Text>
        <Text style={styles.subtitle}>Play solo or battle for real rewards</Text>

        {/* Balances */}
        <View style={styles.balanceRow}>
          <View style={styles.balancePill}>
            <Ionicons name="flash" size={15} color={Colors.gold} />
            <Text style={styles.balanceTxt}>{powerTokens.toLocaleString()} PT</Text>
          </View>
          <Pressable style={styles.balancePill} onPress={() => router.push('/redeem')} testID="games-tickets">
            <TicketIcon size={15} color={Colors.gold} />
            <Text style={styles.balanceTxt}>{hitTickets.toLocaleString()} Tickets</Text>
          </Pressable>
        </View>

        {/* Solo Play */}
        <Pressable onPress={() => router.push('/solo-play')} testID="mode-solo" style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}>
          <LinearGradient colors={['#FF6B00', '#B34700']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
            <View style={styles.cardIcon}><Ionicons name="flash" size={30} color="#fff" /></View>
            <View style={styles.cardBody}>
              <Text style={styles.cardTitle}>Solo Play</Text>
              <Text style={styles.cardSub}>Knife Hit · earn Power Tokens</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color="rgba(255,255,255,0.85)" />
          </LinearGradient>
        </Pressable>

        {/* Multiplayer Hub */}
        <Pressable onPress={() => router.push('/hub')} testID="mode-multiplayer" style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}>
          <LinearGradient colors={['#F4C430', '#C8930A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
            <View style={[styles.cardIcon, { backgroundColor: 'rgba(26,18,0,0.15)' }]}><Ionicons name="trophy" size={28} color="#1a1200" /></View>
            <View style={styles.cardBody}>
              <Text style={[styles.cardTitle, { color: '#1a1200' }]}>Multiplayer Hub</Text>
              <Text style={[styles.cardSub, { color: 'rgba(26,18,0,0.7)' }]}>8-Ball Pool · win Hit Tickets</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color="rgba(26,18,0,0.7)" />
          </LinearGradient>
        </Pressable>

        {/* Redemption Center */}
        <Pressable onPress={() => router.push('/redeem')} style={styles.redeemLink} testID="games-redeem">
          <Ionicons name="swap-horizontal" size={18} color={Colors.gold} />
          <Text style={styles.redeemTxt}>Redemption Center</Text>
          <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} style={{ marginLeft: 'auto' }} />
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },
  title: { color: Colors.textPrimary, fontSize: 26, fontWeight: '800' },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4 },
  balanceRow: { flexDirection: 'row', gap: 10, marginTop: 16, marginBottom: 20 },
  balancePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.darkCard, borderColor: Colors.darkBorder, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20 },
  balanceTxt: { color: Colors.textPrimary, fontSize: 13, fontWeight: '700' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 18, marginBottom: 14 },
  cardIcon: { width: 54, height: 54, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1 },
  cardTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  cardSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 3, fontWeight: '600' },
  redeemLink: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: Colors.darkCard, borderColor: Colors.darkBorder, borderWidth: 1, padding: 16, borderRadius: 14, marginTop: 4 },
  redeemTxt: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
});
