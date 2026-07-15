import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Platform, Pressable, TextInput, Alert, Modal, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import { useWallet, type WithdrawalRecord } from '@/context/WalletContext';
import { useAuth } from '@/context/AuthContext';
import { useAds } from '@/context/AdContext';
import KycGateModal, { useKycGate } from '@/components/KycGate';
import Colors from '@/constants/colors';
import SpinningCoin from '@/components/SpinningCoin';
import { InlineBannerAd } from '@/components/StickyBannerAd';
import { pb } from '@/lib/pocketbase';
import type { MiningHistoryRecord } from '@/lib/api';

const SHIBA_TICKET = require('@/assets/images/shiba_ticket_diamond.png');
const REDEEM_BG = require('@/assets/images/redeem_bg.png');

const BEP20_FEE         = 3680;   // fixed SHIB fee for BEP-20 network withdrawals
const BEP20_MIN_BALANCE = 50_000; // balance required to unlock BEP-20 withdrawals

const WITHDRAWAL_RULES: { title: string; body: string }[] = [
  {
    title: 'Binance Account Alignment',
    body: 'You must possess a registered Binance account matching the exact email address you specify for withdrawal.',
  },
  {
    title: 'Identity Verification',
    body: 'Your Binance account must have completed Identity Verification (KYC). Failure to do so will result in an automatic withdrawal rejection.',
  },
  {
    title: 'Anti-Cheat / Hacking Policy',
    body: 'Use of any hacking tools, automated clickers, or malicious scripts will lead to an immediate, permanent ID ban and rejection of all pending withdrawals.',
  },
  {
    title: 'Pre-Flight Check',
    body: 'Always double-check and verify that your Binance identity status is completely active and valid before initiating a transaction to prevent losing funds.',
  },
  {
    title: 'Independent Network Fees',
    body: 'Ensure your account is ready to receive assets over the designated network option.',
  },
];

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

function formatMultiplier(m: number) {
  if (!m || m <= 1) return '1x';
  return `${m}x`;
}

function MiningHistoryItem({ item }: { item: MiningHistoryRecord }) {
  const color = item.boosterMultiplier > 1 ? Colors.neonOrange : Colors.gold;
  return (
    <View style={styles.txItem}>
      <View style={[styles.txIconWrap, { backgroundColor: color + '20' }]}>
        <MaterialCommunityIcons name="pickaxe" size={18} color={color} />
      </View>
      <View style={styles.txInfo}>
        <Text style={styles.txDesc} numberOfLines={1}>
          Mining Claim {item.boosterMultiplier > 1 ? `· ${formatMultiplier(item.boosterMultiplier)} Boost` : ''}
        </Text>
        <Text style={styles.txTime}>{formatDate(item.created)}</Text>
      </View>
      <View style={styles.txAmountWrap}>
        <Text style={[styles.txAmount, { color }]}>+{formatShib(item.claimedAmount)}</Text>
        <Text style={[styles.txCurrency, { color }]}>SHIB</Text>
      </View>
    </View>
  );
}

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const { shibBalance, lockedShibBalance, availableShibBalance, powerTokens, hitTickets, withdrawals, withdrawalTier, minWithdrawalAmount, createWithdrawal } = useWallet();
  const { pbUser } = useAuth();
  const { showMiningInterstitial } = useAds();
  const { isKycVerified } = useKycGate();
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [binanceVerified, setBinanceVerified] = useState(false);
  const [showKycGate, setShowKycGate] = useState(false);
  const [miningHistory, setMiningHistory] = useState<MiningHistoryRecord[]>([]);

  /* ── KYC destination routing — Binance Email only for verified India users ── */
  const canUseBinance = pbUser?.kycCountry === 'India' && !!pbUser?.kycBinanceEmail;
  const [method, setMethod] = useState<'BEP-20' | 'Binance Email'>(canUseBinance ? 'Binance Email' : 'BEP-20');

  // Whole-tab KYC gate: popup every time a non-verified user lands on Wallet
  useFocusEffect(
    useCallback(() => {
      setShowKycGate(!isKycVerified);
      return () => setShowKycGate(false);
    }, [isKycVerified]),
  );

  const fetchMiningHistory = useCallback(async (pbId: string) => {
    try {
      const filter = `user="${pbId}" && claimed_amount > 0`;
      const res = await pb.collection('mining_sessions').getList(1, 20, {
        filter,
        sort: '-created',
        fields: 'id,start_time,claimed_amount,booster_multiplier,created',
      });
      const records: MiningHistoryRecord[] = res.items.map((s: any) => ({
        id:                s.id,
        startTime:         s.start_time,
        claimedAmount:     s.claimed_amount ?? 0,
        boosterMultiplier: s.booster_multiplier || 1,
        created:           s.created,
      }));
      setMiningHistory(records);
    } catch {}
  }, []);

  useEffect(() => {
    if (pbUser?.pbId) {
      fetchMiningHistory(pbUser.pbId);
    }
  }, [pbUser, fetchMiningHistory]);
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /* ── BEP-20 balance lock — requires 50,000+ SHIB. Only applies when the user
     has a Binance Email alternative (India); BEP-20-only users are never locked
     out of their sole withdrawal method. ── */
  const isBep20Locked = canUseBinance && shibBalance < BEP20_MIN_BALANCE;

  // Keep method consistent with the verified destination options
  useEffect(() => {
    if (!canUseBinance && method === 'Binance Email') setMethod('BEP-20');
    if (isBep20Locked && method === 'BEP-20') setMethod('Binance Email');
  }, [canUseBinance, isBep20Locked, method]);

  /* ── Verified destination (read-only — server resolves the actual payout target) ── */
  const destination = method === 'BEP-20'
    ? (pbUser?.kycBep20Address || '')
    : (pbUser?.kycBinanceEmail || '');

  /* ── Pending withdrawal lock ── */
  const hasPendingWithdrawal = withdrawals.some(w => w.status === 'pending');

  /* ── Fee calculations ── */
  const grossAmt = parseFloat(amount) || 0;
  const fee      = method === 'BEP-20' ? BEP20_FEE : 0;
  const netAmt   = Math.max(0, grossAmt - fee);

  const hasEnoughBalance    = grossAmt > 0 && grossAmt <= availableShibBalance;
  const netMeetsMinimum     = netAmt >= minWithdrawalAmount;
  const showInsufficientMsg = grossAmt > 0 && fee > 0 && !netMeetsMinimum;
  const canSubmit           = !hasPendingWithdrawal && grossAmt > 0 && hasEnoughBalance && netMeetsMinimum && !!destination && !submitting;

  function handleSubmitPress() {
    if (hasPendingWithdrawal) {
      Alert.alert('Withdrawal Pending', 'Your previous request is currently under review. Please wait for it to be processed before initiating a new one.');
      return;
    }
    if (!grossAmt || isNaN(grossAmt) || grossAmt <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount.');
      return;
    }
    if (grossAmt > availableShibBalance) {
      Alert.alert(
        lockedShibBalance > 0 ? 'Amount Exceeds Available Balance' : 'Insufficient Balance',
        lockedShibBalance > 0
          ? `Your active VIP tier locks ${formatShib(lockedShibBalance)} SHIB in your wallet. You can withdraw up to ${formatShib(availableShibBalance)} SHIB. Contact support@shibahit.com to remove your VIP tier.`
          : `You only have ${formatShib(shibBalance)} SHIB.`
      );
      return;
    }
    if (!netMeetsMinimum) {
      Alert.alert(
        'Net Amount Too Low',
        `After the ${formatShib(fee)} SHIB fee, you would receive ${formatShib(netAmt)} SHIB — below the minimum of ${formatShib(minWithdrawalAmount)} SHIB.`
      );
      return;
    }
    if (!destination) {
      Alert.alert('No Verified Destination', 'Your verified withdrawal destination is missing. Please contact support.');
      return;
    }
    // All validation passed — show the warning popup before processing
    setShowWarning(true);
  }

  async function handleConfirmedWithdraw() {
    setShowWarning(false);
    setSubmitting(true);
    // Show Unity → AppLovin interstitial before processing (no AdMob per policy)
    await new Promise<void>((resolve) => {
      showMiningInterstitial(() => resolve());
    });
    const res = await createWithdrawal(method, grossAmt);
    setSubmitting(false);
    if (res.success) {
      setShowWithdraw(false);
      setAmount('');
      Alert.alert('Submitted!', 'Your withdrawal request has been submitted for review.');
    } else {
      Alert.alert('Failed', res.error || 'Could not submit withdrawal.');
    }
  }

  function handleMethodChange(m: 'BEP-20' | 'Binance Email') {
    setMethod(m);
    setBinanceVerified(false);
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

        {/* ── Guaranteed fast-withdrawal banner ── */}
        <Animated.View entering={FadeInDown.delay(150).springify()}>
          <Pressable
            testID="withdrawal-guarantee-banner"
            accessibilityRole="button"
            accessibilityLabel="Guaranteed 12-hour fast withdrawals. View rules and regulations"
            style={({ pressed }) => [styles.guarBanner, { opacity: pressed ? 0.9 : 1 }]}
            onPress={() => setShowRules(true)}
          >
            <LinearGradient
              colors={['rgba(244,196,48,0.22)', 'rgba(255,107,0,0.12)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.guarBannerInner}
            >
              <View style={styles.guarIconWrap}>
                <MaterialCommunityIcons name="shield-check" size={22} color={Colors.gold} />
              </View>
              <View style={styles.guarTextWrap}>
                <Text style={styles.guarHeadline}>Guaranteed 12-Hour Fast Withdrawals</Text>
                <View style={styles.guarLinkRow}>
                  <Text style={styles.guarLink}>View Rules &amp; Regulations</Text>
                  <Ionicons name="chevron-forward" size={13} color={Colors.gold} />
                </View>
              </View>
            </LinearGradient>
          </Pressable>
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
            {lockedShibBalance > 0 && (
              <View style={styles.lockRow}>
                <View style={styles.lockChip}>
                  <Ionicons name="lock-closed" size={11} color={Colors.gold} />
                  <Text style={styles.lockChipText}>VIP Locked {formatShib(lockedShibBalance)}</Text>
                </View>
                <View style={styles.lockChip}>
                  <Ionicons name="wallet-outline" size={11} color={Colors.success} />
                  <Text style={[styles.lockChipText, { color: Colors.success }]}>Available {formatShib(availableShibBalance)}</Text>
                </View>
              </View>
            )}
            {hasPendingWithdrawal && (
              <View style={styles.pendingBanner}>
                <Ionicons name="time-outline" size={13} color={Colors.gold} />
                <Text style={styles.pendingBannerText}>1 withdrawal pending review</Text>
              </View>
            )}
            <Pressable
              style={({ pressed }) => [styles.withdrawBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={() => {
                if (!isKycVerified) {
                  setShowKycGate(true);
                } else if (hasPendingWithdrawal) {
                  Alert.alert('Withdrawal Pending', 'Your previous request is currently under review. Please wait for it to be processed before initiating a new one.');
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

        {/* ── Hit Tickets ── */}
        <Animated.View entering={FadeInDown.delay(350).springify()} style={styles.htCard}>
          <LinearGradient
            colors={['rgba(244,196,48,0.15)', 'rgba(255,107,0,0.05)']}
            style={styles.ptCardInner}
          >
            <View style={styles.ptRow}>
              <View style={styles.htIconWrap}>
                <Image source={SHIBA_TICKET} style={{ width: 34, height: 24 }} resizeMode="contain" />
              </View>
              <View style={styles.ptInfo}>
                <Text style={styles.ptLabel}>Hit Tickets</Text>
                <Text style={styles.ptSub}>Redeem for SHIB in the Redemption Center</Text>
              </View>
              <Text style={styles.htValue}>{hitTickets}</Text>
            </View>
            <Pressable
              testID="redemption-center-button"
              accessibilityRole="button"
              accessibilityLabel="Open Redemption Center"
              style={({ pressed }) => [styles.redeemBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={() => router.push('/redeem' as any)}
            >
              <Image source={REDEEM_BG} style={styles.redeemBtnImg} resizeMode="contain" />
            </Pressable>
          </LinearGradient>
        </Animated.View>

        {/* ── Withdrawal History (moved ABOVE Mining History) ── */}
        <Animated.View entering={FadeInDown.delay(400).springify()} style={{ marginBottom: 28 }}>
          <Text style={styles.sectionTitle}>Withdrawal History</Text>
          {withdrawals.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="receipt-outline" size={40} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No withdrawals yet</Text>
              <Text style={styles.emptyDesc}>Mine SHIB and withdraw when you reach the minimum threshold</Text>
            </View>
          ) : (
            <View style={styles.txList}>
              {withdrawals.map((w, idx) => (
                <React.Fragment key={w.id}>
                  <WithdrawalItem w={w} />
                  {/* Banner ad after every 2nd withdrawal log (no trailing banner). */}
                  {(idx + 1) % 2 === 0 && idx < withdrawals.length - 1 && <InlineBannerAd />}
                </React.Fragment>
              ))}
            </View>
          )}
        </Animated.View>

        {/* ── Mining History (moved BELOW Withdrawal History) ── */}
        <Animated.View entering={FadeInDown.delay(500).springify()}>
          <Text style={styles.sectionTitle}>Mining History</Text>
          {miningHistory.length === 0 ? (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons name="pickaxe" size={40} color={Colors.textMuted} />
              <Text style={styles.emptyTitle}>No claims yet</Text>
              <Text style={styles.emptyDesc}>Your completed mining sessions will appear here</Text>
            </View>
          ) : (
            <View style={styles.txList}>
              {miningHistory.map((item, idx) => (
                <React.Fragment key={item.id}>
                  <MiningHistoryItem item={item} />
                  {/* Banner ad after every 2nd mining log (no trailing banner). */}
                  {(idx + 1) % 2 === 0 && idx < miningHistory.length - 1 && <InlineBannerAd />}
                </React.Fragment>
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
            {lockedShibBalance > 0 && (
              <Text style={styles.modalLockNote}>
                Available to withdraw: {formatShib(availableShibBalance)} SHIB · {formatShib(lockedShibBalance)} locked by VIP
              </Text>
            )}

            {/* ── Method selector — options limited to the user's verified
                 destinations (Binance Email only for verified India users) ── */}
            <Text style={styles.fieldLabel}>Withdrawal Method</Text>
            <View style={styles.methodRow}>
              {(canUseBinance ? (['Binance Email', 'BEP-20'] as const) : (['BEP-20'] as const)).map(m => {
                const isActive  = method === m;
                const isFree    = m === 'Binance Email';
                const isLocked  = m === 'BEP-20' && isBep20Locked;
                return (
                  <Pressable
                    key={m}
                    style={[
                      styles.methodBtn,
                      isActive && styles.methodBtnActive,
                      isLocked && styles.methodBtnLocked,
                    ]}
                    onPress={() => !isLocked && handleMethodChange(m)}
                    disabled={isLocked}
                  >
                    <View style={styles.methodBtnInner}>
                      <MaterialCommunityIcons
                        name={m === 'BEP-20' ? 'ethereum' : 'email-outline'}
                        size={14}
                        color={isLocked ? Colors.textMuted : isActive ? Colors.gold : Colors.textMuted}
                      />
                      <Text style={[
                        styles.methodBtnText,
                        isActive && !isLocked && styles.methodBtnTextActive,
                        isLocked && styles.methodBtnTextLocked,
                      ]}>
                        {m}
                      </Text>
                      {isLocked && (
                        <Ionicons name="lock-closed" size={13} color={Colors.textMuted} style={{ marginLeft: 2 }} />
                      )}
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

            {/* ── BEP-20 lock notice ── */}
            {isBep20Locked && (
              <View style={styles.bep20LockNotice}>
                <Ionicons name="lock-closed-outline" size={13} color="#ff5252" />
                <Text style={styles.bep20LockText}>
                  BEP20 withdrawal method unlock automatically once your balance exceed 50000 coins.
                </Text>
              </View>
            )}

            {/* ── Verified destination — read-only, locked to KYC record ── */}
            <Text style={styles.fieldLabel}>
              {method === 'BEP-20' ? 'BEP-20 Wallet Address' : 'Binance Email'} (Verified)
            </Text>
            <View style={styles.destBox}>
              <Ionicons name="shield-checkmark" size={15} color={Colors.success} />
              <Text style={styles.destBoxText} numberOfLines={1}>
                {destination || 'No verified destination on file'}
              </Text>
              <Ionicons name="lock-closed" size={13} color={Colors.textMuted} />
            </View>
            <Text style={styles.destHint}>
              Funds are sent to your verified {method === 'BEP-20' ? 'wallet address' : 'Binance email'}. To change it, contact support.
            </Text>

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
              onPress={handleSubmitPress}
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

      {/* ══ WARNING POPUP ════════════════════════════════════════════════════ */}
      <Modal visible={showWarning} transparent animationType="fade" onRequestClose={() => { setShowWarning(false); setBinanceVerified(false); }}>
        <View style={styles.warnOverlay}>
          <View style={styles.warnSheet}>
            <View style={styles.warnIconWrap}>
              <Ionicons name="warning" size={40} color="#FF3B30" />
            </View>
            <Text style={styles.warnTitle}>⚠️ IMPORTANT WARNING</Text>

            {method === 'Binance Email' ? (
              <>
                <Text style={styles.warnBody}>
                  If your Binance email is <Text style={styles.warnBold}>NOT verified</Text>, the funds will be{' '}
                  <Text style={styles.warnBold}>permanently lost</Text> and cannot be recovered.{'\n\n'}
                  Please also confirm the email address below is correct before proceeding.
                </Text>
                <View style={styles.warnAddrBox}>
                  <Text style={styles.warnAddrLabel}>Binance Email (Verified)</Text>
                  <Text style={styles.warnAddrValue} numberOfLines={2}>{destination}</Text>
                </View>
                {/* Verification checkbox */}
                <Pressable
                  style={styles.checkRow}
                  onPress={() => setBinanceVerified(v => !v)}
                >
                  <View style={[styles.checkbox, binanceVerified && styles.checkboxChecked]}>
                    {binanceVerified && <Ionicons name="checkmark" size={14} color="#000" />}
                  </View>
                  <Text style={styles.checkLabel}>I confirm that my Binance account is fully verified.</Text>
                </Pressable>
                <Pressable
                  style={[styles.warnConfirmBtn, !binanceVerified && styles.warnConfirmBtnDisabled]}
                  onPress={binanceVerified ? handleConfirmedWithdraw : undefined}
                  disabled={!binanceVerified}
                >
                  <Text style={[styles.warnConfirmText, !binanceVerified && { opacity: 0.45 }]}>
                    I Understand — Confirm
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.warnBody}>
                  Please double-check your wallet address. If you provide an incorrect address, your funds will be{' '}
                  <Text style={styles.warnBold}>permanently lost</Text> and cannot be recovered.
                </Text>
                <View style={styles.warnAddrBox}>
                  <Text style={styles.warnAddrLabel}>Wallet Address (Verified)</Text>
                  <Text style={styles.warnAddrValue} numberOfLines={2}>{destination}</Text>
                </View>
                <Pressable style={styles.warnConfirmBtn} onPress={handleConfirmedWithdraw}>
                  <Text style={styles.warnConfirmText}>I Understand — Confirm</Text>
                </Pressable>
              </>
            )}

            <Pressable style={styles.warnCancelBtn} onPress={() => { setShowWarning(false); setBinanceVerified(false); }}>
              <Text style={styles.warnCancelText}>Go Back &amp; Check</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ══ WITHDRAWAL RULES MODAL ══════════════════════════════════════════ */}
      <Modal visible={showRules} transparent animationType="fade" onRequestClose={() => setShowRules(false)}>
        <View style={styles.rulesOverlay}>
          <View style={styles.rulesSheet}>
            <View style={styles.rulesHeader}>
              <View style={styles.rulesIconWrap}>
                <MaterialCommunityIcons name="shield-check" size={26} color={Colors.gold} />
              </View>
              <Text style={styles.rulesTitle}>Rules &amp; Regulations</Text>
              <Text style={styles.rulesSub}>Withdrawals are guaranteed within 12 hours when every rule below is met.</Text>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              style={styles.rulesScroll}
              contentContainerStyle={styles.rulesScrollContent}
            >
              {WITHDRAWAL_RULES.map((r, i) => (
                <View key={i} style={styles.ruleRow}>
                  <View style={styles.ruleNumBadge}>
                    <Text style={styles.ruleNum}>{i + 1}</Text>
                  </View>
                  <View style={styles.ruleTextWrap}>
                    <Text style={styles.ruleTitle}>{r.title}</Text>
                    <Text style={styles.ruleBody}>{r.body}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>

            <Pressable
              testID="withdrawal-rules-close"
              accessibilityRole="button"
              accessibilityLabel="Close rules and regulations"
              style={({ pressed }) => [styles.rulesCloseBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={() => setShowRules(false)}
            >
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.rulesCloseGradient}
              >
                <Text style={styles.rulesCloseText}>Got It</Text>
              </LinearGradient>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ══ KYC GATE — blocks non-verified users from the Wallet ═════════════ */}
      <KycGateModal
        visible={showKycGate}
        feature="wallet"
        onClose={() => {
          setShowKycGate(false);
          router.replace('/(tabs)');
        }}
      />
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
  lockRow: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' },
  lockChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.28)', borderRadius: 10, paddingVertical: 5, paddingHorizontal: 9 },
  lockChipText: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.gold },
  modalLockNote: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.gold, marginTop: 6 },
  destBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(0,230,118,0.06)', borderWidth: 1, borderColor: 'rgba(0,230,118,0.25)',
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12,
  },
  destBoxText: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textPrimary },
  destHint: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, marginTop: 5, lineHeight: 15 },

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

  htCard: { borderRadius: 18, overflow: 'hidden', marginBottom: 24, borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)' },
  htIconWrap: { width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(244,196,48,0.15)', alignItems: 'center', justifyContent: 'center' },
  htValue: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.gold },
  redeemBtn: { marginTop: 14 },
  redeemBtnImg: { width: '100%', height: 'auto' as const, aspectRatio: 654 / 162 },

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
  methodBtnLocked:     { opacity: 0.45, borderColor: Colors.darkBorder },
  methodBtnTextLocked: { color: Colors.textMuted },
  bep20LockNotice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7,
    backgroundColor: 'rgba(255,82,82,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,82,82,0.25)',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9,
  },
  bep20LockText: {
    flex: 1,
    fontFamily: 'Inter_400Regular', fontSize: 12,
    color: '#ff5252', lineHeight: 17,
  },
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

  /* ── Warning popup ── */
  warnOverlay:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  warnSheet:       { backgroundColor: '#1a0a0a', borderRadius: 24, padding: 28, width: '100%', alignItems: 'center', gap: 14,
                     borderWidth: 1.5, borderColor: 'rgba(255,59,48,0.5)' },
  warnIconWrap:    { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(255,59,48,0.12)',
                     alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  warnTitle:       { fontFamily: 'Inter_700Bold', fontSize: 22, color: '#FF3B30', letterSpacing: 2 },
  warnBody:        { fontFamily: 'Inter_400Regular', fontSize: 14, color: '#FF3B30', textAlign: 'center', lineHeight: 22, opacity: 0.9 },
  warnBold:        { fontFamily: 'Inter_700Bold', color: '#FF3B30' },
  warnAddrBox:     { backgroundColor: 'rgba(255,59,48,0.08)', borderRadius: 12, padding: 14, width: '100%',
                     borderWidth: 1, borderColor: 'rgba(255,59,48,0.25)' },
  warnAddrLabel:   { fontFamily: 'Inter_500Medium', fontSize: 11, color: 'rgba(255,59,48,0.7)', marginBottom: 4 },
  warnAddrValue:   { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: '#FF3B30' },
  warnConfirmBtn:        { backgroundColor: '#FF3B30', borderRadius: 14, height: 52, width: '100%', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  warnConfirmBtnDisabled:{ backgroundColor: '#4a1a1a' },
  warnConfirmText:       { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#fff' },
  warnCancelBtn:         { paddingVertical: 10, width: '100%', alignItems: 'center' },
  warnCancelText:        { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },

  /* ── Binance verification checkbox ── */
  checkRow:     { flexDirection: 'row', alignItems: 'flex-start', gap: 10, width: '100%',
                  backgroundColor: 'rgba(255,59,48,0.06)', borderRadius: 12, padding: 12,
                  borderWidth: 1, borderColor: 'rgba(255,59,48,0.2)' },
  checkbox:     { width: 22, height: 22, borderRadius: 6, borderWidth: 2,
                  borderColor: 'rgba(255,59,48,0.5)', alignItems: 'center', justifyContent: 'center',
                  marginTop: 1, backgroundColor: 'transparent' },
  checkboxChecked: { backgroundColor: Colors.gold, borderColor: Colors.gold },
  checkLabel:   { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, color: '#FF3B30',
                  lineHeight: 20, opacity: 0.95 },

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

  /* ── Guaranteed withdrawals banner ── */
  guarBanner: { marginBottom: 14, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(244,196,48,0.35)' },
  guarBannerInner: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  guarIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(244,196,48,0.15)',
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(244,196,48,0.4)' },
  guarTextWrap: { flex: 1, gap: 3 },
  guarHeadline: { fontFamily: 'Inter_700Bold', fontSize: 15, color: Colors.textPrimary, lineHeight: 20 },
  guarLinkRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  guarLink: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.gold, textDecorationLine: 'underline' },

  /* ── Rules modal ── */
  rulesOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 22 },
  rulesSheet: { width: '100%', maxHeight: '85%', backgroundColor: Colors.darkCard, borderRadius: 24, padding: 22, gap: 14,
    borderWidth: 1.5, borderColor: 'rgba(244,196,48,0.4)' },
  rulesHeader: { alignItems: 'center', gap: 6 },
  rulesIconWrap: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(244,196,48,0.12)',
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(244,196,48,0.35)', marginBottom: 2 },
  rulesTitle: { fontFamily: 'Inter_700Bold', fontSize: 20, color: Colors.textPrimary, textAlign: 'center' },
  rulesSub: { fontFamily: 'Inter_400Regular', fontSize: 12.5, color: Colors.textMuted, textAlign: 'center', lineHeight: 18 },
  rulesScroll: { flexGrow: 0 },
  rulesScrollContent: { gap: 12, paddingVertical: 2 },
  ruleRow: { flexDirection: 'row', gap: 12, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 14, padding: 13,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  ruleNumBadge: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(244,196,48,0.15)',
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(244,196,48,0.4)' },
  ruleNum: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.gold },
  ruleTextWrap: { flex: 1, gap: 3 },
  ruleTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.gold },
  ruleBody: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, lineHeight: 19 },
  rulesCloseBtn: { marginTop: 2 },
  rulesCloseGradient: { height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  rulesCloseText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
});
