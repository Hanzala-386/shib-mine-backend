/* ────────────────────────────────────────────────────────────────────────────
 * poolSfx — sound effects + haptics for the 8-Ball table.
 *
 * Sounds are triggered from the frame-replay loop off the physics SimEvents
 * (cue_strike / ball_ball / cushion / pocket). Each key keeps a small pool of
 * preloaded expo-av Sound instances that are round-robined so rapid, overlapping
 * hits during a break don't cut each other off.
 *
 * All calls are best-effort and fail silently — audio/haptics are polish, never a
 * hard dependency. Haptics no-op on web; expo-av plays fine on web after the
 * user's first gesture (which always precedes a shot).
 * ──────────────────────────────────────────────────────────────────────────── */

import { Platform } from 'react-native';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';

export type SfxKey = 'strike' | 'click' | 'cushion' | 'pocket';

const SRC: Record<SfxKey, any> = {
  strike: require('../assets/pool/sfx/cue_strike.mp3'),
  click: require('../assets/pool/sfx/ball_click.mp3'),
  cushion: require('../assets/pool/sfx/cushion.mp3'),
  pocket: require('../assets/pool/sfx/pocket.mp3'),
};
const POOL_SIZE: Record<SfxKey, number> = { strike: 2, click: 4, cushion: 3, pocket: 2 };

let instances: Partial<Record<SfxKey, Audio.Sound[]>> = {};
const rr: Record<SfxKey, number> = { strike: 0, click: 0, cushion: 0, pocket: 0 };
let ready = false;
let loading = false;
let lastHaptic = 0;

/** Preload every SFX instance. Safe to call repeatedly (idempotent). */
export async function initPoolAudio(): Promise<void> {
  if (ready || loading) return;
  loading = true;
  try {
    await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, shouldDuckAndroid: true });
    const next: Partial<Record<SfxKey, Audio.Sound[]>> = {};
    for (const key of Object.keys(SRC) as SfxKey[]) {
      const arr: Audio.Sound[] = [];
      for (let i = 0; i < POOL_SIZE[key]; i++) {
        const { sound } = await Audio.Sound.createAsync(SRC[key], { volume: 1 });
        arr.push(sound);
      }
      next[key] = arr;
    }
    instances = next;
    ready = true;
  } catch {
    /* audio is optional */
  } finally {
    loading = false;
  }
}

/** Play a SFX at 0..1 volume, round-robining across the preloaded pool. */
export function playPoolSfx(key: SfxKey, volume = 1): void {
  const arr = instances[key];
  if (!arr || arr.length === 0) return;
  const s = arr[rr[key] % arr.length];
  rr[key] += 1;
  const v = Math.max(0, Math.min(1, volume));
  s.setStatusAsync({ shouldPlay: true, positionMillis: 0, volume: v }).catch(() => {});
}

/** Haptic feedback for a physics event. No-op on web; throttled for bursts. */
export function poolHaptic(key: SfxKey, strong = false): void {
  if (Platform.OS === 'web') return;
  const now = Date.now();
  if (key !== 'pocket' && now - lastHaptic < 55) return; // throttle rapid clicks/cushions
  lastHaptic = now;
  try {
    if (key === 'pocket') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } else if (key === 'strike') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    } else if (key === 'click') {
      Haptics.impactAsync(strong ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  } catch {
    /* haptics optional */
  }
}

/** Unload all instances (call on screen unmount). */
export async function unloadPoolAudio(): Promise<void> {
  const all = (Object.values(instances).flat().filter(Boolean) as Audio.Sound[]);
  instances = {};
  ready = false;
  for (const s of all) {
    try { await s.unloadAsync(); } catch { /* ignore */ }
  }
}
