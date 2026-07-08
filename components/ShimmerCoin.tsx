import React, { useEffect } from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing, interpolate,
} from 'react-native-reanimated';

const AnimatedGradient = Animated.createAnimatedComponent(LinearGradient);

interface Props {
  source: number;
  size: number;
  style?: StyleProp<ViewStyle>;
  floatAmplitude?: number;
  floatDuration?: number;
  sweepDuration?: number;
}

/**
 * A coin that continuously (a) floats with a gentle vertical bob + sway and
 * (b) has a diagonal light band sweep across its metallic surface, clipped to
 * the coin's rounded-square bounds. Both animations run purely on the reanimated
 * UI thread (transform-only) for a steady 60fps on device.
 */
export default function ShimmerCoin({
  source,
  size,
  style,
  floatAmplitude = 6,
  floatDuration = 2600,
  sweepDuration = 3400,
}: Props) {
  const bob = useSharedValue(0);
  const sweep = useSharedValue(0);

  useEffect(() => {
    bob.value = withRepeat(
      withTiming(1, { duration: floatDuration, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    sweep.value = withRepeat(
      withTiming(1, { duration: sweepDuration, easing: Easing.linear }),
      -1,
      false,
    );
  }, [floatDuration, sweepDuration]);

  const floatStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(bob.value, [0, 1], [-floatAmplitude, floatAmplitude]) },
      { rotate: `${interpolate(bob.value, [0, 1], [-2.5, 2.5])}deg` },
    ],
  }));

  // Band travels fully across during the first ~32% of the cycle, then rests
  // off-screen (right) for the remainder — a premium "gleam" cadence. The reset
  // jump happens while the band is off-screen, so it is never visible.
  const bandStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          sweep.value,
          [0, 0.32, 1],
          [-size * 0.85, size * 1.25, size * 1.25],
        ),
      },
      { rotate: '20deg' },
    ],
  }));

  return (
    <Animated.View pointerEvents="none" style={[{ width: size, height: size }, style, floatStyle]}>
      <Image source={source} style={{ width: size, height: size }} contentFit="contain" />
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: size * 0.1, overflow: 'hidden' },
        ]}
      >
        <AnimatedGradient
          colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.55)', 'rgba(255,255,255,0)']}
          locations={[0, 0.5, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[
            {
              position: 'absolute',
              top: -size * 0.35,
              height: size * 1.7,
              width: size * 0.42,
            },
            bandStyle,
          ]}
        />
      </View>
    </Animated.View>
  );
}
