import React, { useEffect } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { Image, ImageSource } from 'expo-image';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, withDelay, Easing, interpolate,
} from 'react-native-reanimated';

/**
 * Continuous, GPU-driven idle float — a gentle vertical bob plus a slight
 * rotation sway. Runs on the reanimated UI thread (60fps) and never touches
 * React state, so it stays smooth regardless of what the screen is doing.
 */
interface Props {
  source: ImageSource | number;
  width: number;
  height: number;
  amplitude?: number;
  rotate?: number;
  duration?: number;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}

export default function FloatingImage({
  source,
  width,
  height,
  amplitude = 8,
  rotate = 4,
  duration = 2200,
  delay = 0,
  style,
}: Props) {
  const v = useSharedValue(0);

  useEffect(() => {
    v.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }), -1, true),
    );
  }, [duration, delay]);

  const aStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(v.value, [0, 1], [-amplitude, amplitude]) },
      { rotate: `${interpolate(v.value, [0, 1], [-rotate, rotate])}deg` },
    ],
  }));

  return (
    <Animated.View pointerEvents="none" style={[style, aStyle]}>
      <Image source={source} style={{ width, height }} contentFit="contain" />
    </Animated.View>
  );
}
