/* ────────────────────────────────────────────────────────────────────────────
 * PoolTable — Skia renderer for the 8-Ball table.
 *
 * Pure presentation: it draws whatever ball positions (in TABLE units) it is
 * handed. All physics/animation lives in the parent (app/hub/pool-match.tsx).
 * The table is drawn in PORTRAIT: the long axis (PLAY_W) runs vertically.
 * ──────────────────────────────────────────────────────────────────────────── */

import React, { useMemo } from 'react';
import {
  Canvas,
  Group,
  Circle,
  RoundedRect,
  Rect,
  Path,
  Skia,
} from '@shopify/react-native-skia';
import { TABLE, POCKETS } from '@shared/pool/physics';
import Colors from '@/constants/colors';

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
  power?: number; // 0..1
  showGhost?: boolean;
}

const BALL_COLORS: Record<number, string> = {
  1: '#F4C430', 2: '#1E5AA8', 3: '#C81E1E', 4: '#5B2A86',
  5: '#E8720C', 6: '#1B7A3D', 7: '#7A1F2B', 8: '#0A0A0A',
  9: '#F4C430', 10: '#1E5AA8', 11: '#C81E1E', 12: '#5B2A86',
  13: '#E8720C', 14: '#1B7A3D', 15: '#7A1F2B',
};
const isStripe = (id: number) => id >= 9 && id <= 15;

export default function PoolTable({ proj, balls, aimPath, power = 0, showGhost }: PoolTableProps) {
  const R = TABLE.BALL_R * proj.scale;

  // Ball clip paths (memoised per screen radius) for stripe rendering.
  const cuePath = useMemo(() => aimPath ?? [], [aimPath]);

  return (
    <Canvas style={{ width: proj.canvasW, height: proj.canvasH }}>
      {/* Rail / frame */}
      <RoundedRect
        x={proj.offX - 16}
        y={proj.offY - 16}
        width={proj.tableW + 32}
        height={proj.tableH + 32}
        r={18}
        color="#170F06"
      />
      <RoundedRect
        x={proj.offX - 16}
        y={proj.offY - 16}
        width={proj.tableW + 32}
        height={proj.tableH + 32}
        r={18}
        style="stroke"
        strokeWidth={2}
        color="rgba(244,196,48,0.35)"
      />

      {/* Felt */}
      <RoundedRect
        x={proj.offX}
        y={proj.offY}
        width={proj.tableW}
        height={proj.tableH}
        r={8}
        color="#0C5C39"
      />
      {/* Felt inner shade for depth */}
      <RoundedRect
        x={proj.offX + 6}
        y={proj.offY + 6}
        width={proj.tableW - 12}
        height={proj.tableH - 12}
        r={6}
        style="stroke"
        strokeWidth={4}
        color="rgba(0,0,0,0.18)"
      />

      {/* Pockets */}
      {POCKETS.map((p, i) => {
        const s = proj.toScreen(p.x, p.y);
        const pr = p.r * proj.scale;
        return (
          <Group key={`pk${i}`}>
            <Circle cx={s.x} cy={s.y} r={pr} color="#050505" />
            <Circle cx={s.x} cy={s.y} r={pr} style="stroke" strokeWidth={2} color="rgba(244,196,48,0.4)" />
          </Group>
        );
      })}

      {/* Aim guide (dotted line + ghost ball) */}
      {cuePath.length > 1 && (
        <Group>
          {cuePath.map((pt, i) => {
            if (i % 2 !== 0) return null;
            const s = proj.toScreen(pt.x, pt.y);
            return <Circle key={`aim${i}`} cx={s.x} cy={s.y} r={2.5} color="rgba(255,255,255,0.75)" />;
          })}
          {showGhost && (() => {
            const end = cuePath[cuePath.length - 1];
            const s = proj.toScreen(end.x, end.y);
            return <Circle cx={s.x} cy={s.y} r={R} style="stroke" strokeWidth={1.5} color="rgba(255,255,255,0.5)" />;
          })()}
        </Group>
      )}

      {/* Balls */}
      {balls.filter((b) => b.active).map((b) => {
        const s = proj.toScreen(b.x, b.y);
        if (b.id === 0) {
          return (
            <Group key="ball0">
              <Circle cx={s.x} cy={s.y} r={R} color="#F5F5F5" />
              <Circle cx={s.x - R * 0.3} cy={s.y - R * 0.3} r={R * 0.28} color="rgba(255,255,255,0.9)" />
            </Group>
          );
        }
        const color = BALL_COLORS[b.id] ?? '#888';
        if (isStripe(b.id)) {
          const clip = Skia.Path.Make();
          clip.addCircle(s.x, s.y, R);
          return (
            <Group key={`ball${b.id}`}>
              <Circle cx={s.x} cy={s.y} r={R} color="#F5F5F5" />
              <Group clip={clip}>
                <Rect x={s.x - R} y={s.y - R * 0.45} width={R * 2} height={R * 0.9} color={color} />
              </Group>
              <Circle cx={s.x - R * 0.3} cy={s.y - R * 0.3} r={R * 0.22} color="rgba(255,255,255,0.55)" />
              <Circle cx={s.x} cy={s.y} r={R} style="stroke" strokeWidth={1} color="rgba(0,0,0,0.25)" />
            </Group>
          );
        }
        return (
          <Group key={`ball${b.id}`}>
            <Circle cx={s.x} cy={s.y} r={R} color={color} />
            <Circle cx={s.x - R * 0.3} cy={s.y - R * 0.3} r={R * 0.24} color="rgba(255,255,255,0.4)" />
          </Group>
        );
      })}
    </Canvas>
  );
}
