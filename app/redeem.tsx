import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useWallet } from '@/context/WalletContext';
import Colors from '@/constants/colors';
import TicketIcon from '@/components/TicketIcon';
import {
  REDEEM_BOXES,
  ticketsToShib,
  validateRedeem,
  REDEEM_MIN_TICKETS,
  REDEEM_MAX_TICKETS,
} from '@shared/gamehub';

const GOLD = '#F4C430';
const NEON = '#FF6B00';

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return n.toLocaleString();
}

export default function RedeemScreen() {
  const insets = useSafeAreaInsets();
  const { hitTickets, redeem } = useWallet();

  const [selected, setSelected] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

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
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.14)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />

      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 8) }]}>
        <Pressable
          testID="redeem-back-button"
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Redemption Center</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 24) + 24,
        }}
      >
        {/* ── Balance hero ── */}
        <Animated.View entering={FadeInDown.delay(80).springify()} style={styles.heroCard}>
          <LinearGradient
            colors={['rgba(244,196,48,0.2)', 'rgba(255,107,0,0.1)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroInner}
          >
            <View style={styles.heroIconWrap}>
              <TicketIcon size={34} color={GOLD} />
            </View>
            <Text style={styles.heroBalance} testID="redeem-balance">{fmt(hitTickets)}</Text>
            <Text style={styles.heroLabel}>Hit Tickets available</Text>
            <Text style={styles.heroRate}>1 ticket = {ticketsToShib(1)} SHIB</Text>
          </LinearGradient>
        </Animated.View>

        <Text style={styles.sectionTitle}>Choose an amount</Text>

        {/* ── Redeem boxes ── */}
        <View style={styles.grid}>
          {REDEEM_BOXES.map((tickets, idx) => {
            const affordable = validateRedeem(tickets, hitTickets).ok;
            const isSelected = selected === tickets;
            return (
              <Animated.View
                key={tickets}
                entering={FadeInDown.delay(120 + idx * 50).springify()}
                style={styles.gridItem}
              >
                <Pressable
                  testID={`redeem-box-${tickets}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Redeem ${tickets} tickets for ${ticketsToShib(tickets)} SHIB`}
                  disabled={!affordable || submitting}
                  onPress={() => handleSelect(tickets)}
                  style={({ pressed }) => [
                    styles.box,
                    isSelected && styles.boxSelected,
                    !affordable && styles.boxDisabled,
                    { opacity: pressed && affordable ? 0.9 : 1 },
                  ]}
                >
                  <View style={styles.boxTopRow}>
                    <TicketIcon size={18} color={affordable ? GOLD : Colors.textMuted} />
                    <Text style={[styles.boxTickets, !affordable && styles.boxTextMuted]}>
                      {fmt(tickets)}
                    </Text>
                  </View>
                  <Text style={[styles.boxTicketsLabel, !affordable && styles.boxTextMuted]}>tickets</Text>
                  <View style={styles.boxArrowRow}>
                    <Ionicons
                      name="arrow-forward"
                      size={12}
                      color={affordable ? NEON : Colors.textMuted}
                    />
                    <Text style={[styles.boxShib, !affordable && styles.boxTextMuted]}>
                      {fmt(ticketsToShib(tickets))} SHIB
                    </Text>
                  </View>
                  {!affordable && (
                    <View style={styles.boxLockRow}>
                      <Ionicons name="lock-closed" size={10} color={Colors.textMuted} />
                      <Text style={styles.boxLockText}>Need more</Text>
                    </View>
                  )}
                  {isSelected && (
                    <View style={styles.boxCheck}>
                      <Ionicons name="checkmark-circle" size={20} color={GOLD} />
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

        {/* ── Inline success ── */}
        {successMsg && (
          <View style={styles.successBanner} testID="redeem-success">
            <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
            <Text style={styles.successText}>{successMsg}</Text>
          </View>
        )}

        {/* ── Inline error ── */}
        {error && (
          <View style={styles.errorBanner} testID="redeem-error">
            <Ionicons name="alert-circle" size={18} color={Colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* ── Confirm ── */}
        <Pressable
          testID="redeem-confirm-button"
          accessibilityRole="button"
          accessibilityLabel="Confirm redemption"
          disabled={!canConfirm}
          onPress={handleConfirm}
          style={({ pressed }) => [styles.confirmBtn, { opacity: pressed && canConfirm ? 0.9 : 1 }]}
        >
          <LinearGradient
            colors={canConfirm ? [GOLD, NEON] : ['#2a2a2a', '#1a1a1a']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.confirmGradient}
          >
            <MaterialCommunityIcons
              name="gift-outline"
              size={18}
              color={canConfirm ? '#000' : Colors.textMuted}
            />
            <Text style={[styles.confirmText, !canConfirm && styles.confirmTextDim]}>
              {submitting
                ? 'Redeeming…'
                : selected != null
                  ? `Redeem for ${fmt(ticketsToShib(selected))} SHIB`
                  : 'Select an amount'}
            </Text>
          </LinearGradient>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },

  heroCard: {
    borderRadius: 22,
    overflow: 'hidden',
    marginTop: 8,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.3)',
  },
  heroInner: { padding: 24, alignItems: 'center', gap: 4 },
  heroIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(244,196,48,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  heroBalance: { fontFamily: 'Inter_700Bold', fontSize: 42, color: GOLD },
  heroLabel: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textSecondary },
  heroRate: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: NEON, marginTop: 6 },

  sectionTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  gridItem: { width: '48%', marginBottom: 12 },
  box: {
    backgroundColor: Colors.darkCard,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1.5,
    borderColor: Colors.darkBorder,
    minHeight: 104,
    justifyContent: 'center',
    gap: 4,
  },
  boxSelected: { borderColor: GOLD, backgroundColor: 'rgba(244,196,48,0.08)' },
  boxDisabled: { opacity: 0.5 },
  boxTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  boxTickets: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary },
  boxTicketsLabel: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
  boxArrowRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  boxShib: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: GOLD },
  boxTextMuted: { color: Colors.textMuted },
  boxLockRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  boxLockText: { fontFamily: 'Inter_500Medium', fontSize: 11, color: Colors.textMuted },
  boxCheck: { position: 'absolute', top: 8, right: 8 },

  limitsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 16 },
  limitsText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },

  successBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: 'rgba(0,230,118,0.1)',
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
    backgroundColor: 'rgba(255,61,87,0.1)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,61,87,0.3)',
    marginBottom: 14,
  },
  errorText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.error, lineHeight: 18 },

  confirmBtn: { marginTop: 4 },
  confirmGradient: {
    height: 54,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  confirmText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  confirmTextDim: { color: Colors.textMuted },
});
