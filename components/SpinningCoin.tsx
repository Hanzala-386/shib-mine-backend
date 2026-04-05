import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, View, ViewStyle } from 'react-native';

const COIN_IMAGE = require('@/assets/images/shiba_coin_local.png');

type SpeedVariant = 'slow' | 'normal' | 'fast';

const HALF_DURATION: Record<SpeedVariant, number> = {
  slow: 1200,
  normal: 700,
  fast: 350,
};

interface SpinningCoinProps {
  size?: number;
  spinning?: boolean;
  speed?: SpeedVariant;
  style?: ViewStyle;
}

export default function SpinningCoin({
  size = 48,
  spinning = true,
  speed = 'normal',
  style,
}: SpinningCoinProps) {
  const scaleX = useRef(new Animated.Value(1)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (!spinning) {
      animRef.current?.stop();
      scaleX.setValue(1);
      return;
    }

    const half = HALF_DURATION[speed];
    animRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(scaleX, {
          toValue: -1,
          duration: half,
          useNativeDriver: true,
          easing: Easing.linear,
        }),
        Animated.timing(scaleX, {
          toValue: 1,
          duration: half,
          useNativeDriver: true,
          easing: Easing.linear,
        }),
      ])
    );
    animRef.current.start();

    return () => {
      animRef.current?.stop();
    };
  }, [spinning, speed]);

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Animated.View style={{ transform: [{ scaleX }] }}>
        <Image
          source={COIN_IMAGE}
          style={{ width: size, height: size }}
          resizeMode="contain"
        />
      </Animated.View>
    </View>
  );
}
