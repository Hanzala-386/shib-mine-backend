/* ────────────────────────────────────────────────────────────────────────────
 * PoolTable — LANDSCAPE 8-Ball table renderer built on the supplied premium art.
 *
 * Pure presentation: it draws whatever ball positions (in TABLE units) it is
 * handed. All physics/animation lives in the parent (app/hub/pool-match.tsx).
 *
 * The table long axis (PLAY_W = 800) runs HORIZONTALLY. The felt PNG is the
 * complete table (rails + pockets baked in); the physics play-area is mapped onto
 * the blue playfield sub-rectangle of that image (measured fractions below), so
 * balls bounce at the visible cushions and drop into the drawn pockets.
 *
 * Art: photoreal PNG sprites for the cue ball + solids 1-6 (as supplied) and the
 * cue stick / felt. Balls 7, 8 and the stripes 9-15 were NOT supplied, so they
 * are drawn as glossy vector balls in a matching style.
 * ──────────────────────────────────────────────────────────────────────────── */

import React from 'react';
import { View, Text, Image } from 'react-native';
import { TABLE } from '@shared/pool/physics';

const FELT = require('../../assets/pool/sprites/felt.png');
const CUE_STICK = require('../../assets/pool/sprites/cue_stick.png');
const BALL_SRC: Record<number, any> = {
  0: require('../../assets/pool/sprites/cue_ball_white.png'),
  1: require('../../assets/pool/sprites/ball_1_yellow.png'),
  2: require('../../assets/pool/sprites/ball_2_blue.png'),
  3: require('../../assets/pool/sprites/ball_3_red.png'),
  4: require('../../assets/pool/sprites/ball_4_purple.png'),
  5: require('../../assets/pool/sprites/ball_5_orange.png'),
  6: require('../../assets/pool/sprites/ball_6_green.png'),
};

// Felt image is 2816x1536; blue playfield trim-box = 2483x1281 +167+126.
const FELT_AR = 2816 / 1536;
const PF = { x0: 167 / 2816, y0: 126 / 1536, x1: 2650 / 2816, y1: 1407 / 1536 };
// Ball sprites: content fills ~92% of the 240px box (transparent margin), so the
// on-screen box must be slightly larger than the desired visible diameter.
const SPRITE_BOX = 1 / 0.9167;
// Cue stick sprite is 1522x72 (butt→tip, tip on the right).
const STICK_AR = 1522 / 72;

export interface Projection {
  scale: number;
  offX: number;
  offY: number;
  feltX: number;
  feltY: number;
  feltW: number;
  feltH: number;
  canvasW: number;
  canvasH: number;
  toScreen: (tx: number, ty: number) => { x: number; y: number };
  toTable: (sx: number, sy: number) => { x: number; y: number };
}

/** Landscape projection: table-x (long, 0..PLAY_W) → screen-x, table-y → screen-y. */
export function makeProjection(canvasW: number, canvasH: number): Projection {
  // Fit the felt image into the canvas preserving its aspect ratio.
  let feltW = canvasW;
  let feltH = canvasW / FELT_AR;
  if (feltH > canvasH) { feltH = canvasH; feltW = canvasH * FELT_AR; }
  const feltX = (canvasW - feltW) / 2;
  const feltY = (canvasH - feltH) / 2;

  // Blue playfield rect on screen.
  const blueX = feltX + PF.x0 * feltW;
  const blueY = feltY + PF.y0 * feltH;
  const blueW = (PF.x1 - PF.x0) * feltW;
  const blueH = (PF.y1 - PF.y0) * feltH;

  // Uniform scale so the play area fits inside the blue rect; centered.
  const scale = Math.min(blueW / TABLE.PLAY_W, blueH / TABLE.PLAY_H);
  const offX = blueX + (blueW - TABLE.PLAY_W * scale) / 2;
  const offY = blueY + (blueH - TABLE.PLAY_H * scale) / 2;

  return {
    scale, offX, offY, feltX, feltY, feltW, feltH, canvasW, canvasH,
    toScreen: (tx, ty) => ({ x: offX + tx * scale, y: offY + ty * scale }),
    toTable: (sx, sy) => ({ x: (sx - offX) / scale, y: (sy - offY) / scale }),
  };
}

export interface RenderBall {
  id: number;
  x: number;
  y: number;
  active: boolean;
}

interface PoolTableProps {
  proj: Projection;
  balls: RenderBall[];
  aimPath?: { x: number; y: number }[] | null; // TABLE-space points
  showGhost?: boolean;
  aim?: { angle: number; power: number } | null; // drives the cue stick
}

// Colors for the vector-drawn balls (7, 8, stripes) that were not supplied as art.
const VEC_COLOR: Record<number, string> = {
  7: '#7A1F2B', 8: '#0A0A0A',
  9: '#F4C430', 10: '#1E5AA8', 11: '#C81E1E', 12: '#5B2A86',
  13: '#E8720C', 14: '#1B7A3D', 15: '#7A1F2B',
};

function VectorBall({ id, size }: { id: number; size: number }) {
  const R = size / 2;
  const stripe = id >= 9 && id <= 15;
  const color = VEC_COLOR[id] ?? '#888';
  const disc = size * 0.42;
  return (
    <View
      style={{
        width: size, height: size, borderRadius: R, overflow: 'hidden',
        backgroundColor: stripe ? '#FBFBF3' : color,
        borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.35)',
      }}
    >
      {stripe && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: size * 0.28, height: size * 0.44, backgroundColor: color }} />
      )}
      {/* number disc */}
      <View
        style={{
          position: 'absolute', left: (size - disc) / 2, top: (size - disc) / 2,
          width: disc, height: disc, borderRadius: disc / 2, backgroundColor: '#FBFBF3',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: size * 0.26, fontWeight: '900', color: '#111', lineHeight: size * 0.3 }}>{id}</Text>
      </View>
      {/* specular highlight */}
      <View style={{ position: 'absolute', left: size * 0.16, top: size * 0.1, width: size * 0.36, height: size * 0.24, borderRadius: size * 0.18, backgroundColor: 'rgba(255,255,255,0.5)' }} />
    </View>
  );
}

export default function PoolTable({ proj, balls, aimPath, showGhost, aim }: PoolTableProps) {
  const R = TABLE.BALL_R * proj.scale;
  const box = R * 2 * SPRITE_BOX;

  const cue = balls.find((b) => b.id === 0 && b.active);
  const cueS = cue ? proj.toScreen(cue.x, cue.y) : null;

  // Cue stick geometry (behind the ball, tip pointing toward it; pull ∝ power).
  const stickLen = R * 26;
  const stickThick = stickLen / STICK_AR;
  const gap = R * 0.6 + (aim?.power ?? 0) * R * 6;

  return (
    <View style={{ width: proj.canvasW, height: proj.canvasH }}>
      {/* Table (felt + rails + pockets are all baked into the art) */}
      <Image
        source={FELT}
        resizeMode="contain"
        style={{ position: 'absolute', left: proj.feltX, top: proj.feltY, width: proj.feltW, height: proj.feltH }}
      />

      {/* Aim guide dots */}
      {aimPath && aimPath.length > 1 && aimPath.map((pt, i) => {
        if (i % 2 !== 0) return null;
        const s = proj.toScreen(pt.x, pt.y);
        return (
          <View
            key={`aim${i}`}
            style={{
              position: 'absolute', left: s.x - 2.5, top: s.y - 2.5, width: 5, height: 5,
              borderRadius: 2.5, backgroundColor: 'rgba(255,255,255,0.8)',
            }}
          />
        );
      })}

      {/* Ghost target ball */}
      {showGhost && aimPath && aimPath.length > 1 && (() => {
        const end = aimPath[aimPath.length - 1];
        const s = proj.toScreen(end.x, end.y);
        return (
          <View
            style={{
              position: 'absolute', left: s.x - R, top: s.y - R, width: R * 2, height: R * 2,
              borderRadius: R, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.55)',
            }}
          />
        );
      })()}

      {/* Balls */}
      {balls.filter((b) => b.active).map((b) => {
        const s = proj.toScreen(b.x, b.y);
        const src = BALL_SRC[b.id];
        if (src) {
          return (
            <Image
              key={`ball${b.id}`}
              source={src}
              resizeMode="contain"
              style={{ position: 'absolute', left: s.x - box / 2, top: s.y - box / 2, width: box, height: box }}
            />
          );
        }
        return (
          <View key={`ball${b.id}`} style={{ position: 'absolute', left: s.x - R, top: s.y - R }}>
            <VectorBall id={b.id} size={R * 2} />
          </View>
        );
      })}

      {/* Cue stick — only while aiming */}
      {aim && cueS && (
        <View
          style={{ position: 'absolute', left: cueS.x, top: cueS.y, width: 0, height: 0, pointerEvents: 'none', transform: [{ rotate: `${aim.angle}rad` }] }}
        >
          <Image
            source={CUE_STICK}
            resizeMode="contain"
            style={{ position: 'absolute', width: stickLen, height: stickThick, left: -(R + gap + stickLen), top: -stickThick / 2 }}
          />
        </View>
      )}
    </View>
  );
}
