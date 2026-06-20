/**
 * TournamentBannerPopup — MANUAL-cycle tournament registration bottom sheet.
 *
 * Security: countdown uses server-authoritative time (serverOffset from
 * TournamentContext) so device clock manipulation doesn't affect the deadline.
 *
 * Manual model — the popup ONLY appears while a tournament is active (showPopup
 * gates on config.is_active). Two phases:
 *   prestart — launched but not started yet; countdown to start_time ("STARTS IN").
 *   live     — running; countdown to end_time ("TOURNAMENT ENDS IN").
 * There is NO weekly intermission / pre-registration-for-next-week state.
 *
 * Layout (top → bottom inside the sheet):
 *   1. Mode label + live countdown timer
 *   2. Banner image ONLY — no overlays, no text, no icons
 *   3. Side-by-side capsule buttons [REGISTER] [REJECT]
 *   4. Small disclaimer note
 */
import React, { useCallback, useRef, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, Image, Animated, ScrollView, Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useTournament, getTournamentPhase } from '@/context/TournamentContext';
import Colors from '@/constants/colors';

// ── Server-corrected countdown hook ────────────────────────────────────────
/**
 * Counts down to `endTimeIso` using a server-offset-corrected clock.
 * `serverOffset` = serverTime - Date.now() at the moment config was fetched.
 * Using `Date.now() + serverOffset` compensates for device clock skew/manipulation.
 */
function useCountdown(endTimeIso: string, serverOffset: number) {
  const endMs = endTimeIso ? new Date(endTimeIso).getTime() : 0;

  const calc = () => {
    const serverNow = Date.now() + serverOffset;
    const diff = Math.max(0, endMs - serverNow);
    return {
      days:    Math.floor(diff / 86_400_000),
      hours:   Math.floor((diff % 86_400_000) / 3_600_000),
      minutes: Math.floor((diff % 3_600_000) / 60_000),
      seconds: Math.floor((diff % 60_000) / 1_000),
    };
  };

  const [time, setTime] = useState(calc);

  useEffect(() => {
    if (!endMs) return;
    setTime(calc());
    const id = setInterval(() => setTime(calc()), 1000);
    return () => clearInterval(id);
  }, [endMs, serverOffset]);

  return time;
}

// ── Zero-padded helper ─────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');

// ── Dynamic banner image ───────────────────────────────────────────────────
const SCREEN_W = Dimensions.get('window').width;

function BannerImage({ uri }: { uri: string }) {
  const [imgH, setImgH] = useState(Math.round(SCREEN_W * (9 / 16)));

  useEffect(() => {
    if (!uri) return;
    Image.getSize(
      uri,
      (w, h) => {
        const ratio   = h / w;
        const naturalH = Math.round(SCREEN_W * ratio);
        setImgH(Math.min(naturalH, Math.round(SCREEN_W * 1.4)));
      },
      () => {},
    );
  }, [uri]);

  return (
    <Image
      source={{ uri }}
      style={{ width: SCREEN_W, height: imgH }}
      resizeMode="contain"
    />
  );
}

// ── Capsule button ─────────────────────────────────────────────────────────
interface CapsuleButtonProps {
  label: string;
  bg: string;
  borderColor: string;
  glowColor: string;
  onPress: () => void;
  disabled?: boolean;
}

function CapsuleButton({ label, bg, borderColor, glowColor, onPress, disabled }: CapsuleButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn  = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Animated.spring(scale, { toValue: 0.93, useNativeDriver: true, speed: 60, bounciness: 4 }).start();
  };
  const onPressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 10 }).start();
  };

  return (
    <Animated.View style={[styles.capsuleWrap, { transform: [{ scale }] }]}>
      <Pressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onPress={onPress}
        disabled={disabled}
        style={[
          styles.capsule,
          { backgroundColor: bg, borderColor, shadowColor: glowColor },
          disabled && { opacity: 0.55 },
        ]}
      >
        <Text style={styles.capsuleLabel}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

// ── Main popup ─────────────────────────────────────────────────────────────
export function TournamentBannerPopup() {
  const insets = useSafeAreaInsets();
  const { config, showPopup, serverOffset, joinTournament, rejectTournament } = useTournament();
  const [joining, setJoining] = useState(false);

  // Phase from the server-corrected clock — drives the countdown target + labels.
  const serverNow = Date.now() + serverOffset;
  const phase     = getTournamentPhase(config, serverNow);

  // prestart → start_time ("STARTS IN")
  // live     → end_time (admin-set end of this cycle)
  const countdownTarget = (() => {
    if (!config) return '';
    if (phase === 'prestart') return config.start_time;
    return config.end_time;
  })();

  const countdown = useCountdown(countdownTarget, serverOffset);

  const handleRegister = useCallback(async () => {
    if (joining) return;
    setJoining(true);
    try {
      await joinTournament();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setJoining(false);
    }
  }, [joinTournament, joining]);

  const handleReject = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await rejectTournament();
  }, [rejectTournament]);

  if (!showPopup || !config) return null;

  const modeLabel =
    phase === 'prestart' ? 'STARTS IN'
    : 'TOURNAMENT ENDS IN';
  const modeColor =
    phase === 'live' ? Colors.gold
    : '#00C853';
  const disclaimerMsg = phase === 'live'
    ? 'Registering is free — your mining rewards count as tournament points.'
    : 'Register now — your mining rewards will count as points when the tournament begins.';

  return (
    <Modal visible transparent animationType="slide" statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 4 }]}>

          {/* ── 1. Mode label + countdown ────────────────────────────────── */}
          <View style={[styles.timerRow, phase !== 'live' && styles.timerRowIntermission]}>
            <Text style={[styles.modeLabel, { color: modeColor }]}>{modeLabel}</Text>
            <View style={styles.timerDigitsRow}>
              <View style={styles.timerBlock}>
                <Text style={[styles.timerDigit, { color: modeColor }]}>{countdown.days}</Text>
                <Text style={styles.timerUnit}>Days</Text>
              </View>
              <Text style={[styles.timerColon, { color: modeColor }]}>:</Text>
              <View style={styles.timerBlock}>
                <Text style={[styles.timerDigit, { color: modeColor }]}>{pad(countdown.hours)}</Text>
                <Text style={styles.timerUnit}>Hours</Text>
              </View>
              <Text style={[styles.timerColon, { color: modeColor }]}>:</Text>
              <View style={styles.timerBlock}>
                <Text style={[styles.timerDigit, { color: modeColor }]}>{pad(countdown.minutes)}</Text>
                <Text style={styles.timerUnit}>Minutes</Text>
              </View>
              <Text style={[styles.timerColon, { color: modeColor }]}>:</Text>
              <View style={styles.timerBlock}>
                <Text style={[styles.timerDigit, { color: modeColor }]}>{pad(countdown.seconds)}</Text>
                <Text style={styles.timerUnit}>Seconds</Text>
              </View>
            </View>
          </View>

          {/* ── 2. Banner image ──────────────────────────────────────────── */}
          <ScrollView
            style={styles.imageScroll}
            contentContainerStyle={styles.imageScrollContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {config.banner_url ? (
              <BannerImage uri={config.banner_url} />
            ) : (
              <View style={styles.bannerPlaceholder} />
            )}
          </ScrollView>

          {/* ── 3. Capsule buttons ───────────────────────────────────────── */}
          <View style={styles.buttonRow}>
            <CapsuleButton
              label={joining ? 'REGISTERING…' : 'REGISTER'}
              bg="#071a0c"
              borderColor="#00E676"
              glowColor="#00E676"
              onPress={handleRegister}
              disabled={joining}
            />
            <CapsuleButton
              label="REJECT"
              bg="#1a0707"
              borderColor="#FF3B30"
              glowColor="#FF3B30"
              onPress={handleReject}
            />
          </View>

          {/* ── 4. Disclaimer ────────────────────────────────────────────── */}
          <Text style={styles.note}>{disclaimerMsg}</Text>
        </View>
      </View>
    </Modal>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.84)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0D0D14',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },

  // ── Countdown timer ──
  timerRow: {
    alignItems: 'center',
    paddingTop: 18,
    paddingBottom: 14,
    paddingHorizontal: 20,
    gap: 6,
    backgroundColor: 'rgba(244,196,48,0.04)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(244,196,48,0.1)',
  },
  timerRowIntermission: {
    backgroundColor: 'rgba(123,104,238,0.06)',
    borderBottomColor: 'rgba(123,104,238,0.15)',
  },
  modeLabel: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  timerDigitsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  timerBlock: {
    alignItems: 'center',
    minWidth: 52,
  },
  timerDigit: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    letterSpacing: 1,
    lineHeight: 32,
  },
  timerUnit: {
    fontFamily: 'Inter_400Regular',
    fontSize: 9,
    color: Colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  timerColon: {
    fontFamily: 'Inter_700Bold',
    fontSize: 24,
    opacity: 0.6,
    marginBottom: 10,
  },

  // ── Banner image ──
  imageScroll: {
    maxHeight: Math.round(Dimensions.get('window').height * 0.60),
    backgroundColor: '#111118',
  },
  imageScrollContent: {},
  bannerPlaceholder: {
    width: SCREEN_W,
    height: Math.round(SCREEN_W * (9 / 16)),
    backgroundColor: '#111118',
  },

  // ── Buttons ──
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 4,
  },
  capsuleWrap: { flex: 1 },
  capsule: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 17,
    borderRadius: 50,
    borderWidth: 2,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 12,
    elevation: 10,
  },
  capsuleLabel: {
    fontFamily: 'Inter_700Bold',
    fontSize: 14,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: '#ffffff',
  },

  // ── Disclaimer ──
  note: {
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 17,
    paddingHorizontal: 28,
    paddingTop: 10,
    paddingBottom: 6,
  },
});
