import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useWallet, Transaction } from '@/context/WalletContext';
import Colors from '@/constants/colors';

function formatShib(val: number) {
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(0)}K`;
  return val.toLocaleString();
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const TX_ICONS: Record<string, { name: string; color: string; lib: string }> = {
  mining_claim: { name: 'pickaxe', color: Colors.gold, lib: 'material-community' },
  game_reward: { name: 'game-controller', color: Colors.neonOrange, lib: 'ionicons' },
  booster_purchase: { name: 'lightning-bolt', color: '#2196F3', lib: 'material-community' },
  referral_bonus: { name: 'people', color: '#4CAF50', lib: 'ionicons' },
  mining_fee: { name: 'cash-minus', color: '#FF3D57', lib: 'material-community' },
  default: { name: 'swap-horizontal', color: Colors.textMuted, lib: 'ionicons' },
};

function TxIcon({ type }: { type: string }) {
  const conf = TX_ICONS[type] ?? TX_ICONS['default'];
  if (conf.lib === 'material-community') {
    return <MaterialCommunityIcons name={conf.name as any} size={20} color={conf.color} />;
  }
  return <Ionicons name={conf.name as any} size={20} color={conf.color} />;
}

function TransactionItem({ tx }: { tx: Transaction }) {
  const isNegative = tx.amount < 0;
  const iconConf = TX_ICONS[tx.type] ?? TX_ICONS['default'];
  return (
    <View style={styles.txItem}>
      <View style={[styles.txIconWrap, { backgroundColor: iconConf.color + '20' }]}>
        <TxIcon type={tx.type} />
      </View>
      <View style={styles.txInfo}>
        <Text style={styles.txDesc} numberOfLines={1}>{tx.description}</Text>
        <Text style={styles.txTime}>{timeAgo(tx.timestamp)}</Text>
      </View>
      <View style={styles.txAmountWrap}>
        <Text style={[styles.txAmount, { color: isNegative ? Colors.error : Colors.success }]}>
          {isNegative ? '' : '+'}{Math.abs(tx.amount).toLocaleString()}
        </Text>
        <Text style={styles.txCurrency}>{tx.currency}</Text>
      </View>
    </View>
  );
}

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const { shibBalance, powerTokens, transactions } = useWallet();

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16), paddingBottom: 120 }]}
      >
        <Animated.View entering={FadeInDown.delay(100).springify()}>
          <Text style={styles.pageTitle}>Wallet</Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.mainCard}>
          <LinearGradient
            colors={['rgba(244,196,48,0.2)', 'rgba(255,107,0,0.12)']}
            style={styles.mainCardGradient}
          >
            <View style={styles.mainCardHeader}>
              <MaterialCommunityIcons name="bitcoin" size={28} color={Colors.gold} />
              <Text style={styles.mainCardLabel}>SHIB Balance</Text>
            </View>
            <Text style={styles.mainBalance}>{formatShib(shibBalance)}</Text>
            <Text style={styles.mainBalanceFull}>{shibBalance.toLocaleString()} SHIB</Text>
          </LinearGradient>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(300).springify()} style={styles.ptCard}>
          <LinearGradient
            colors={['rgba(255,107,0,0.15)', 'rgba(255,107,0,0.05)']}
            style={styles.ptCardInner}
          >
            <View style={styles.ptRow}>
              <View style={styles.ptIconWrap}>
                <MaterialCommunityIcons name="lightning-bolt" size={24} color={Colors.neonOrange} />
              </View>
              <View style={styles.ptInfo}>
                <Text style={styles.ptLabel}>Power Tokens</Text>
                <Text style={styles.ptSub}>Used to start mining & buy boosters</Text>
              </View>
              <Text style={styles.ptValue}>{powerTokens}</Text>
            </View>
          </LinearGradient>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(400).springify()} style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Ionicons name="information-circle-outline" size={18} color={Colors.textMuted} />
            <Text style={styles.infoText}>
              Earn Power Tokens by playing Knife Hit (3 PT/win). Use them to start mining sessions and buy speed boosters.
            </Text>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(500).springify()}>
          <Text style={styles.sectionTitle}>Transaction History</Text>
          {transactions.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="receipt-outline" size={40} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No transactions yet</Text>
              <Text style={styles.emptyDesc}>Start mining or play Knife Hit to earn rewards</Text>
            </View>
          ) : (
            <View style={styles.txList}>
              {transactions.map((tx) => (
                <TransactionItem key={tx.id} tx={tx} />
              ))}
            </View>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 20 },
  pageTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.textPrimary, marginBottom: 20 },
  mainCard: { borderRadius: 24, overflow: 'hidden', marginBottom: 14, borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)' },
  mainCardGradient: { padding: 28, alignItems: 'center', gap: 8 },
  mainCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mainCardLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textSecondary },
  mainBalance: { fontFamily: 'Inter_700Bold', fontSize: 48, color: Colors.gold },
  mainBalanceFull: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
  ptCard: { borderRadius: 18, overflow: 'hidden', marginBottom: 14, borderWidth: 1, borderColor: 'rgba(255,107,0,0.25)' },
  ptCardInner: { padding: 18 },
  ptRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  ptIconWrap: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: 'rgba(255,107,0,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  ptInfo: { flex: 1 },
  ptLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 15, color: Colors.textPrimary },
  ptSub: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  ptValue: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.neonOrange },
  infoCard: {
    backgroundColor: Colors.darkCard, borderRadius: 14, padding: 14,
    marginBottom: 24, borderWidth: 1, borderColor: Colors.darkBorder,
  },
  infoRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  infoText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary, flex: 1, lineHeight: 18 },
  sectionTitle: {
    fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12,
  },
  emptyState: {
    backgroundColor: Colors.darkCard, borderRadius: 18, padding: 40,
    alignItems: 'center', gap: 10, borderWidth: 1, borderColor: Colors.darkBorder,
  },
  emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 16, color: Colors.textSecondary },
  emptyDesc: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center' },
  txList: { gap: 2 },
  txItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: Colors.darkCard, borderRadius: 14,
    padding: 14, marginBottom: 6,
  },
  txIconWrap: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  txInfo: { flex: 1 },
  txDesc: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textPrimary },
  txTime: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  txAmountWrap: { alignItems: 'flex-end' },
  txAmount: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  txCurrency: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted },
});
