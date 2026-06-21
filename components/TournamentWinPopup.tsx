/**
 * TournamentWinPopup — winner CELEBRATION pamphlet.
 *
 * Triggers when a winner opens the app AFTER a tournament cycle has been
 * finalized. It reads the public `tournament_history` collection (APK-safe, no
 * Express) to learn the most recently finalized cycle's standings and shows a
 * congratulatory popup with the EXACT SHIB amount the user won.
 *
 * IMPORTANT — the [CLAIM REWARD] button is COSMETIC ONLY. The prize is already
 * auto-credited to the winner's balance server-side at finalize time
 * (runEndOfCycle). The button merely:
 *   1. refreshes the local balance so the already-credited prize animates in,
 *   2. plays a success effect, and
 *   3. permanently dismisses the popup for THIS cycle (AsyncStorage, keyed by
 *      pbId + cycleKey).
 * It MUST NOT call any reward/claim endpoint — doing so would double-credit.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, Animated, Easing, AppState,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import storage from '@/lib/storage';
import { useAuth } from '@/context/AuthContext';
import { fetchMyLastCycleWin } from '@/lib/tournamentHistory';
import Colors from '@/constants/colors';

// ── helpers ──────────────────────────────────────────────────────────────────
function formatShib(val: number) {
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(0)}K`;
  return Math.round(val).toLocaleString();
}

const seenKey = (pbId: string, cycleKey: string) => `tournament_win_seen_${pbId}_${cycleKey}`;

const rankLabel = (rank: number) =>
  rank === 1 ? '1st Place' : rank === 2 ? '2nd Place' : rank === 3 ? '3rd Place' : `Rank #${rank}`;

interface WinInfo {
  cycleKey: string;
  rank: number;
  prize: number;
  displayName: string;
}

export function TournamentWinPopup() {
  const insets = useSafeAreaInsets();
  const { pbUser, refreshBalance } = useAuth();
  const pbId = pbUser?.pbId ?? '';

  const mountedRef = useRef(true);
  const [win, setWin]         = useState<WinInfo | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed]   = useState(false);

  // entrance / glow animations
  const cardScale   = useRef(new Animated.Value(0.85)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const glow        = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Detect whether the current user won the most recent finalized cycle ─────
  const check = useCallback(async () => {
    if (!pbId) { if (mountedRef.current) setWin(null); return; }
    try {
      const result = await fetchMyLastCycleWin(pbId);
      if (!result) return;
      // Already acknowledged this cycle's win? (permanent per-cycle dismissal)
      const seen = await storage.getItem(seenKey(pbId, result.cycleKey));
      if (seen) return;
      if (mountedRef.current) {
        setWin({
          cycleKey:    result.cycleKey,
          rank:        result.rank,
          prize:       result.prize,
          displayName: result.displayName,
        });
      }
    } catch { /* silent — celebration is best-effort */ }
  }, [pbId]);

  // Check on mount / user change …
  useEffect(() => { check(); }, [check]);

  // … and whenever the app returns to the foreground (winner re-opens the app).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => sub.remove();
  }, [check]);

  // Entrance animation + celebratory haptic when a win is surfaced.
  useEffect(() => {
    if (!win) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    cardScale.setValue(0.85);
    cardOpacity.setValue(0);
    Animated.parallel([
      Animated.spring(cardScale, { toValue: 1, useNativeDriver: true, speed: 12, bounciness: 9 }),
      Animated.timing(cardOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
    ]).start();

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [win]);

  const persistSeen = useCallback(async (cycleKey: string) => {
    if (!pbId || !cycleKey) return;
    try { await storage.setItem(seenKey(pbId, cycleKey), '1'); } catch { /* ignore */ }
  }, [pbId]);

  // CLAIM = cosmetic only: refresh balance (prize already credited) + success effect + dismiss.
  const handleClaim = useCallback(async () => {
    if (claiming || claimed || !win) return;
    setClaiming(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    try { await refreshBalance?.(); } catch { /* balance is already credited server-side */ }
    await persistSeen(win.cycleKey);
    if (!mountedRef.current) return;
    setClaimed(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    // Show the success state briefly, then dismiss.
    setTimeout(() => {
      if (!mountedRef.current) return;
      Animated.timing(cardOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => {
        if (!mountedRef.current) return;
        setWin(null);
        setClaiming(false);
        setClaimed(false);
      });
    }, 1300);
  }, [claiming, claimed, win, refreshBalance, persistSeen]);

  // Hardware back / close icon — also dismisses permanently for this cycle.
  const handleClose = useCallback(async () => {
    if (!win) return;
    await persistSeen(win.cycleKey);
    if (mountedRef.current) setWin(null);
  }, [win, persistSeen]);

  if (!win) return null;

  const glowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.7] });
  const glowScale   = glow.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Animated.View
          style={[
            styles.card,
            { opacity: cardOpacity, transform: [{ scale: cardScale }], marginTop: insets.top, marginBottom: insets.bottom },
          ]}
        >
          {/* warm celebratory wash */}
          <LinearGradient
            colors={['rgba(244,196,48,0.16)', 'rgba(255,107,0,0.08)', 'transparent']}
            style={StyleSheet.absoluteFill}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 0.8 }}
          />

          {/* close */}
          <Pressable style={styles.closeBtn} onPress={handleClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={Colors.textMuted} />
          </Pressable>

          {/* confetti accents */}
          <Text style={styles.confettiLeft}>🎉</Text>
          <Text style={styles.confettiRight}>🎊</Text>

          {/* trophy with pulsing glow */}
          <View style={styles.trophyWrap}>
            <Animated.View
              style={[styles.trophyGlow, { opacity: glowOpacity, transform: [{ scale: glowScale }] }]}
            />
            <LinearGradient
              colors={[Colors.gold, Colors.neonOrange]}
              style={styles.trophyRing}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            >
              <MaterialCommunityIcons name="trophy" size={46} color="#1A1206" />
            </LinearGradient>
          </View>

          {/* rank badge */}
          <View style={styles.rankBadge}>
            <MaterialCommunityIcons name="medal" size={13} color={Colors.gold} />
            <Text style={styles.rankBadgeText}>{rankLabel(win.rank)} · Tournament Winner</Text>
          </View>

          {/* headline */}
          <Text style={styles.title}>Congratulations!</Text>
          <Text style={styles.subtitle}>You won the tournament reward</Text>

          {/* amount */}
          <View style={styles.amountRow}>
            <Text style={styles.amount}>{formatShib(win.prize)}</Text>
            <Text style={styles.amountUnit}>SHIB</Text>
          </View>

          <Text style={styles.note}>
            Your reward has been added to your wallet balance.
          </Text>

          {/* CLAIM button — cosmetic only */}
          <Pressable
            style={({ pressed }) => [styles.claimBtnWrap, pressed && !claiming && !claimed && { transform: [{ scale: 0.97 }] }]}
            onPress={handleClaim}
            disabled={claiming || claimed}
          >
            <LinearGradient
              colors={claimed ? ['#00C853', '#00A846'] : [Colors.gold, Colors.neonOrange]}
              style={styles.claimBtn}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
            >
              {claimed ? (
                <>
                  <Ionicons name="checkmark-circle" size={18} color="#06210F" />
                  <Text style={[styles.claimLabel, { color: '#06210F' }]}>Reward Added!</Text>
                </>
              ) : (
                <Text style={styles.claimLabel}>{claiming ? 'CLAIMING…' : 'CLAIM REWARD'}</Text>
              )}
            </LinearGradient>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.86)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#0D0D14',
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.30)',
    paddingTop: 30,
    paddingBottom: 24,
    paddingHorizontal: 24,
    alignItems: 'center',
    overflow: 'hidden',
  },
  closeBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    zIndex: 5,
  },
  confettiLeft:  { position: 'absolute', top: 16, left: 18, fontSize: 22, opacity: 0.9 },
  confettiRight: { position: 'absolute', top: 16, right: 46, fontSize: 22, opacity: 0.9 },

  trophyWrap: {
    width: 110,
    height: 110,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  trophyGlow: {
    position: 'absolute',
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: Colors.gold,
  },
  trophyRing: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },

  rankBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(244,196,48,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.30)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    marginBottom: 12,
  },
  rankBadgeText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    color: Colors.gold,
    letterSpacing: 0.3,
  },

  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 26,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 4,
  },

  amountRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
    marginBottom: 4,
  },
  amount: {
    fontFamily: 'Inter_700Bold',
    fontSize: 46,
    color: Colors.gold,
    lineHeight: 50,
  },
  amountUnit: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
    color: Colors.neonOrange,
    marginBottom: 8,
    letterSpacing: 1,
  },

  note: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    marginTop: 8,
    marginBottom: 20,
    paddingHorizontal: 10,
  },

  claimBtnWrap: {
    width: '100%',
  },
  claimBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    borderRadius: 50,
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 8,
  },
  claimLabel: {
    fontFamily: 'Inter_700Bold',
    fontSize: 14,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: '#1A1206',
  },
});
