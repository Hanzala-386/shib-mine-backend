import React, { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing,
} from 'react-native-reanimated';

/**
 * Continuously crackling electrical border that traces the perimeter of a
 * rounded rectangle. Pure react-native-svg + reanimated (no native modules) so
 * it renders identically on iOS, Android, web and Expo Go.
 *
 * Technique mirrors MiningCoreOrb: jagged polylines are regenerated on a short
 * interval (the "crackle") while a reanimated opacity flicker + a pulsing glow
 * ring sell the constant electrical aura. Only this component re-renders on the
 * interval, never the parent screen.
 */

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

// Map a perimeter parameter t∈[0,1) on a rect (0,0)-(w,h) to a point + outward normal.
function perim(t: number, w: number, h: number) {
  const L = 2 * (w + h);
  let d = (((t % 1) + 1) % 1) * L;
  if (d < w) return { x: d, y: 0, nx: 0, ny: -1 };
  d -= w;
  if (d < h) return { x: w, y: d, nx: 1, ny: 0 };
  d -= h;
  if (d < w) return { x: w - d, y: h, nx: 0, ny: 1 };
  d -= w;
  return { x: 0, y: h - d, nx: -1, ny: 0 };
}

// One jagged bolt hugging a contiguous span of the perimeter, jittered along the normal.
function genBolt(w: number, h: number, pad: number) {
  const t0 = Math.random();
  const span = rand(0.05, 0.15);
  const steps = 7;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const edge = i === 0 || i === steps;
    const t = t0 + span * (i / steps) + (edge ? 0 : rand(-0.008, 0.008));
    const { x, y, nx, ny } = perim(t, w, h);
    const j = edge ? 0 : rand(-9, 9);
    pts.push(`${(pad + x + nx * j).toFixed(1)},${(pad + y + ny * j).toFixed(1)}`);
  }
  return pts.join(' ');
}

interface Props {
  width: number;
  height: number;
  radius?: number;
  pad?: number;
  color?: string;
  glowColor?: string;
  core?: string;
  bolts?: number;
  interval?: number;
}

export default function LightningBorder({
  width,
  height,
  radius = 22,
  pad = 16,
  color = '#FF7A00',
  glowColor = '#FF3D00',
  core = '#FFE7C2',
  bolts = 3,
  interval = 140,
}: Props) {
  const [tick, setTick] = useState(0);
  const flick = useSharedValue(1);
  const glow = useSharedValue(0);

  useEffect(() => {
    flick.value = withRepeat(withTiming(0.5, { duration: 80, easing: Easing.linear }), -1, true);
    glow.value = withRepeat(withTiming(1, { duration: 1300, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 100000), interval);
    return () => clearInterval(id);
  }, [interval]);

  const paths = useMemo(() => {
    if (width <= 0 || height <= 0) return [];
    const n = bolts + (Math.random() < 0.5 ? 1 : 0);
    const arr: string[] = [];
    for (let i = 0; i < n; i++) arr.push(genBolt(width, height, pad));
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, width, height, pad, bolts]);

  if (width <= 0 || height <= 0) return null;

  const svgW = width + pad * 2;
  const svgH = height + pad * 2;

  const flickStyle = useAnimatedStyle(() => ({ opacity: flick.value }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: 0.45 + 0.55 * glow.value }));

  const ringBase = {
    position: 'absolute' as const,
    left: -pad,
    top: -pad,
    width: svgW,
    height: svgH,
  };

  return (
    <>
      {/* Pulsing aura — layered rings give an Android-safe glow (shadow alone won't paint there). */}
      <Animated.View pointerEvents="none" style={[ringBase, glowStyle]}>
        <Animated.View
          style={{
            position: 'absolute',
            left: pad - 6,
            top: pad - 6,
            width: width + 12,
            height: height + 12,
            borderRadius: radius + 6,
            borderWidth: 10,
            borderColor: glowColor + '22',
          }}
        />
        <Animated.View
          style={{
            position: 'absolute',
            left: pad - 2,
            top: pad - 2,
            width: width + 4,
            height: height + 4,
            borderRadius: radius + 2,
            borderWidth: 3,
            borderColor: color + 'AA',
            ...Platform.select({
              ios: { shadowColor: color, shadowOpacity: 0.9, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
              default: {},
            }),
          }}
        />
      </Animated.View>

      {/* Crackling bolts */}
      <Animated.View pointerEvents="none" style={[ringBase, flickStyle]}>
        <Svg width={svgW} height={svgH}>
          {paths.map((p, i) => (
            <React.Fragment key={`${tick}-${i}`}>
              <Polyline points={p} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
              <Polyline points={p} fill="none" stroke={color} strokeOpacity={0.9} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
              <Polyline points={p} fill="none" stroke={core} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" />
            </React.Fragment>
          ))}
        </Svg>
      </Animated.View>
    </>
  );
}
