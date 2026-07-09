import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Platform, useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useWallet } from '@/context/WalletContext';
import Colors from '@/constants/colors';
import ShimmerCoin from '@/components/ShimmerCoin';
import {
  REDEEM_BOXES,
  ticketsToShib,
  validateRedeem,
  REDEEM_MIN_TICKETS,
  REDEEM_MAX_TICKETS,
} from '@shared/gamehub';

const GOLD = '#F4C430';

const SPACE_BG = require('@/assets/images/redeem_space_bg.png');
const HEADER_IMG = require('@/assets/images/redeem_header.png');
const BALANCE_FRAME = require('@/assets/images/redeem_balance_frame.png');
const CELL_FRAME = require('@/assets/images/redeem_cell_frame.png');
const COIN = require('@/assets/images/shiba_coin_square.png');
const REDEEM_BUTTON = require('@/assets/images/redeem_button.png');

// Per-tier ticket artwork, keyed by ticket cost (matches REDEEM_BOXES).
const TICKET_IMAGES: Record<number, number> = {
  50: require('@/assets/images/ticket_50.png'),
  100: require('@/assets/images/ticket_100.png'),
  250: require('@/assets/images/ticket_250.png'),
  500: require('@/assets/images/ticket_500.png'),
  1000: require('@/assets/images/ticket_1000.png'),
  2500: require('@/assets/images/ticket_2500.png'),
  5000: require('@/assets/images/ticket_5000.png'),
};

const BALANCE_AR = 1480 / 704;   // 2.1023
const CELL_AR = 1071 / 1008;     // 1.0625
const HEADER_AR = 1721 / 608;    // 2.8306
const BUTTON_AR = 1805 / 592;    // 3.0490

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return n.toLocaleString();
}

export default function RedeemScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { hitTickets, redeem } = useWallet();

  const [selected, setSelected] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const contentW = width - 32;
  const balanceH = contentW / BALANCE_AR;
  const coinSize = Math.round(Math.min(contentW * 0.24, balanceH * 0.66));
  const numFont = Math.round(Math.min(54, Math.max(28, balanceH * 0.22)));

  const validation = selected != null ? validateRedeem(selected, hitTickets) : { ok: false as const };
  const canConfirm = selected != null && validation.ok && !submitting;

  const handleSelect = (tickets: number) => {
    if (submitting) return;
    setSelected(prev => (prev === tickets ? null : tickets));
    setError(null);
    setSuccessMsg(null);
  };

  const handleConfirm = async () => {
    if (selected == null) return;
    const check = validateRedeem(selected, hitTickets);
    if (!check.ok) {
      setError(check.error ?? 'Cannot redeem this amount');
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await redeem(selected);
      if (res.success) {
        const shib = res.shib ?? ticketsToShib(selected);
        setSuccessMsg(`Success! ${fmt(shib)} SHIB from ${fmt(selected)} tickets has been added to your wallet.`);
        setSelected(null);
      } else {
        setError(res.error ?? 'Redemption failed. Please try again.');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Redemption failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* ── Fixed space background ── */}
      <Image source={SPACE_BG} style={StyleSheet.absoluteFill} contentFit="cover" />
      <LinearGradient
        colors={['rgba(2,5,14,0.35)', 'rgba(2,5,14,0.15)', 'rgba(2,5,14,0.6)']}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 8) }]}>
        <Pressable
          testID="redeem-back-button"
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </Pressable>
        <View style={styles.headerImgWrap}>
          <Image source={HEADER_IMG} style={styles.headerImg} contentFit="contain" />
        </View>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 24) + 24,
        }}
      >
        {/* ── Balance container ── */}
        <Animated.View
          entering={FadeInDown.delay(80).springify()}
          style={[styles.balanceWrap, { height: balanceH }]}
        >
          <Image source={BALANCE_FRAME} style={StyleSheet.absoluteFill} contentFit="contain" />

          <View style={styles.balanceCoinWrap} pointerEvents="none">
            <ShimmerCoin source={COIN} size={coinSize} />
          </View>

          {/* Only the count is dynamic — the frame's baked "Hit Tickets available"
              and "1 ticket = 10 SHIB" labels are preserved; we mask just the number. */}
          <View style={styles.balanceNumberChip} pointerEvents="none">
            <Text style={[styles.balanceNumber, { fontSize: numFont }]} testID="redeem-balance">
              {fmt(hitTickets)}
            </Text>
          </View>
        </Animated.View>

        <Text style={styles.sectionTitle}>Choose an amount</Text>

        {/* ── Redemption grid ── */}
        <View style={styles.grid}>
          {REDEEM_BOXES.map((tickets, idx) => {
            const shib = ticketsToShib(tickets);
            const affordable = validateRedeem(tickets, hitTickets).ok;
            const isSelected = selected === tickets;
            return (
              <Animated.View
                key={tickets}
                entering={FadeInDown.delay(120 + idx * 45).springify()}
                style={styles.cell}
              >
                <Pressable
                  testID={`redeem-box-${tickets}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Redeem ${tickets} tickets for ${shib} SHIB`}
                  disabled={!affordable || submitting}
                  onPress={() => handleSelect(tickets)}
                  style={({ pressed }) => [
                    styles.cellPressable,
                    !affordable && styles.cellDim,
                    { transform: [{ scale: pressed && affordable ? 0.97 : 1 }] },
                  ]}
                >
                  <Image source={CELL_FRAME} style={StyleSheet.absoluteFill} contentFit="contain" />

                  {isSelected && <View style={styles.cellSelTint} pointerEvents="none" />}

                  <View style={styles.cellTicketWrap} pointerEvents="none">
                    <Image source={TICKET_IMAGES[tickets]} style={styles.cellDiamond} contentFit="contain" />
                  </View>

                  <View style={styles.cellCostWrap} pointerEvents="none">
                    <Text style={styles.cellCost}>{fmt(tickets)} tickets</Text>
                  </View>

                  <View style={styles.cellPriceWrap} pointerEvents="none">
                    <Text style={styles.cellPrice} numberOfLines={1}>{fmt(shib)} SHIB</Text>
                  </View>

                  {isSelected && (
                    <View style={styles.cellCheck} pointerEvents="none">
                      <Ionicons name="checkmark-circle" size={22} color={GOLD} />
                    </View>
                  )}

                  {!affordable && (
                    <View style={styles.cellLock} pointerEvents="none">
                      <Ionicons name="lock-closed" size={11} color={Colors.textMuted} />
                      <Text style={styles.cellLockText}>Need more</Text>
                    </View>
                  )}
                </Pressable>
              </Animated.View>
            );
          })}
        </View>

        <View style={styles.limitsRow}>
          <Ionicons name="information-circle-outline" size={14} color={Colors.textMuted} />
          <Text style={styles.limitsText}>
            Min {fmt(REDEEM_MIN_TICKETS)} • Max {fmt(REDEEM_MAX_TICKETS)} tickets per redemption
          </Text>
        </View>

        {successMsg && (
          <View style={styles.successBanner} testID="redeem-success">
            <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
            <Text style={styles.successText}>{successMsg}</Text>
          </View>
        )}

        {error && (
          <View style={styles.errorBanner} testID="redeem-error">
            <Ionicons name="alert-circle" size={18} color={Colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <Pressable
          testID="redeem-confirm-button"
          accessibilityRole="button"
          accessibilityLabel="Confirm redemption"
          disabled={!canConfirm}
          onPress={handleConfirm}
          style={({ pressed }) => [
            styles.confirmBtn,
            { opacity: !canConfirm ? 0.5 : pressed ? 0.9 : 1 },
          ]}
        >
          <Image source={REDEEM_BUTTON} style={styles.confirmBtnImg} contentFit="contain" />
          <View style={styles.confirmLabelWrap} pointerEvents="none">
            <MaterialCommunityIcons name="gift-outline" size={18} color="#FFF6E0" />
            <Text style={styles.confirmText} numberOfLines={1}>
              {submitting
                ? 'Redeeming…'
                : selected != null
                  ? `Redeem for ${fmt(ticketsToShib(selected))} SHIB`
                  : 'Select an amount'}
            </Text>
          </View>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#02050E' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerImgWrap: { flex: 1, alignItems: 'center' },
  headerImg: { width: '90%', aspectRatio: HEADER_AR },

  balanceWrap: {
    width: '100%',
    marginTop: 6,
    marginBottom: 20,
    position: 'relative',
  },
  balanceCoinWrap: {
    position: 'absolute',
    left: '3%',
    top: 0,
    bottom: 0,
    width: '42%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  balanceNumberChip: {
    position: 'absolute',
    top: '30%',
    bottom: '34%',
    left: '48%',
    right: '10%',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#0A1222',
    borderWidth: 1,
    borderColor: 'rgba(120,170,255,0.20)',
    overflow: 'hidden',
  },
  balanceNumber: {
    fontFamily: 'Inter_700Bold',
    color: GOLD,
    letterSpacing: 0.5,
    textShadowColor: 'rgba(244,196,48,0.4)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },

  sectionTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
    color: '#CBD5E6',
    textTransform: 'uppercase',
    letterSpacing: 1.4,
    marginBottom: 14,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  cell: { width: '48%', aspectRatio: CELL_AR, marginBottom: 14 },
  cellPressable: { flex: 1, position: 'relative' },
  cellDim: { opacity: 0.45 },
  cellSelTint: {
    position: 'absolute',
    top: '7%',
    left: '7%',
    right: '7%',
    bottom: '7%',
    borderRadius: 18,
    backgroundColor: 'rgba(244,196,48,0.14)',
  },
  cellTicketWrap: {
    position: 'absolute',
    top: '11%',
    left: 0,
    right: 0,
    height: '46%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellDiamond: { width: '92%', height: '100%' },
  cellCostWrap: { position: 'absolute', top: '59%', left: 0, right: 0, alignItems: 'center' },
  cellCost: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: '#8FD3FF' },
  cellPriceWrap: {
    position: 'absolute',
    bottom: '8%',
    left: '19%',
    right: '19%',
    height: '13%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellPrice: {
    fontFamily: 'Inter_700Bold',
    fontSize: 14,
    color: '#FFF6E0',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  cellCheck: { position: 'absolute', top: '6%', right: '9%' },
  cellLock: {
    position: 'absolute',
    top: '5%',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  cellLockText: { fontFamily: 'Inter_500Medium', fontSize: 10, color: Colors.textMuted },

  limitsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 16 },
  limitsText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },

  successBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: 'rgba(0,230,118,0.12)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(0,230,118,0.3)',
    marginBottom: 14,
  },
  successText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.success, lineHeight: 18 },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: 'rgba(255,61,87,0.12)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,61,87,0.3)',
    marginBottom: 14,
  },
  errorText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.error, lineHeight: 18 },

  confirmBtn: { marginTop: 4, alignItems: 'center', justifyContent: 'center' },
  confirmBtnImg: { width: '100%', aspectRatio: BUTTON_AR },
  confirmLabelWrap: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  confirmText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
    color: '#FFF6E0',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
