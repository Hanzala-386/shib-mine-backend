import React, { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing,
} from 'react-native-reanimated';

/**
 * Continuously crackling electrical border that hugs the perimeter of a
 * ROUNDED rectangle. Pure react-native-svg + reanimated (no native modules) so
 * it renders identically on iOS, Android, web and Expo Go.
 *
 * The perimeter walker follows the four straight edges AND the four corner arcs
 * (radius `radius`), so the bolts curve tightly around rounded card artwork
 * instead of tracing a detached square box. The pulsing aura rings share the
 * same corner radius, keeping glow + bolts visually aligned.
 */

type PN = { x: number; y: number; nx: number; ny: number };

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

// Build a rounded-rect perimeter sampler: t∈[0,1) → point + outward unit normal.
function buildPerim(w: number, h: number, r: number) {
  const rr = Math.max(0.001, Math.min(r, Math.min(w, h) / 2));
  const sw = Math.max(0, w - 2 * rr); // straight run along top/bottom
  const sh = Math.max(0, h - 2 * rr); // straight run along left/right
  const arc = (Math.PI / 2) * rr;     // quarter-circle length

  const segs: { len: number; at: (f: number) => PN }[] = [
    // top edge, L→R
    { len: sw, at: (f) => ({ x: rr + sw * f, y: 0, nx: 0, ny: -1 }) },
    // top-right arc (-90°→0°)
    { len: arc, at: (f) => { const a = -Math.PI / 2 + (Math.PI / 2) * f; return { x: (w - rr) + rr * Math.cos(a), y: rr + rr * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) }; } },
    // right edge, T→B
    { len: sh, at: (f) => ({ x: w, y: rr + sh * f, nx: 1, ny: 0 }) },
    // bottom-right arc (0°→90°)
    { len: arc, at: (f) => { const a = (Math.PI / 2) * f; return { x: (w - rr) + rr * Math.cos(a), y: (h - rr) + rr * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) }; } },
    // bottom edge, R→L
    { len: sw, at: (f) => ({ x: (w - rr) - sw * f, y: h, nx: 0, ny: 1 }) },
    // bottom-left arc (90°→180°)
    { len: arc, at: (f) => { const a = Math.PI / 2 + (Math.PI / 2) * f; return { x: rr + rr * Math.cos(a), y: (h - rr) + rr * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) }; } },
    // left edge, B→T
    { len: sh, at: (f) => ({ x: 0, y: (h - rr) - sh * f, nx: -1, ny: 0 }) },
    // top-left arc (180°→270°)
    { len: arc, at: (f) => { const a = Math.PI + (Math.PI / 2) * f; return { x: rr + rr * Math.cos(a), y: rr + rr * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) }; } },
  ];
  const L = segs.reduce((s, seg) => s + seg.len, 0);

  const at = (t: number): PN => {
    let d = (((t % 1) + 1) % 1) * L;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (d <= seg.len || i === segs.length - 1) return seg.at(seg.len > 0 ? d / seg.len : 0);
      d -= seg.len;
    }
    return segs[0].at(0);
  };
  return at;
}

// One jagged bolt hugging a contiguous span of the perimeter, jittered along the normal.
function genBolt(at: (t: number) => PN, pad: number) {
  const t0 = Math.random();
  const span = rand(0.05, 0.15);
  const steps = 7;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const edge = i === 0 || i === steps;
    const t = t0 + span * (i / steps) + (edge ? 0 : rand(-0.008, 0.008));
    const { x, y, nx, ny } = at(t);
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

  const perimAt = useMemo(
    () => buildPerim(width, height, radius),
    [width, height, radius],
  );

  const paths = useMemo(() => {
    if (width <= 0 || height <= 0) return [];
    const n = bolts + (Math.random() < 0.5 ? 1 : 0);
    const arr: string[] = [];
    for (let i = 0; i < n; i++) arr.push(genBolt(perimAt, pad));
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, width, height, pad, bolts, perimAt]);

  const flickStyle = useAnimatedStyle(() => ({ opacity: flick.value }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: 0.45 + 0.55 * glow.value }));

  if (width <= 0 || height <= 0) return null;

  const svgW = width + pad * 2;
  const svgH = height + pad * 2;

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
