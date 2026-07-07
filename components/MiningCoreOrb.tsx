import React, { useEffect, useMemo, useState } from 'react';
import { View, Image, StyleSheet, Platform } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming,
  Easing, interpolate,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import Colors from '@/constants/colors';

const COIN = require('@/assets/images/shiba_coin_local.png');

type Status = 'idle' | 'mining' | 'ready_to_claim';

// ── Jagged bolt path generators ───────────────────────────────────────────────

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

// Arc that hugs the coin perimeter with jitter
function genArcBolt(cx: number, cy: number, radius: number): string {
  const startA = rand(0, Math.PI * 2);
  const sweep = rand(0.5, 1.1) * (Math.random() < 0.5 ? -1 : 1);
  const steps = 6;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = startA + sweep * (i / steps);
    const jr = radius + (i === 0 || i === steps ? 0 : rand(-6, 6));
    const x = cx + Math.cos(a) * jr;
    const y = cy + Math.sin(a) * jr;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

// Radial zap shooting outward from the coin
function genRadialBolt(cx: number, cy: number, r1: number, r2: number): string {
  const a = rand(0, Math.PI * 2);
  const perp = a + Math.PI / 2;
  const steps = 5;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const r = r1 + (r2 - r1) * (i / steps);
    const jitter = i === 0 || i === steps ? 0 : rand(-7, 7);
    const x = cx + Math.cos(a) * r + Math.cos(perp) * jitter;
    const y = cy + Math.sin(a) * r + Math.sin(perp) * jitter;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

// ── Lightning layer — flickers + regenerates bolts on an interval ─────────────

function LightningArcs({ size, color, intense }: { size: number; color: string; intense: boolean }) {
  const [tick, setTick] = useState(0);
  const flick = useSharedValue(1);

  useEffect(() => {
    flick.value = withRepeat(
      withTiming(0.35, { duration: 95, easing: Easing.linear }),
      -1,
      true,
    );
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intense ? 300 : 460);
    return () => clearInterval(id);
  }, [intense]);

  const bolts = useMemo(() => {
    const cx = size / 2;
    const cy = size / 2;
    const coinR = size * 0.30;
    const n = intense ? 3 : 2;
    const arr: string[] = [];
    for (let i = 0; i < n; i++) {
      if (Math.random() < 0.6) arr.push(genArcBolt(cx, cy, coinR + rand(2, 12)));
      else arr.push(genRadialBolt(cx, cy, coinR - 2, coinR + rand(14, 28)));
    }
    return arr;
  }, [tick, size, intense]);

  const aStyle = useAnimatedStyle(() => ({ opacity: flick.value }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, aStyle]} pointerEvents="none">
      <Svg width={size} height={size}>
        {bolts.map((p, i) => (
          <React.Fragment key={`${tick}-${i}`}>
            <Polyline
              points={p}
              fill="none"
              stroke={color}
              strokeOpacity={0.3}
              strokeWidth={5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <Polyline
              points={p}
              fill="none"
              stroke="#F0FCFF"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </React.Fragment>
        ))}
      </Svg>
    </Animated.View>
  );
}

// ── Mining Core Orb ───────────────────────────────────────────────────────────

interface Props {
  status: Status;
  size?: number;
}

export default function MiningCoreOrb({ status, size = 248 }: Props) {
  const rot = useSharedValue(0);
  const glow = useSharedValue(0);
  const floatV = useSharedValue(0);
  const rotV = useSharedValue(0);

  useEffect(() => {
    rot.value = withRepeat(withTiming(360, { duration: 16000, easing: Easing.linear }), -1, false);
    glow.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.sin) }), -1, true);
    floatV.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.sin) }), -1, true);
    rotV.value = withRepeat(withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, []);

  const ringStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(glow.value, [0, 1], [0.30, 0.7]),
    transform: [{ scale: interpolate(glow.value, [0, 1], [0.9, 1.08]) }],
  }));
  const torusStyle = useAnimatedStyle(() => ({ opacity: interpolate(glow.value, [0, 1], [0.72, 1]) }));
  const coinStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(floatV.value, [0, 1], [-7, 7]) },
      { rotate: `${interpolate(rotV.value, [0, 1], [-4, 4])}deg` },
    ],
  }));

  const ringD = size * 0.94;
  const torusD = size * 0.80;
  const glassD = size * 0.62;
  const coinD = size * 0.40;

  const intense = status !== 'idle';
  const accent = status === 'ready_to_claim' ? Colors.gold : Colors.energyCyan;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* Ambient breathing glow */}
      <Animated.View
        style={[
          styles.ambient,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: accent, shadowColor: accent },
          glowStyle,
        ]}
        pointerEvents="none"
      />

      {/* Outer decorative dark ring with gold notches (slow rotate) */}
      <Animated.View
        style={[{ position: 'absolute', width: ringD, height: ringD, alignItems: 'center', justifyContent: 'center' }, ringStyle]}
        pointerEvents="none"
      >
        <View style={[styles.outerRing, { width: ringD, height: ringD, borderRadius: ringD / 2 }]} />
        {[...Array(12)].map((_, i) => (
          <View
            key={i}
            style={[
              styles.notch,
              {
                transform: [{ rotate: `${i * 30}deg` }, { translateX: ringD / 2 - 4 }],
                backgroundColor: i % 3 === 0 ? Colors.gold : 'rgba(158,238,255,0.35)',
                width: i % 3 === 0 ? 10 : 4,
                height: i % 3 === 0 ? 10 : 8,
              },
            ]}
          />
        ))}
      </Animated.View>

      {/* Glowing energy torus */}
      <Animated.View
        style={[
          styles.torus,
          { width: torusD, height: torusD, borderRadius: torusD / 2, borderColor: accent, shadowColor: accent },
          torusStyle,
        ]}
        pointerEvents="none"
      />
      <View
        style={[styles.torusInner, { width: torusD - 16, height: torusD - 16, borderRadius: (torusD - 16) / 2, borderColor: accent + '55' }]}
        pointerEvents="none"
      />

      {/* Glass sphere */}
      <View style={[styles.glass, { width: glassD, height: glassD, borderRadius: glassD / 2, borderColor: accent + '80' }]} pointerEvents="none">
        <LinearGradient
          colors={
            status === 'ready_to_claim'
              ? ['rgba(255,215,0,0.35)', 'rgba(255,107,0,0.18)', 'rgba(20,12,10,0.6)']
              : ['rgba(80,220,255,0.32)', 'rgba(20,90,150,0.16)', 'rgba(8,10,30,0.6)']
          }
          start={{ x: 0.3, y: 0 }}
          end={{ x: 0.7, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.gloss} />
      </View>

      {/* Lightning crackling around the coin */}
      <View style={{ position: 'absolute', width: torusD, height: torusD }} pointerEvents="none">
        <LightningArcs size={torusD} color={accent} intense={intense} />
      </View>

      {/* Floating Shiba coin */}
      <Animated.View style={[{ position: 'absolute' }, coinStyle]} pointerEvents="none">
        <Image source={COIN} style={{ width: coinD, height: coinD }} resizeMode="contain" />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  ambient: {
    position: 'absolute',
    ...Platform.select({
      ios: { shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.9, shadowRadius: 40 },
      android: { elevation: 0 },
      default: {},
    }),
  },
  outerRing: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(58,42,107,0.9)',
    backgroundColor: 'rgba(12,7,32,0.35)',
  },
  notch: {
    position: 'absolute',
    borderRadius: 5,
  },
  torus: {
    position: 'absolute',
    borderWidth: 3,
    backgroundColor: 'transparent',
    ...Platform.select({
      ios: { shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.9, shadowRadius: 16 },
      android: { elevation: 8 },
      default: {},
    }),
  },
  torusInner: {
    position: 'absolute',
    borderWidth: 1,
  },
  glass: {
    position: 'absolute',
    overflow: 'hidden',
    borderWidth: 1.5,
  },
  gloss: {
    position: 'absolute',
    top: '6%',
    left: '14%',
    width: '52%',
    height: '30%',
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.22)',
    transform: [{ rotate: '-18deg' }],
  },
});
