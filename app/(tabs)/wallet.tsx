import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Platform, Pressable, TextInput, Alert, Modal,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useWallet, type WithdrawalRecord } from '@/context/WalletContext';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

function formatShib(val: number) {
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(0)}K`;
  return val.toLocaleString();
}

function formatDate(str: string): string {
  return new Date(str).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_COLORS: Record<string, string> = {
  pending: Colors.gold,
  completed: '#4CAF50',
  rejected: Colors.error,
};

function WithdrawalItem({ w }: { w: WithdrawalRecord }) {
  const color = STATUS_COLORS[w.status] ?? Colors.textMuted;
  return (
    <View style={styles.txItem}>
      <View style={[styles.txIconWrap, { backgroundColor: color + '20' }]}>
        <MaterialCommunityIcons name="bank-transfer" size={20} color={color} />
      </View>
      <View style={styles.txInfo}>
        <Text style={styles.txDesc} numberOfLines={1}>{w.method} — {w.addressOrEmail}</Text>
        <Text style={styles.txTime}>{formatDate(w.created)}</Text>
      </View>
      <View style={styles.txAmountWrap}>
        <Text style={[styles.txAmount, { color }]}>
          -{formatShib(w.amount)}
        </Text>
        <Text style={[styles.txCurrency, { color }]}>{w.status.toUpperCase()}</Text>
      </View>
    </View>
  );
}

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const { shibBalance, powerTokens, withdrawals, withdrawalTier, minWithdrawalAmount, createWithdrawal, isLoading } = useWallet();
  const { pbUser } = useAuth();
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [method, setMethod] = useState('Binance');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleWithdraw() {
    const amt = parseFloat(amount);
    if (!amt || isNaN(amt) || amt <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount.');
      return;
    }
    if (amt < minWithdrawalAmount) {
      Alert.alert('Too Low', `Minimum withdrawal is ${formatShib(minWithdrawalAmount)} SHIB.`);
      return;
    }
    if (!address.trim()) {
      Alert.alert('Missing Address', 'Please enter your wallet address or email.');
      return;
    }
    setSubmitting(true);
    const res = await createWithdrawal(method, address.trim(), amt);
    setSubmitting(false);
    if (res.success) {
      setShowWithdraw(false);
      setAmount('');
      setAddress('');
      Alert.alert('Submitted!', 'Your withdrawal request has been submitted for review.');
    } else {
      Alert.alert('Failed', res.error || 'Could not submit withdrawal.');
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />
      <ScrollView
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
            <Pressable
              style={({ pressed }) => [styles.withdrawBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={() => setShowWithdraw(true)}
            >
              <LinearGradient colors={['rgba(0,0,0,0.4)', 'rgba(0,0,0,0.2)']} style={styles.withdrawBtnGradient}>
                <MaterialCommunityIcons name="bank-transfer" size={16} color={Colors.gold} />
                <Text style={styles.withdrawBtnText}>Withdraw SHIB</Text>
              </LinearGradient>
            </Pressable>
          </LinearGradient>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(250).springify()} style={styles.tierCard}>
          <View style={styles.tierRow}>
            <Ionicons name="layers-outline" size={18} color={Colors.neonOrange} />
            <Text style={styles.tierLabel}>Withdrawal Tier {withdrawalTier}</Text>
            <Text style={styles.tierMin}>Min: {formatShib(minWithdrawalAmount)} SHIB</Text>
          </View>
          <Text style={styles.tierDesc}>
            {withdrawalTier === 1 ? 'First withdrawal' : withdrawalTier === 2 ? 'Second withdrawal' : 'Third+ withdrawal'} — higher tiers unlock after completing previous withdrawals.
          </Text>
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
                <Text style={styles.ptSub}>Used to buy boosters for mining</Text>
              </View>
              <Text style={styles.ptValue}>{powerTokens}</Text>
            </View>
          </LinearGradient>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(500).springify()}>
          <Text style={styles.sectionTitle}>Withdrawal History</Text>
          {withdrawals.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="receipt-outline" size={40} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No withdrawals yet</Text>
              <Text style={styles.emptyDesc}>Mine SHIB and withdraw when you reach the minimum threshold</Text>
            </View>
          ) : (
            <View style={styles.txList}>
              {withdrawals.map((w) => (
                <WithdrawalItem key={w.id} w={w} />
              ))}
            </View>
          )}
        </Animated.View>
      </ScrollView>

      <Modal visible={showWithdraw} transparent animationType="slide" onRequestClose={() => setShowWithdraw(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Withdraw SHIB</Text>
            <Text style={styles.modalSub}>Minimum: {formatShib(minWithdrawalAmount)} SHIB (Tier {withdrawalTier})</Text>

            <Text style={styles.fieldLabel}>Method</Text>
            <View style={styles.methodRow}>
              {['Binance', 'BEP-20', 'Easypaisa'].map(m => (
                <Pressable
                  key={m}
                  style={[styles.methodBtn, method === m && styles.methodBtnActive]}
                  onPress={() => setMethod(m)}
                >
                  <Text style={[styles.methodBtnText, method === m && styles.methodBtnTextActive]}>{m}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.fieldLabel}>Address / Email</Text>
            <TextInput
              style={styles.input}
              value={address}
              onChangeText={setAddress}
              placeholder="Enter wallet address or email"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
            />

            <Text style={styles.fieldLabel}>Amount (SHIB)</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={setAmount}
              placeholder={`Min ${formatShib(minWithdrawalAmount)}`}
              placeholderTextColor={Colors.textMuted}
              keyboardType="numeric"
            />

            <Pressable
              style={({ pressed }) => [styles.submitBtn, { opacity: pressed || submitting ? 0.8 : 1 }]}
              onPress={handleWithdraw}
              disabled={submitting}
            >
              <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.submitBtnGradient}>
                <Text style={styles.submitBtnText}>{submitting ? 'Submitting...' : 'Submit Request'}</Text>
              </LinearGradient>
            </Pressable>

            <Pressable onPress={() => setShowWithdraw(false)} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
  withdrawBtn: { marginTop: 8, width: '100%' },
  withdrawBtnGradient: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)' },
  withdrawBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.gold },
  tierCard: { backgroundColor: Colors.darkCard, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: Colors.darkBorder },
  tierRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  tierLabel: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.neonOrange },
  tierMin: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  tierDesc: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, lineHeight: 18 },
  ptCard: { borderRadius: 18, overflow: 'hidden', marginBottom: 24, borderWidth: 1, borderColor: 'rgba(255,107,0,0.25)' },
  ptCardInner: { padding: 18 },
  ptRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  ptIconWrap: { width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(255,107,0,0.15)', alignItems: 'center', justifyContent: 'center' },
  ptInfo: { flex: 1 },
  ptLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 15, color: Colors.textPrimary },
  ptSub: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  ptValue: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.neonOrange },
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  emptyState: { backgroundColor: Colors.darkCard, borderRadius: 18, padding: 40, alignItems: 'center', gap: 10, borderWidth: 1, borderColor: Colors.darkBorder },
  emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 16, color: Colors.textSecondary },
  emptyDesc: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center' },
  txList: { gap: 2 },
  txItem: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: Colors.darkCard, borderRadius: 14, padding: 14, marginBottom: 6 },
  txIconWrap: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  txInfo: { flex: 1 },
  txDesc: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textPrimary },
  txTime: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  txAmountWrap: { alignItems: 'flex-end' },
  txAmount: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  txCurrency: { fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 1 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalSheet: { backgroundColor: Colors.darkCard, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 12 },
  modalHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.darkBorder, alignSelf: 'center', marginBottom: 8 },
  modalTitle: { fontFamily: 'Inter_700Bold', fontSize: 20, color: Colors.textPrimary, textAlign: 'center' },
  modalSub: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center', marginBottom: 4 },
  fieldLabel: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.textSecondary },
  methodRow: { flexDirection: 'row', gap: 8 },
  methodBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: Colors.darkBorder, alignItems: 'center' },
  methodBtnActive: { borderColor: Colors.gold, backgroundColor: 'rgba(244,196,48,0.1)' },
  methodBtnText: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textMuted },
  methodBtnTextActive: { color: Colors.gold },
  input: { backgroundColor: Colors.darkSurface, borderRadius: 12, height: 48, paddingHorizontal: 16, fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.darkBorder },
  submitBtn: { marginTop: 8 },
  submitBtnGradient: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  submitBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  cancelBtn: { alignItems: 'center', paddingVertical: 8 },
  cancelText: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textMuted },
});
