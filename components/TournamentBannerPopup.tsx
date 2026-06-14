/**
 * TournamentBannerPopup — Premium bottom-sheet tournament registration modal.
 *
 * Layout (top → bottom):
 *   1. Banner image ONLY — no text, no overlays, no icons
 *   2. Side-by-side horizontal capsule buttons: [REGISTER] [REJECT]
 *   3. Small disclaimer note
 */
import React, { useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, Image,
  Animated, Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useTournament } from '@/context/TournamentContext';
import Colors from '@/constants/colors';

const { width: SW } = Dimensions.get('window');

// ── Pressable capsule button with scale-down tap feedback ─────────────────
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

  const handlePressIn = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Animated.spring(scale, {
      toValue: 0.94,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 20,
      bounciness: 8,
    }).start();
  };

  return (
    <Animated.View style={[styles.capsuleWrap, { transform: [{ scale }] }]}>
      <Pressable
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={onPress}
        disabled={disabled}
        style={[
          styles.capsule,
          {
            backgroundColor: bg,
            borderColor,
            shadowColor: glowColor,
          },
          disabled && { opacity: 0.6 },
        ]}
      >
        <Text style={[styles.capsuleLabel, { color: '#fff' }]}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

// ── Main popup component ───────────────────────────────────────────────────
export function TournamentBannerPopup() {
  const insets = useSafeAreaInsets();
  const { config, showPopup, joinTournament, rejectTournament } = useTournament();
  const [joining, setJoining] = React.useState(false);

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
      {/* Dimmed full-screen backdrop */}
      <View style={styles.overlay}>

        {/* Bottom sheet card */}
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 4 }]}>

          {/* ── Banner image — ONLY the image, zero overlays ─────────────── */}
          <View style={styles.imageContainer}>
            {config.banner_url ? (
              <Image
                source={{ uri: config.banner_url }}
                style={styles.bannerImage}
                resizeMode="cover"
              />
            ) : (
              /* Fallback: dark placeholder so layout doesn't break before admin uploads banner */
              <View style={styles.bannerPlaceholder} />
            )}
          </View>

          {/* ── Side-by-side capsule buttons ─────────────────────────────── */}
          <View style={styles.buttonRow}>
            {/* LEFT — REGISTER: dark green bg + neon green glow border */}
            <CapsuleButton
              label={joining ? 'REGISTERING…' : 'REGISTER'}
              bg="#071a0c"
              borderColor="#00E676"
              glowColor="#00E676"
              onPress={handleRegister}
              disabled={joining}
            />

            {/* RIGHT — REJECT: dark crimson bg + neon red glow border */}
            <CapsuleButton
              label="REJECT"
              bg="#1a0707"
              borderColor="#FF3B30"
              glowColor="#FF3B30"
              onPress={handleReject}
            />
          </View>

          {/* ── Disclaimer note ──────────────────────────────────────────── */}
          <Text style={styles.note}>
            Registering is free — your mining rewards also count as tournament points.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.82)',
    justifyContent: 'flex-end',
  },

  // Bottom sheet
  sheet: {
    backgroundColor: '#0D0D14',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },

  // Banner image takes full width, 16:9 aspect ratio
  imageContainer: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#111118',
  },
  bannerImage: {
    width: '100%',
    height: '100%',
  },
  bannerPlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: '#111118',
  },

  // Side-by-side buttons
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 4,
  },

  capsuleWrap: {
    flex: 1,
  },
  capsule: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 17,
    borderRadius: 50,      // fully rounded capsule shape
    borderWidth: 2,
    // Shadow/glow (iOS)
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.75,
    shadowRadius: 12,
    // Elevation (Android)
    elevation: 10,
  },
  capsuleLabel: {
    fontFamily: 'Inter_700Bold',
    fontSize: 15,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },

  // Disclaimer
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
