import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat,
  interpolate, Easing,
} from 'react-native-reanimated';
import Colors from '@/constants/colors';

interface Props {
  label: string;
  loading?: boolean;
  disabled?: boolean;
  onEngage: () => void;
}

export default function EngageLever({ label, loading, disabled, onEngage }: Props) {
  const arm = useSharedValue(0);   // 0 rest → 1 pulled down
  const press = useSharedValue(0); // capsule depression
  const pulse = useSharedValue(0); // idle attract glow

  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, []);

  const armStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(arm.value, [0, 1], [-34, 16])}deg` }],
  }));

  const capsuleStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(press.value, [0, 1], [0, 3]) },
      { scale: interpolate(press.value, [0, 1], [1, 0.982]) },
    ],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      press.value,
      [0, 1],
      [interpolate(pulse.value, [0, 1], [0.3, 0.55]), 0.95],
    ),
  }));

  const doPressIn = () => {
    if (disabled) return;
    arm.value = withSpring(1, { damping: 12, stiffness: 220 });
    press.value = withTiming(1, { duration: 110 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  };

  const doPressOut = () => {
    arm.value = withSpring(0, { damping: 9, stiffness: 170 });
    press.value = withTiming(0, { duration: 190 });
  };

  return (
    <View style={styles.wrap}>
      {/* Metallic housing */}
      <LinearGradient
        colors={[Colors.steelDark, Colors.steel, Colors.steelDark]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.housing}
      >
        <View style={styles.housingHighlight} />

        {/* End caps with cyan accent stripes */}
        <View style={[styles.cap, { left: 8 }]}>
          {[0, 1, 2].map((i) => <View key={i} style={styles.capStripe} />)}
        </View>
        <View style={[styles.cap, { right: 8 }]}>
          {[0, 1, 2].map((i) => <View key={i} style={styles.capStripe} />)}
        </View>

        {/* Cyan capsule button */}
        <Pressable
          onPressIn={doPressIn}
          onPressOut={doPressOut}
          onPress={() => { if (!disabled) onEngage(); }}
          disabled={disabled}
          style={styles.pressArea}
          accessibilityRole="button"
          accessibilityLabel={label}
          testID="engage-mining-lever"
        >
          <Animated.View style={[styles.capsuleWrap, capsuleStyle]}>
            <Animated.View style={[styles.capsuleGlow, glowStyle]} pointerEvents="none" />
            <LinearGradient
              colors={[Colors.energyCyanLight, Colors.energyCyan, Colors.energyCyanDeep]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={[styles.capsule, disabled && { opacity: 0.7 }]}
            >
              <View style={styles.capsuleGloss} />
              <MaterialCommunityIcons name="lightning-bolt" size={19} color="#04202B" />
              <Text style={styles.capsuleText}>{loading ? 'Loading…' : label}</Text>
            </LinearGradient>
          </Animated.View>
        </Pressable>
      </LinearGradient>

      {/* Lever arm (overhangs the housing top-right) */}
      <View style={styles.leverMount} pointerEvents="none">
        <Animated.View style={[styles.arm, armStyle]}>
          <LinearGradient
            colors={[Colors.gold, Colors.bronze]}
            style={styles.armKnob}
          />
          <LinearGradient
            colors={[Colors.steelLight, Colors.steel, Colors.steelDark]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.armRod}
          />
        </Animated.View>
        <View style={styles.pivot}>
          <View style={styles.pivotDot} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    height: 104,
    justifyContent: 'flex-end',
  },
  housing: {
    height: 72,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(216,224,238,0.35)',
    justifyContent: 'center',
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 10 },
      android: { elevation: 8 },
      default: {},
    }),
  },
  housingHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 18,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  cap: {
    position: 'absolute',
    top: 10,
    bottom: 10,
    width: 40,
    borderRadius: 12,
    backgroundColor: Colors.steelDeep,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  capStripe: {
    width: 22,
    height: 3,
    borderRadius: 2,
    backgroundColor: Colors.energyCyan,
    opacity: 0.85,
  },
  pressArea: {
    marginHorizontal: 44,
  },
  capsuleWrap: {
    height: 50,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  capsuleGlow: {
    position: 'absolute',
    top: -6,
    left: -6,
    right: -6,
    bottom: -6,
    borderRadius: 20,
    backgroundColor: Colors.energyCyan,
    ...Platform.select({
      ios: { shadowColor: Colors.energyCyan, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 1, shadowRadius: 16 },
      android: { elevation: 10 },
      default: {},
    }),
  },
  capsule: {
    flex: 1,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: 'rgba(240,252,255,0.6)',
    overflow: 'hidden',
  },
  capsuleGloss: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '46%',
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  capsuleText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
    color: '#04202B',
    letterSpacing: 0.3,
  },
  leverMount: {
    position: 'absolute',
    right: 30,
    top: 0,
    width: 44,
    height: 78,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  arm: {
    position: 'absolute',
    bottom: 12,
    width: 22,
    height: 60,
    alignItems: 'center',
    transformOrigin: 'bottom center',
  },
  armKnob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    ...Platform.select({
      ios: { shadowColor: Colors.gold, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 6 },
      android: { elevation: 6 },
      default: {},
    }),
  },
  armRod: {
    width: 9,
    height: 40,
    borderRadius: 5,
  },
  pivot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.steelDeep,
    borderWidth: 2,
    borderColor: Colors.steel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pivotDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.energyCyanLight,
  },
});
