/* Compact "Online Players: N" pill for the Multiplayer Hub tiles and the
 * arcade lobby room cards. Pure display — data comes from the
 * useArcadeLiveCounts() polling hook. Uses the built-in Animated API for the
 * pulsing live dot (reanimated `entering` is broken on web). */
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import Colors from '@/constants/colors';

interface Props {
  count: number;
  /** 'compact' fits inside the hub frame tiles; 'wide' sits under room cards. */
  variant?: 'compact' | 'wide';
}

export default function LivePlayersBadge({ count, variant = 'compact' }: Props) {
  const active = count > 0;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  return (
    <View style={[styles.pill, variant === 'wide' && styles.pillWide, !active && styles.pillIdle]}>
      {active ? (
        <Animated.View style={[styles.dot, { opacity: pulse }]} />
      ) : (
        <View style={[styles.dot, styles.dotIdle]} />
      )}
      <Text
        style={[styles.txt, variant === 'wide' && styles.txtWide, !active && styles.txtIdle]}
        numberOfLines={1}
      >
        Online Players: {count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(0,230,118,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(0,230,118,0.35)',
  },
  pillWide: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 12,
  },
  pillIdle: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: Colors.darkBorder,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#00E676' },
  dotIdle: { backgroundColor: Colors.textMuted },
  txt: { color: '#00E676', fontSize: 10, fontWeight: '700' },
  txtWide: { fontSize: 12 },
  txtIdle: { color: Colors.textMuted },
});
