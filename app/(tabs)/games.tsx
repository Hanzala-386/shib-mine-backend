import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Dimensions, Animated, Easing,
  Pressable, Image, ImageBackground, Platform, Modal, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useWallet } from '@/context/WalletContext';
import { getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';

// ─── Asset base (server /game → public/game/Knife hit Template/) ──────────────
const BASE = `${getApiUrl()}/game/`;
const KNIFE_URI = `${BASE}Kunai-1.png`;     // single knife image

// ─── Screen dimensions ────────────────────────────────────────────────────────
const { width: SW, height: SH } = Dimensions.get('window');

// ─── Layout: CONT_S ≤ SW so nothing gets clipped on Android ──────────────────
const BOSS_SIZE   = Math.min(Math.floor(SW * 0.52), 195);
const BOSS_R      = BOSS_SIZE / 2;
const KNIFE_W     = 22;
const KNIFE_H     = Math.floor((SW - BOSS_SIZE) / 2) - 4; // guarantees CONT_S ≤ SW
const CONT_S      = BOSS_SIZE + KNIFE_H * 2;
const CENTER      = CONT_S / 2;

// 50% blade penetration: blade ≈ 60% of knife → 0.30 × KNIFE_H sinks in
const PENETRATION = Math.round(KNIFE_H * 0.30);
// Radial dist from container center to knife image center (with penetration)
const RADIAL_DIST = BOSS_R + KNIFE_H / 2 - PENETRATION;

// ─── Timing ───────────────────────────────────────────────────────────────────
const HUD_H         = 52;
const THROW_MS      = 185;   // fast, snappy throw
const ROT_NORMAL_MS = 3200;  // ms per full rotation (normal stage)
const ROT_BOSS_MS   = 1600;  // ms per full rotation (boss stage)
const CLASH_DEG     = 14;

// ─── Stage system ─────────────────────────────────────────────────────────────
const CHAPTER_SIZE  = 5;    // 4 normal + 1 boss
const KNIVES_NORMAL = 7;
const KNIVES_BOSS   = 10;
const PT_PER_KNIFE  = 2;
const PT_BOSS_BONUS = 12;

const BOSS_IMGS = [
  `${BASE}Bosses/boss-Ground.png`,
  `${BASE}Bosses/boss-Orange.png`,
  `${BASE}Bosses/boss-WaterMelon.png`,
  `${BASE}Bosses/boss-Meat.png`,
  `${BASE}Bosses/boss-lid.png`,
  `${BASE}Bosses/boss-Tire.png`,
];

const KEY_SCORE = 'kh_best_score';
const KEY_STAGE = 'kh_best_stage';

type Phase = 'home' | 'playing' | 'game_over' | 'awarding' | 'reward';
interface Knife { id: number; localAngle: number }

// ─── Component ────────────────────────────────────────────────────────────────
export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens, addPowerTokens } = useWallet();

  const TOP_PAD    = Platform.OS === 'web' ? 67 : insets.top;
  const CONT_TOP   = TOP_PAD + HUD_H + 4;
  const BOSS_CY    = CONT_TOP + CENTER;
  const KNIFE_START = BOSS_CY + BOSS_R + KNIFE_H * 0.65 + 16;
  const HIT_Y       = BOSS_CY + BOSS_R - PENETRATION;

  // ── Animated values ────────────────────────────────────────────────────────
  const bossRot  = useRef(new Animated.Value(0)).current; // 0→1, native driver
  const knifeY   = useRef(new Animated.Value(0)).current; // JS driver, y-offset

  // ── Refs ───────────────────────────────────────────────────────────────────
  const rotLoop    = useRef<Animated.CompositeAnimation | null>(null);
  const angleRef   = useRef(0);   // current boss angle in degrees
  const stuckRef   = useRef<Knife[]>([]);
  const earnedRef  = useRef(0);
  const stageRef   = useRef(1);
  const scoreRef   = useRef(0);
  const knivesRef  = useRef(KNIVES_NORMAL);
  const flyingRef  = useRef(false); // true while knife is in air
  const sndHit     = useRef<Audio.Sound | null>(null);
  const sndClash   = useRef<Audio.Sound | null>(null);
  const sndCoin    = useRef<Audio.Sound | null>(null);

  // ── State ──────────────────────────────────────────────────────────────────
  const [phase, setPhase]       = useState<Phase>('home');
  const [stage, setStage]       = useState(1);
  const [score, setScore]       = useState(0);
  const [left, setLeft]         = useState(KNIVES_NORMAL);
  const [total, setTotal]       = useState(KNIVES_NORMAL);
  const [stuck, setStuck]       = useState<Knife[]>([]);
  const [flying, setFlying]     = useState(false);
  const [clash, setClash]       = useState(false);
  const [earned, setEarned]     = useState(0);
  const [bossImg, setBossImg]   = useState(BOSS_IMGS[0]);
  const [bestScore, setBestScore] = useState(0);
  const [bestStage, setBestStage] = useState(0);

  const isBoss         = (s: number) => s % CHAPTER_SIZE === 0;
  const posInChapter   = (s: number) => ((s - 1) % CHAPTER_SIZE) + 1;

  // ── Track boss angle from native animation ─────────────────────────────────
  useEffect(() => {
    const id = bossRot.addListener(({ value }) => { angleRef.current = value * 360; });
    return () => bossRot.removeListener(id);
  }, [bossRot]);

  // ── Load best records ──────────────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.multiGet([KEY_SCORE, KEY_STAGE]).then(pairs => {
      const sc = pairs[0][1]; const st = pairs[1][1];
      if (sc) setBestScore(parseInt(sc, 10));
      if (st) setBestStage(parseInt(st, 10));
    }).catch(() => {});
  }, []);

  // ── Load sounds ────────────────────────────────────────────────────────────
  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
    const load = async (uri: string) => {
      try { const { sound } = await Audio.Sound.createAsync({ uri }); return sound; }
      catch { return null; }
    };
    (async () => {
      sndHit.current   = await load(`${BASE}sound/UsedInGame/ev_apple_hit_1.mp3`);
      sndClash.current = await load(`${BASE}sound/UsedInGame/ev_boss_fight_hit.mp3`);
      sndCoin.current  = await load(`${BASE}sound/UsedInGame/ev_apples_coins.mp3`);
    })();
    return () => {
      sndHit.current?.unloadAsync();
      sndClash.current?.unloadAsync();
      sndCoin.current?.unloadAsync();
    };
  }, []);

  const play = (s: Audio.Sound | null) => { try { s?.replayAsync(); } catch {} };

  // ── Boss rotation (60 FPS native driver) ───────────────────────────────────
  const startSpin = useCallback((boss: boolean) => {
    rotLoop.current?.stop();
    bossRot.setValue(0);
    angleRef.current = 0;
    rotLoop.current = Animated.loop(
      Animated.timing(bossRot, {
        toValue: 1,
        duration: boss ? ROT_BOSS_MS : ROT_NORMAL_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    rotLoop.current.start();
  }, [bossRot]);

  const stopSpin = useCallback(() => { rotLoop.current?.stop(); }, []);
  useEffect(() => () => { rotLoop.current?.stop(); }, []);

  // ── Init a stage ───────────────────────────────────────────────────────────
  const initStage = useCallback((s: number) => {
    const boss = isBoss(s);
    const n    = boss ? KNIVES_BOSS : KNIVES_NORMAL;
    if (boss) setBossImg(BOSS_IMGS[Math.floor(Math.random() * BOSS_IMGS.length)]);
    stuckRef.current = [];
    flyingRef.current = false;
    knivesRef.current = n;
    setStuck([]);
    setLeft(n);
    setTotal(n);
    setFlying(false);
    knifeY.setValue(0);
    startSpin(boss);
  }, [knifeY, startSpin]);

  // ── Start game ─────────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    stageRef.current  = 1;
    scoreRef.current  = 0;
    earnedRef.current = 0;
    setStage(1);
    setScore(0);
    setEarned(0);
    setClash(false);
    setPhase('playing');
    initStage(1);
  }, [initStage]);

  // ── Knife lands ────────────────────────────────────────────────────────────
  const onKnifeLand = useCallback(() => {
    const local = ((90 - angleRef.current) % 360 + 360) % 360;

    // Clash check
    const hit = stuckRef.current.some(k => {
      let d = Math.abs(k.localAngle - local) % 360;
      if (d > 180) d = 360 - d;
      return d < CLASH_DEG;
    });
    if (hit) {
      setClash(true);
      play(sndClash.current);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      stopSpin();
      setTimeout(() => { setClash(false); setPhase('game_over'); }, 400);
      return;
    }

    // Stick knife
    const k: Knife = { id: Date.now() + Math.random(), localAngle: local };
    stuckRef.current = [...stuckRef.current, k];
    setStuck([...stuckRef.current]);
    play(sndHit.current);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    scoreRef.current += 1;
    setScore(scoreRef.current);

    flyingRef.current = false;
    setFlying(false);
    knifeY.setValue(0);

    knivesRef.current = Math.max(0, knivesRef.current - 1);
    const rem = knivesRef.current;
    setLeft(rem);

    if (rem <= 0) {
      stopSpin();
      const boss = isBoss(stageRef.current);
      const pts  = stuckRef.current.length * PT_PER_KNIFE + (boss ? PT_BOSS_BONUS : 0);
      earnedRef.current += pts;
      setEarned(earnedRef.current);
      play(sndCoin.current);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => {
        const next = stageRef.current + 1;
        stageRef.current = next;
        setStage(next);
        initStage(next);
      }, 600);
    }
  }, [knifeY, stopSpin, initStage]);

  // ── Throw (instant on tap) ─────────────────────────────────────────────────
  const throwKnife = useCallback(() => {
    if (flyingRef.current || phase !== 'playing' || knivesRef.current <= 0) return;
    flyingRef.current = true;
    setFlying(true);
    Animated.timing(knifeY, {
      toValue: -(KNIFE_START - HIT_Y),
      duration: THROW_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start(({ finished }) => { if (finished) onKnifeLand(); });
  }, [phase, knifeY, KNIFE_START, HIT_Y, onKnifeLand]);

  // ── Collect tokens ─────────────────────────────────────────────────────────
  const collect = useCallback(async () => {
    if (!earnedRef.current) { setPhase('home'); return; }
    setPhase('awarding');
    try {
      await addPowerTokens(earnedRef.current, 'knife_hit');
      const ns = Math.max(bestScore, scoreRef.current);
      const nt = Math.max(bestStage, stageRef.current);
      setBestScore(ns); setBestStage(nt);
      await AsyncStorage.multiSet([[KEY_SCORE, String(ns)], [KEY_STAGE, String(nt)]]);
    } catch {}
    setPhase('reward');
  }, [addPowerTokens, bestScore, bestStage]);

  const goHome = useCallback(() => {
    stopSpin();
    stuckRef.current = [];
    setStuck([]);
    setPhase('home');
  }, [stopSpin]);

  // ── Render a stuck knife ───────────────────────────────────────────────────
  function renderStuck(k: Knife) {
    const rad = (k.localAngle * Math.PI) / 180;
    const cx  = CENTER + Math.cos(rad) * RADIAL_DIST;
    const cy  = CENTER + Math.sin(rad) * RADIAL_DIST;
    const rot = k.localAngle - 90;   // tip toward boss center, handle outward
    return (
      <View
        key={k.id}
        style={{
          position: 'absolute',
          left: cx - KNIFE_W / 2,
          top:  cy - KNIFE_H / 2,
          width: KNIFE_W,
          height: KNIFE_H,
          transform: [{ rotate: `${rot}deg` }],
        }}
      >
        <Image source={{ uri: KNIFE_URI }} style={{ width: KNIFE_W, height: KNIFE_H }} resizeMode="contain" />
      </View>
    );
  }

  // ── Left-side remaining indicators ────────────────────────────────────────
  function renderIndicators() {
    const SLOT   = 24;
    const top    = BOSS_CY - (total * SLOT) / 2;
    const thrown = total - left;
    return (
      <View style={{ position: 'absolute', left: 10, top, zIndex: 30, alignItems: 'center', gap: 3, pointerEvents: 'none' } as any}>
        {Array.from({ length: total }).map((_, i) => (
          <View key={i} style={{ width: 13, height: 20, opacity: i < thrown ? 0.18 : 0.8 }}>
            <Image source={{ uri: KNIFE_URI }} style={{ width: 13, height: 20 }} resizeMode="contain" />
          </View>
        ))}
      </View>
    );
  }

  // ── Stage dots ─────────────────────────────────────────────────────────────
  function renderStageDots() {
    const pos = posInChapter(stage);
    return (
      <View style={S.stageWrap}>
        <View style={S.dots}>
          {[1, 2, 3, 4].map(i => (
            <View key={i} style={[S.dot, pos === i && S.dotActive]} />
          ))}
          <Image
            source={{ uri: `${BASE}GamePlay%20Screen/CrossKnife.png` }}
            style={[S.bossIcon, pos === 5 && S.bossIconActive]}
            resizeMode="contain"
          />
        </View>
        <Text style={S.stageLabel}>STAGE {stage}</Text>
      </View>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HOME SCREEN — background + PLAY button only
  // ═══════════════════════════════════════════════════════════════════════════
  if (phase === 'home') {
    return (
      <ImageBackground
        source={{ uri: `${BASE}Home/home_background.png` }}
        style={S.root}
        resizeMode="cover"
      >
        {/* Minimal PT badge top-right */}
        <View style={[S.homePT, { top: TOP_PAD + 10 }]}>
          <Ionicons name="flash" size={14} color={Colors.gold} />
          <Text style={S.homePTText}>{powerTokens} PT</Text>
        </View>

        {/* Centered PLAY button */}
        <View style={S.homeCenter}>
          <Pressable style={S.playBtn} onPress={startGame} testID="play-button">
            <Text style={S.playBtnText}>PLAY  ▶</Text>
          </Pressable>
        </View>

        {/* Small bottom info */}
        <View style={[S.homeBottom, { bottom: (Platform.OS === 'web' ? 34 : insets.bottom) + 20 }]}>
          <Text style={S.homeInfo}>Best  Stage {bestStage}  •  Score {bestScore}</Text>
        </View>
      </ImageBackground>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GAME SCREEN
  // ═══════════════════════════════════════════════════════════════════════════
  const BOT = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <Pressable style={S.root} onPress={throwKnife}>
      <ImageBackground source={{ uri: `${BASE}bg_wood.png` }} style={S.root} resizeMode="cover">

        {/* HUD */}
        <View style={[S.hud, { paddingTop: TOP_PAD + 4 }]}>
          <Text style={S.hudScore}>{score}</Text>
          {renderStageDots()}
          <View style={S.hudPT}>
            <Ionicons name="flash" size={13} color={Colors.gold} />
            <Text style={S.hudPTText}>{powerTokens} PT</Text>
          </View>
        </View>

        {/* Left indicators */}
        {phase === 'playing' && renderIndicators()}

        {/* Boss rotating container — native driver, 60 FPS */}
        <Animated.View
          style={{
            position: 'absolute',
            left: SW / 2 - CENTER,
            top: CONT_TOP,
            width: CONT_S,
            height: CONT_S,
            transform: [{
              rotate: bossRot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }),
            }],
          }}
        >
          {/* Target — offset inward by KNIFE_H so knives fit inside CONT_S */}
          <Image
            source={{ uri: isBoss(stage) ? bossImg : `${BASE}Target_Normal.png` }}
            style={{
              position: 'absolute',
              left: KNIFE_H, top: KNIFE_H,
              width: BOSS_SIZE, height: BOSS_SIZE,
              borderRadius: BOSS_R,
            }}
            resizeMode="cover"
          />
          {isBoss(stage) && (
            <View style={{ position:'absolute', left:KNIFE_H, top:KNIFE_H, width:BOSS_SIZE, height:BOSS_SIZE, borderRadius:BOSS_R, backgroundColor:'rgba(200,0,0,0.14)' }} />
          )}
          {/* Stuck knives — 50% blade embedded */}
          {stuck.map(renderStuck)}
        </Animated.View>

        {/* Flying knife — JS driver */}
        <Animated.View
          style={{
            position: 'absolute',
            left: SW / 2 - KNIFE_W / 2,
            top: KNIFE_START,
            width: KNIFE_W,
            height: KNIFE_H,
            zIndex: 25,
            pointerEvents: 'none',
            transform: [{ translateY: knifeY }],
          } as any}
        >
          <Image source={{ uri: KNIFE_URI }} style={{ width: KNIFE_W, height: KNIFE_H }} resizeMode="contain" />
        </Animated.View>

        {/* Boss badge */}
        {isBoss(stage) && (
          <View style={[S.bossBadge, { top: CONT_TOP - 28 }]}>
            <Text style={S.bossBadgeText}>⚔  BOSS STAGE</Text>
          </View>
        )}

        {/* Clash flash */}
        {clash && (
          <>
            <View style={[StyleSheet.absoluteFill, { backgroundColor:'rgba(255,30,30,0.22)', pointerEvents:'none' } as any]} />
            <Text style={[S.clashText, { top: BOSS_CY - 28 }]}>CLASH!</Text>
          </>
        )}

        {/* Tap hint */}
        {!flying && left > 0 && (
          <Text style={[S.tapHint, { bottom: BOT + 16 }]}>TAP TO THROW</Text>
        )}

        {/* ── GAME OVER ── */}
        <Modal visible={phase === 'game_over'} transparent animationType="fade">
          <View style={S.overlay}>
            <View style={S.card}>
              <Text style={S.cardTitle}>GAME OVER</Text>
              <Text style={S.cardSub}>Stage {stage}  ·  Score {score}</Text>
              <View style={S.ptRow}>
                <Ionicons name="flash" size={20} color={Colors.gold} />
                <Text style={S.ptEarned}>{earned} PT earned</Text>
              </View>
              <Pressable style={S.bigBtn} onPress={collect}>
                <Text style={S.bigBtnText}>Collect Tokens</Text>
              </Pressable>
              <Pressable style={S.ghost} onPress={goHome}>
                <Text style={S.ghostText}>← Home</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* ── AWARDING ── */}
        <Modal visible={phase === 'awarding'} transparent animationType="fade">
          <View style={S.overlay}>
            <View style={S.card}>
              <ActivityIndicator size="large" color={Colors.gold} />
              <Text style={S.cardSub}>Saving tokens…</Text>
            </View>
          </View>
        </Modal>

        {/* ── REWARD ── */}
        <Modal visible={phase === 'reward'} transparent animationType="fade">
          <View style={S.overlay}>
            <View style={S.card}>
              <Text style={{ fontSize: 44 }}>🎉</Text>
              <Text style={S.cardTitle}>+{earned} PT</Text>
              <Text style={S.cardSub}>{powerTokens} PT total</Text>
              <Pressable style={S.bigBtn} onPress={startGame}>
                <Text style={S.bigBtnText}>Play Again</Text>
              </Pressable>
              <Pressable style={S.ghost} onPress={goHome}>
                <Text style={S.ghostText}>← Home</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

      </ImageBackground>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a1f1c' },

  // Home
  homePT: {
    position: 'absolute', right: 18, flexDirection: 'row', alignItems: 'center', gap: 5, zIndex: 10,
  },
  homePTText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.gold },
  homeCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  playBtn: {
    backgroundColor: '#22c55e',
    paddingVertical: 20, paddingHorizontal: 64,
    borderRadius: 18,
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 10,
    elevation: 10,
  },
  playBtnText: { fontFamily: 'Inter_700Bold', fontSize: 22, color: '#fff', letterSpacing: 3 },
  homeBottom: { position: 'absolute', alignSelf: 'center' },
  homeInfo:   { fontFamily: 'Inter_500Medium', fontSize: 12, color: 'rgba(255,255,255,0.38)', letterSpacing: 1 },

  // Game HUD
  hud: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8, zIndex: 30 },
  hudScore:  { fontFamily: 'Inter_700Bold', fontSize: 26, color: '#fff', minWidth: 32 },
  hudPT:     { flexDirection: 'row', alignItems: 'center', gap: 4 },
  hudPTText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.gold },

  // Stage
  stageWrap: { flex: 1, alignItems: 'center', gap: 3 },
  dots:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot:       { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.20)' },
  dotActive: { backgroundColor: Colors.gold },
  bossIcon:  { width: 18, height: 18, opacity: 0.28 },
  bossIconActive: { opacity: 1 },
  stageLabel: { fontFamily: 'Inter_700Bold', fontSize: 11, color: '#fff', letterSpacing: 2 },

  // Boss badge
  bossBadge: {
    position: 'absolute', alignSelf: 'center',
    backgroundColor: 'rgba(180,0,0,0.85)', paddingHorizontal: 16, paddingVertical: 4,
    borderRadius: 10, zIndex: 30,
  },
  bossBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 11, color: '#fff', letterSpacing: 1 },

  // Clash
  clashText: {
    position: 'absolute', alignSelf: 'center',
    fontFamily: 'Inter_700Bold', fontSize: 22, color: '#ff4444', letterSpacing: 3, zIndex: 50,
  },

  // Tap hint
  tapHint: {
    position: 'absolute', alignSelf: 'center',
    fontFamily: 'Inter_500Medium', fontSize: 10,
    color: 'rgba(255,255,255,0.25)', letterSpacing: 3,
  },

  // Modals
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: '#0d1a17', borderRadius: 22, padding: 32,
    alignItems: 'center', gap: 14, width: SW * 0.82,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.18)',
  },
  cardTitle: { fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.text, letterSpacing: 2 },
  cardSub:   { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },
  ptRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ptEarned:  { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.gold },
  bigBtn: {
    backgroundColor: Colors.gold, paddingVertical: 14, borderRadius: 28,
    width: '100%', alignItems: 'center',
  },
  bigBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 1 },
  ghost:     { paddingVertical: 8 },
  ghostText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.38)' },
});
