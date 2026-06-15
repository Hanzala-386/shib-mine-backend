/**
 * TournamentBannerPopup — Weekly Tournament registration bottom sheet.
 *
 * Layout (top → bottom inside the sheet):
 *   1. Live countdown timer  "X Days : XX Hours : XX Minutes : XX Seconds"
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
import { useTournament } from '@/context/TournamentContext';
import Colors from '@/constants/colors';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ── Countdown hook ─────────────────────────────────────────────────────────
function useCountdown(weekStart: string) {
  const endMs = new Date(weekStart).getTime() + WEEK_MS;

  const calc = () => {
    const diff = Math.max(0, endMs - Date.now());
    return {
      days:    Math.floor(diff / 86_400_000),
      hours:   Math.floor((diff % 86_400_000) / 3_600_000),
      minutes: Math.floor((diff % 3_600_000) / 60_000),
      seconds: Math.floor((diff % 60_000) / 1_000),
    };
  };

  const [time, setTime] = useState(calc);

  useEffect(() => {
    setTime(calc());
    const id = setInterval(() => setTime(calc()), 1000);
    return () => clearInterval(id);
  }, [endMs]);

  return time;
}

// ── Zero-padded helper ─────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');

// ── Dynamic banner image — respects uploaded image's true aspect ratio ──────
const SCREEN_W = Dimensions.get('window').width;

function BannerImage({ uri }: { uri: string }) {
  // Default to 16:9 while loading; replaced once Image.getSize resolves
  const [imgH, setImgH] = useState(Math.round(SCREEN_W * (9 / 16)));

  useEffect(() => {
    if (!uri) return;
    Image.getSize(
      uri,
      (w, h) => {
        const ratio = h / w;
        // Display the full image at natural aspect ratio.
        // Cap at 1.4× screen width equivalent height so buttons remain visible.
        const naturalH = Math.round(SCREEN_W * ratio);
        setImgH(Math.min(naturalH, Math.round(SCREEN_W * 1.4)));
      },
      () => {
        // On error keep the 16:9 default
      }
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

// ── Capsule button with spring scale feedback ──────────────────────────────
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

  const onPressIn = () => {
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
  const { config, showPopup, joinTournament, rejectTournament } = useTournament();
  const [joining, setJoining] = useState(false);

  const countdown = useCountdown(config?.week_start ?? new Date().toISOString());

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

  return (
    <Modal visible transparent animationType="slide" statusBarTranslucent>
      <View style={styles.overlay}>

        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 4 }]}>

          {/* ── 1. Live countdown timer — always visible at the top ──────── */}
          <View style={styles.timerRow}>
            <View style={styles.timerBlock}>
              <Text style={styles.timerDigit}>{countdown.days}</Text>
              <Text style={styles.timerUnit}>Days</Text>
            </View>
            <Text style={styles.timerColon}>:</Text>
            <View style={styles.timerBlock}>
              <Text style={styles.timerDigit}>{pad(countdown.hours)}</Text>
              <Text style={styles.timerUnit}>Hours</Text>
            </View>
            <Text style={styles.timerColon}>:</Text>
            <View style={styles.timerBlock}>
              <Text style={styles.timerDigit}>{pad(countdown.minutes)}</Text>
              <Text style={styles.timerUnit}>Minutes</Text>
            </View>
            <Text style={styles.timerColon}>:</Text>
            <View style={styles.timerBlock}>
              <Text style={styles.timerDigit}>{pad(countdown.seconds)}</Text>
              <Text style={styles.timerUnit}>Seconds</Text>
            </View>
          </View>

          {/* ── 2. Banner image — scrollable so tall images don't overflow ─ */}
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

          {/* ── 3. Side-by-side capsule buttons ────────────────────────── */}
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

          {/* ── 4. Disclaimer ───────────────────────────────────────────── */}
          <Text style={styles.note}>
            Registering is free — your mining rewards count as tournament points.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 22,
    paddingBottom: 16,
    paddingHorizontal: 20,
    gap: 6,
    backgroundColor: 'rgba(244,196,48,0.04)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(244,196,48,0.1)',
  },
  timerBlock: {
    alignItems: 'center',
    minWidth: 52,
  },
  timerDigit: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    color: Colors.gold,
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
    color: Colors.gold,
    opacity: 0.6,
    marginBottom: 10,
  },

  // ── Banner image — scrollable, full aspect ratio ──
  imageScroll: {
    // Cap scroll area so the sheet never fills more than ~60% of screen height.
    // BannerImage inside calculates its own natural height.
    maxHeight: Math.round(Dimensions.get('window').height * 0.60),
    backgroundColor: '#111118',
  },
  imageScrollContent: {
    // Let the BannerImage size itself; no flex needed
  },
  bannerPlaceholder: {
    width: SCREEN_W,
    height: Math.round(SCREEN_W * (9 / 16)),
    backgroundColor: '#111118',
  },

  // ── Side-by-side buttons ──
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 4,
  },
  capsuleWrap: {
    flex: 1,
  },
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
