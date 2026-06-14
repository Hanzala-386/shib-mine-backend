/**
 * TournamentBannerPopup — Fullscreen tournament registration modal.
 * Shows the admin-configured banner image with REGISTER (neon green) and
 * REJECT (dark red) action buttons.
 */
import React, { useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, Image,
  Dimensions, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring,
} from 'react-native-reanimated';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTournament } from '@/context/TournamentContext';
import Colors from '@/constants/colors';

const { width: SW } = Dimensions.get('window');

function formatShib(val: number) {
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(1)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(0)}K`;
  return val.toLocaleString();
}

function PressBtn({
  onPress,
  colors,
  borderColor,
  glowColor,
  label,
  icon,
}: {
  onPress: () => void;
  colors: [string, string];
  borderColor: string;
  glowColor: string;
  label: string;
  icon: string;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={[styles.btnWrap, animStyle]}>
      <Pressable
        onPressIn={() => {
          scale.value = withSpring(0.95, { damping: 18, stiffness: 500 });
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }}
        onPressOut={() => { scale.value = withSpring(1, { damping: 5, stiffness: 320 }); }}
        onPress={onPress}
        style={[styles.btn, { borderColor, shadowColor: glowColor }]}
      >
        <LinearGradient
          colors={colors}
          style={StyleSheet.absoluteFill}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        />
        <MaterialCommunityIcons name={icon as any} size={20} color="#fff" />
        <Text style={styles.btnLabel}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

export function TournamentBannerPopup() {
  const insets = useSafeAreaInsets();
  const {
    config, showPopup, joinTournament, rejectTournament,
  } = useTournament();

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

  const top3 = Object.entries(config.reward_structure)
    .map(([rank, prize]) => ({ rank: Number(rank), prize: Number(prize) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);

  const medals = ['🥇', '🥈', '🥉'];

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      {/* Dark overlay */}
      <View style={styles.overlay}>
        <View style={[styles.card, { paddingBottom: insets.bottom + 20 }]}>

          {/* Glow border */}
          <LinearGradient
            colors={['rgba(244,196,48,0.6)', 'rgba(255,107,0,0.4)', 'transparent']}
            style={styles.cardGlow}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          />

          {/* Banner image */}
          <View style={styles.bannerWrap}>
            {config.banner_url ? (
              <Image
                source={{ uri: config.banner_url }}
                style={styles.bannerImg}
                resizeMode="cover"
              />
            ) : (
              <LinearGradient
                colors={['rgba(244,196,48,0.18)', 'rgba(255,107,0,0.14)']}
                style={styles.bannerPlaceholder}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              >
                <MaterialCommunityIcons name="trophy" size={64} color={Colors.gold} />
                <Text style={styles.bannerPlaceholderText}>WEEKLY TOURNAMENT</Text>
              </LinearGradient>
            )}
            {/* Prize pool badge */}
            <View style={styles.prizePoolBadge}>
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              />
              <Text style={styles.prizePoolText}>
                🏆 {formatShib(config.prize_pool_total)} SHIB PRIZE POOL
              </Text>
            </View>
          </View>

          {/* Content */}
          <View style={styles.content}>
            <Text style={styles.title}>Weekly Mining Tournament</Text>
            <Text style={styles.sub}>
              Mine SHIB this week and compete for the top spot. Top {config.winners_count} miners win big!
            </Text>

            {/* Top prizes */}
            {top3.length > 0 && (
              <View style={styles.prizesRow}>
                {top3.map(({ rank, prize }) => (
                  <View key={rank} style={styles.prizeChip}>
                    <Text style={styles.prizeEmoji}>{medals[rank - 1] ?? '🏅'}</Text>
                    <Text style={styles.prizeAmount}>{formatShib(prize)}</Text>
                    <Text style={styles.prizeSub}>SHIB</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Action buttons */}
            <View style={styles.btns}>
              {/* REGISTER — neon green */}
              <PressBtn
                onPress={handleRegister}
                colors={['#0a2e10', '#0d3d14']}
                borderColor="#00E676"
                glowColor="#00E676"
                label={joining ? 'Registering…' : 'REGISTER'}
                icon="trophy-award"
              />
              {joining && (
                <ActivityIndicator
                  size="small"
                  color="#00E676"
                  style={styles.joiningSpinner}
                />
              )}

              {/* REJECT — dark red */}
              <PressBtn
                onPress={handleReject}
                colors={['#2a0a0a', '#3d0d0d']}
                borderColor="#FF3B30"
                glowColor="#FF3B30"
                label="NOT NOW"
                icon="close-circle-outline"
              />
            </View>

            <Text style={styles.note}>
              Registering is free. Mining rewards go to BOTH your wallet and tournament score.
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  card: {
    width: '100%',
    backgroundColor: '#0D0D14',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.25)',
    overflow: 'hidden',
  },
  cardGlow: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 2,
  },
  bannerWrap: {
    width: '100%',
    height: 220,
    overflow: 'hidden',
  },
  bannerImg: {
    width: '100%',
    height: '100%',
  },
  bannerPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  bannerPlaceholderText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 22,
    color: Colors.gold,
    letterSpacing: 2,
  },
  prizePoolBadge: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    paddingVertical: 7,
    alignItems: 'center',
    overflow: 'hidden',
  },
  prizePoolText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 14,
    color: '#000',
    letterSpacing: 0.5,
  },
  content: {
    padding: 20,
    gap: 12,
  },
  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 22,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  sub: {
    fontFamily: 'Inter_400Regular',
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  prizesRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginVertical: 4,
  },
  prizeChip: {
    flex: 1,
    backgroundColor: 'rgba(244,196,48,0.07)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.2)',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 2,
  },
  prizeEmoji: { fontSize: 22 },
  prizeAmount: {
    fontFamily: 'Inter_700Bold',
    fontSize: 15,
    color: Colors.gold,
  },
  prizeSub: {
    fontFamily: 'Inter_400Regular',
    fontSize: 10,
    color: Colors.textMuted,
  },
  btns: {
    gap: 10,
    marginTop: 4,
  },
  btnWrap: {},
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 16,
    borderRadius: 16,
    borderWidth: 2,
    overflow: 'hidden',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 14,
    elevation: 8,
  },
  btnLabel: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
    color: '#fff',
    letterSpacing: 1,
  },
  joiningSpinner: {
    position: 'absolute',
    right: 24,
    top: '50%',
  },
  note: {
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 17,
    marginTop: 4,
  },
});
