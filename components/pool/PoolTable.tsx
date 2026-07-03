/* ────────────────────────────────────────────────────────────────────────────
 * PoolTable — portrait 8-Ball table renderer (pure React Native Views).
 *
 * Uses plain Views (not Skia) so it renders identically on web preview, Expo Go,
 * and the production APK with zero native deps. It is pure presentation: it draws
 * whatever ball positions (in TABLE units) it is handed. All physics/animation
 * lives in the parent (app/hub/pool-match.tsx). The table is drawn PORTRAIT: the
 * long axis (PLAY_W) runs vertically.
 * ──────────────────────────────────────────────────────────────────────────── */

import React from 'react';
import { View } from 'react-native';
import { TABLE, POCKETS } from '@shared/pool/physics';

export interface Projection {
  scale: number;
  offX: number;
  offY: number;
  tableW: number;
  tableH: number;
  canvasW: number;
  canvasH: number;
  toScreen: (tx: number, ty: number) => { x: number; y: number };
  toTable: (sx: number, sy: number) => { x: number; y: number };
}

/** Portrait projection: table-x (long, 0..PLAY_W) → screen-y, table-y → screen-x. */
export function makeProjection(canvasW: number, canvasH: number): Projection {
  const scale = Math.min(canvasW / TABLE.PLAY_H, canvasH / TABLE.PLAY_W);
  const tableW = TABLE.PLAY_H * scale; // horizontal extent on screen
  const tableH = TABLE.PLAY_W * scale; // vertical extent on screen
  const offX = (canvasW - tableW) / 2;
  const offY = (canvasH - tableH) / 2;
  return {
    scale,
    offX,
    offY,
    tableW,
    tableH,
    canvasW,
    canvasH,
    toScreen: (tx, ty) => ({ x: offX + ty * scale, y: offY + tx * scale }),
    toTable: (sx, sy) => ({ x: (sy - offY) / scale, y: (sx - offX) / scale }),
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
}

const BALL_COLORS: Record<number, string> = {
  1: '#F4C430', 2: '#1E5AA8', 3: '#C81E1E', 4: '#5B2A86',
  5: '#E8720C', 6: '#1B7A3D', 7: '#7A1F2B', 8: '#0A0A0A',
  9: '#F4C430', 10: '#1E5AA8', 11: '#C81E1E', 12: '#5B2A86',
  13: '#E8720C', 14: '#1B7A3D', 15: '#7A1F2B',
};
const isStripe = (id: number) => id >= 9 && id <= 15;

export default function PoolTable({ proj, balls, aimPath, showGhost }: PoolTableProps) {
  const R = TABLE.BALL_R * proj.scale;

  return (
    <View style={{ width: proj.canvasW, height: proj.canvasH }}>
      {/* Rail / frame */}
      <View
        style={{
          position: 'absolute',
          left: proj.offX - 14,
          top: proj.offY - 14,
          width: proj.tableW + 28,
          height: proj.tableH + 28,
          borderRadius: 20,
          backgroundColor: '#170F06',
          borderWidth: 2,
          borderColor: 'rgba(244,196,48,0.35)',
        }}
      />
      {/* Felt */}
      <View
        style={{
          position: 'absolute',
          left: proj.offX,
          top: proj.offY,
          width: proj.tableW,
          height: proj.tableH,
          borderRadius: 10,
          backgroundColor: '#0C5C39',
          borderWidth: 4,
          borderColor: '#08462B',
        }}
      />

      {/* Pockets */}
      {POCKETS.map((p, i) => {
        const s = proj.toScreen(p.x, p.y);
        const pr = p.r * proj.scale;
        return (
          <View
            key={`pk${i}`}
            style={{
              position: 'absolute',
              left: s.x - pr,
              top: s.y - pr,
              width: pr * 2,
              height: pr * 2,
              borderRadius: pr,
              backgroundColor: '#050505',
              borderWidth: 1.5,
              borderColor: 'rgba(244,196,48,0.4)',
            }}
          />
        );
      })}

      {/* Aim guide dots */}
      {aimPath && aimPath.length > 1 && aimPath.map((pt, i) => {
        if (i % 2 !== 0) return null;
        const s = proj.toScreen(pt.x, pt.y);
        return (
          <View
            key={`aim${i}`}
            style={{
              position: 'absolute',
              left: s.x - 2,
              top: s.y - 2,
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: 'rgba(255,255,255,0.75)',
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
              position: 'absolute',
              left: s.x - R,
              top: s.y - R,
              width: R * 2,
              height: R * 2,
              borderRadius: R,
              borderWidth: 1.5,
              borderColor: 'rgba(255,255,255,0.5)',
            }}
          />
        );
      })()}

      {/* Balls */}
      {balls.filter((b) => b.active).map((b) => {
        const s = proj.toScreen(b.x, b.y);
        const left = s.x - R;
        const top = s.y - R;
        const base = {
          position: 'absolute' as const,
          left,
          top,
          width: R * 2,
          height: R * 2,
          borderRadius: R,
        };
        if (b.id === 0) {
          return (
            <View key="ball0" style={{ ...base, backgroundColor: '#F5F5F5' }}>
              <View style={{ position: 'absolute', left: R * 0.4, top: R * 0.4, width: R * 0.55, height: R * 0.55, borderRadius: R * 0.3, backgroundColor: 'rgba(255,255,255,0.9)' }} />
            </View>
          );
        }
        const color = BALL_COLORS[b.id] ?? '#888';
        if (isStripe(b.id)) {
          return (
            <View key={`ball${b.id}`} style={{ ...base, backgroundColor: '#F5F5F5', overflow: 'hidden', borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.25)' }}>
              <View style={{ position: 'absolute', left: 0, right: 0, top: R * 0.55, height: R * 0.9, backgroundColor: color }} />
              <View style={{ position: 'absolute', left: R * 0.4, top: R * 0.35, width: R * 0.4, height: R * 0.4, borderRadius: R * 0.2, backgroundColor: 'rgba(255,255,255,0.45)' }} />
            </View>
          );
        }
        return (
          <View key={`ball${b.id}`} style={{ ...base, backgroundColor: color }}>
            <View style={{ position: 'absolute', left: R * 0.4, top: R * 0.4, width: R * 0.5, height: R * 0.5, borderRadius: R * 0.3, backgroundColor: 'rgba(255,255,255,0.4)' }} />
          </View>
        );
      })}
    </View>
  );
}
