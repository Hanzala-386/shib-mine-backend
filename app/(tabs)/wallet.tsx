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
import { useAds } from '@/context/AdContext';
import Colors from '@/constants/colors';
import SpinningCoin from '@/components/SpinningCoin';

const BEP20_FEE = 3680; // fixed SHIB fee for BEP-20 network withdrawals

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
        <Text style={[styles.txAmount, { color }]}>-{formatShib(w.amount)}</Text>
        <Text style={[styles.txCurrency, { color }]}>{w.status.toUpperCase()}</Text>
      </View>
    </View>
  );
}

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const { shibBalance, powerTokens, withdrawals, withdrawalTier, minWithdrawalAmount, createWithdrawal } = useWallet();
  const { pbUser } = useAuth();
  const { showMiningInterstitial } = useAds();
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [method, setMethod] = useState<'BEP-20' | 'Binance Email'>('Binance Email');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const addressLabel = method === 'BEP-20' ? 'BEP-20 Wallet Address' : 'Binance Email';
  const addressPlaceholder = method === 'BEP-20' ? 'Enter your BEP-20 address (0x...)' : 'Enter your Binance email';

  /* ── Pending withdrawal lock ── */
  const hasPendingWithdrawal = withdrawals.some(w => w.status === 'pending');

  /* ── Address / Email validation ── */
  const trimmedAddr = address.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const isValidEmail   = method === 'BEP-20' || emailRegex.test(trimmedAddr);
  const isValidAddress = method === 'Binance Email' || trimmedAddr.length >= 30;
  const addressError =
    trimmedAddr.length === 0 ? ''
    : method === 'Binance Email' && !isValidEmail ? 'Invalid Email Format'
    : method === 'BEP-20' && !isValidAddress ? 'Aapka wallet address galat hai (Minimum 30 characters required).'
    : '';

  /* ── Fee calculations ── */
  const grossAmt = parseFloat(amount) || 0;
  const fee      = method === 'BEP-20' ? BEP20_FEE : 0;
  const netAmt   = Math.max(0, grossAmt - fee);

  const hasEnoughBalance    = grossAmt > 0 && grossAmt <= shibBalance;
  const netMeetsMinimum     = netAmt >= minWithdrawalAmount;
  const showInsufficientMsg = grossAmt > 0 && fee > 0 && !netMeetsMinimum;
  const canSubmit           = !hasPendingWithdrawal && grossAmt > 0 && hasEnoughBalance && netMeetsMinimum && !!trimmedAddr && isValidEmail && isValidAddress && !submitting;

  async function handleWithdraw() {
    if (hasPendingWithdrawal) {
      Alert.alert('Withdrawal Pending', 'Aapka pichla withdrawal abhi pending hai. Please uske complete hone ka intezar karein.');
      return;
    }
    if (!grossAmt || isNaN(grossAmt) || grossAmt <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount.');
      return;
    }
    if (grossAmt > shibBalance) {
      Alert.alert('Insufficient Balance', `You only have ${formatShib(shibBalance)} SHIB.`);
      return;
    }
    if (!netMeetsMinimum) {
      Alert.alert(
        'Net Amount Too Low',
        `After the ${formatShib(fee)} SHIB fee, you would receive ${formatShib(netAmt)} SHIB — below the minimum of ${formatShib(minWithdrawalAmount)} SHIB.`
      );
      return;
    }
    if (!trimmedAddr) {
      Alert.alert('Missing Address', 'Please enter your wallet address or email.');
      return;
    }
    if (method === 'Binance Email' && !isValidEmail) {
      Alert.alert('Invalid Email Format', 'Please enter a valid email address (e.g. user@example.com).');
      return;
    }
    if (method === 'BEP-20' && !isValidAddress) {
      Alert.alert('Invalid Wallet Address', 'Aapka wallet address galat hai (Minimum 30 characters required).');
      return;
    }
    setSubmitting(true);
    // Show Unity → AppLovin interstitial before processing (no AdMob per policy)
    await new Promise<void>((resolve) => {
      showMiningInterstitial(() => resolve());
    });
    const res = await createWithdrawal(method, address.trim(), grossAmt);
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

  function handleMethodChange(m: 'BEP-20' | 'Binance Email') {
    setMethod(m);
    setAddress('');
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
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16), paddingBottom: insets.bottom + 140 }]}
      >
        <Animated.View entering={FadeInDown.delay(100).springify()}>
          <Text style={styles.pageTitle}>Wallet</Text>
        </Animated.View>

        {/* ── Main SHIB balance card ── */}
        <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.mainCard}>
          <LinearGradient
            colors={['rgba(244,196,48,0.2)', 'rgba(255,107,0,0.12)']}
            style={styles.mainCardGradient}
          >
            <View style={styles.mainCardHeader}>
              <SpinningCoin size={28} spinning speed="slow" />
              <Text style={styles.mainCardLabel}>SHIB Balance</Text>
            </View>
            <Text style={styles.mainBalance}>{formatShib(shibBalance)}</Text>
            <Text style={styles.mainBalanceFull}>{shibBalance.toLocaleString()} SHIB</Text>
            {hasPendingWithdrawal && (
              <View style={styles.pendingBanner}>
                <Ionicons name="time-outline" size={13} color={Colors.gold} />
                <Text style={styles.pendingBannerText}>1 withdrawal pending review</Text>
              </View>
            )}
            <Pressable
              style={({ pressed }) => [styles.withdrawBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={() => {
                if (hasPendingWithdrawal) {
                  Alert.alert('Withdrawal Pending', 'Aapka pichla withdrawal abhi pending hai. Please uske complete hone ka intezar karein.');
                } else {
                  setShowWithdraw(true);
                }
              }}
            >
              <LinearGradient colors={['rgba(0,0,0,0.4)', 'rgba(0,0,0,0.2)']} style={styles.withdrawBtnGradient}>
                <MaterialCommunityIcons name="bank-transfer" size={16} color={Colors.gold} />
                <Text style={styles.withdrawBtnText}>Withdraw SHIB</Text>
              </LinearGradient>
            </Pressable>
          </LinearGradient>
        </Animated.View>

        {/* ── Tier info ── */}
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

        {/* ── Power Tokens ── */}
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

        {/* ── Withdrawal History ── */}
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

      {/* ══ WITHDRAWAL MODAL ════════════════════════════════════════════════ */}
      <Modal visible={showWithdraw} transparent animationType="slide" onRequestClose={() => setShowWithdraw(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Withdraw SHIB</Text>
            <Text style={styles.modalSub}>Tier {withdrawalTier} · Min {formatShib(minWithdrawalAmount)} SHIB (net)</Text>

            {/* ── Method selector ── */}
            <Text style={styles.fieldLabel}>Withdrawal Method</Text>
            <View style={styles.methodRow}>
              {(['Binance Email', 'BEP-20'] as const).map(m => {
                const isActive = method === m;
                const isFree   = m === 'Binance Email';
                return (
                  <Pressable
                    key={m}
                    style={[styles.methodBtn, isActive && styles.methodBtnActive]}
                    onPress={() => handleMethodChange(m)}
                  >
                    <View style={styles.methodBtnInner}>
                      <MaterialCommunityIcons
                        name={m === 'BEP-20' ? 'ethereum' : 'email-outline'}
                        size={14}
                        color={isActive ? Colors.gold : Colors.textMuted}
                      />
                      <Text style={[styles.methodBtnText, isActive && styles.methodBtnTextActive]}>{m}</Text>
                    </View>
                    <View style={[styles.feeBadge, isFree ? styles.feeBadgeFree : styles.feeBadgePaid]}>
                      <Text style={[styles.feeBadgeText, isFree ? styles.feeBadgeTextFree : styles.feeBadgeTextPaid]}>
                        {isFree ? 'FREE' : `${formatShib(BEP20_FEE)} SHIB`}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            {/* ── Address / email input ── */}
            <Text style={styles.fieldLabel}>{addressLabel}</Text>
            <TextInput
              style={[styles.input, addressError ? styles.inputError : null]}
              value={address}
              onChangeText={setAddress}
              placeholder={addressPlaceholder}
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
              keyboardType={method === 'Binance Email' ? 'email-address' : 'default'}
            />
            {addressError ? (
              <View style={styles.fieldError}>
                <Ionicons name="alert-circle-outline" size={13} color="#ff5252" />
                <Text style={styles.fieldErrorText}>{addressError}</Text>
              </View>
            ) : null}

            {/* ── Amount input ── */}
            <Text style={styles.fieldLabel}>Gross Amount (SHIB)</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={setAmount}
              placeholder={`Enter SHIB amount (Balance: ${formatShib(shibBalance)})`}
              placeholderTextColor={Colors.textMuted}
              keyboardType="numeric"
            />

            {/* ── Fee calculation table (shows when amount is entered) ── */}
            {grossAmt > 0 && (
              <View style={styles.calcBox}>
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>Gross Amount</Text>
                  <Text style={styles.calcVal}>{grossAmt.toLocaleString()} SHIB</Text>
                </View>
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>
                    Fee {method === 'BEP-20' ? '(BEP-20 Network)' : '(Binance Email)'}
                  </Text>
                  <Text style={[styles.calcVal, fee === 0 && styles.calcValFree]}>
                    {fee === 0 ? '— FREE' : `- ${formatShib(fee)} SHIB`}
                  </Text>
                </View>
                <View style={[styles.calcDivider]} />
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabelBold}>You Receive</Text>
                  <Text style={[styles.calcValBold, netMeetsMinimum ? styles.calcValGold : styles.calcValRed]}>
                    {netAmt.toLocaleString()} SHIB
                  </Text>
                </View>
              </View>
            )}

            {/* ── Insufficient after fees message ── */}
            {showInsufficientMsg && (
              <View style={styles.insufficientBanner}>
                <Ionicons name="warning-outline" size={14} color="#ff5252" />
                <Text style={styles.insufficientText}>
                  Insufficient balance after fees. Min net: {formatShib(minWithdrawalAmount)} SHIB
                </Text>
              </View>
            )}

            {/* ── Submit button ── */}
            <Pressable
              style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
              onPress={handleWithdraw}
              disabled={!canSubmit}
            >
              <LinearGradient
                colors={canSubmit ? [Colors.gold, Colors.neonOrange] : ['#2a2a2a', '#1a1a1a']}
                style={styles.submitBtnGradient}
              >
                <Text style={[styles.submitBtnText, !canSubmit && styles.submitBtnTextDim]}>
                  {submitting ? 'Submitting…' : canSubmit ? `Submit — ${netAmt.toLocaleString()} SHIB` : 'Enter valid amount'}
                </Text>
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

  /* ── Modal ── */
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalSheet:   { backgroundColor: Colors.darkCard, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 10 },
  modalHandle:  { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.darkBorder, alignSelf: 'center', marginBottom: 4 },
  modalTitle:   { fontFamily: 'Inter_700Bold', fontSize: 20, color: Colors.textPrimary, textAlign: 'center' },
  modalSub:     { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center' },
  fieldLabel:   { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.textSecondary, marginTop: 4 },

  /* ── Method selector ── */
  methodRow: { flexDirection: 'row', gap: 8 },
  methodBtn: { flex: 1, borderRadius: 12, borderWidth: 1, borderColor: Colors.darkBorder,
    paddingVertical: 10, paddingHorizontal: 10, gap: 6 },
  methodBtnActive: { borderColor: Colors.gold, backgroundColor: 'rgba(244,196,48,0.08)' },
  methodBtnInner:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  methodBtnText:       { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textMuted },
  methodBtnTextActive: { color: Colors.gold },
  feeBadge:     { alignSelf: 'center', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, marginTop: 4 },
  feeBadgeFree: { backgroundColor: 'rgba(76,175,80,0.15)', borderWidth: 1, borderColor: 'rgba(76,175,80,0.4)' },
  feeBadgePaid: { backgroundColor: 'rgba(255,82,82,0.12)', borderWidth: 1, borderColor: 'rgba(255,82,82,0.3)' },
  feeBadgeText:     { fontFamily: 'Inter_700Bold', fontSize: 10, textAlign: 'center' },
  feeBadgeTextFree: { color: '#4CAF50' },
  feeBadgeTextPaid: { color: '#ff5252' },

  /* ── Inputs ── */
  input: { backgroundColor: Colors.darkSurface, borderRadius: 12, height: 48, paddingHorizontal: 16,
    fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textPrimary,
    borderWidth: 1, borderColor: Colors.darkBorder },

  /* ── Fee calculation table ── */
  calcBox: { backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', gap: 8 },
  calcRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  calcDivider:  { height: 1, backgroundColor: 'rgba(255,255,255,0.09)', marginVertical: 2 },
  calcLabel:    { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
  calcLabelBold:{ fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textPrimary },
  calcVal:      { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textSecondary },
  calcValFree:  { color: '#4CAF50' },
  calcValBold:  { fontFamily: 'Inter_700Bold', fontSize: 15 },
  calcValGold:  { color: Colors.gold },
  calcValRed:   { color: '#ff5252' },

  /* ── Insufficient banner ── */
  insufficientBanner: { flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(255,82,82,0.1)', borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: 'rgba(255,82,82,0.25)' },
  insufficientText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 12, color: '#ff5252', lineHeight: 16 },

  /* ── Submit button ── */
  submitBtn:         { marginTop: 4 },
  submitBtnDisabled: { opacity: 0.7 },
  submitBtnGradient: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  submitBtnText:     { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  submitBtnTextDim:  { color: Colors.textMuted },

  cancelBtn:  { alignItems: 'center', paddingVertical: 8 },
  cancelText: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textMuted },

  pendingBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(244,196,48,0.12)', borderRadius: 10,
    paddingVertical: 6, paddingHorizontal: 12, marginTop: 4,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)',
  },
  pendingBannerText: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.gold },

  inputError: { borderColor: '#ff5252' },
  fieldError: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginTop: -4 },
  fieldErrorText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 12, color: '#ff5252', lineHeight: 16 },
});
