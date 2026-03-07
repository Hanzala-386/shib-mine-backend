import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, Pressable, Image, Alert, Platform,
  Dimensions, Animated, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useWallet } from '@/context/WalletContext';
import { adService } from '@/lib/AdService';
import { getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';

/* ─── Screen-responsive constants ──────────────────────────────── */
const { width: SW, height: SH } = Dimensions.get('window');
const BOSS_SIZE = Math.min(SW * 0.48, 180);
const BOSS_R    = BOSS_SIZE / 2;
const KNIFE_W   = 8;
const KNIFE_H   = Math.round(BOSS_SIZE * 0.68);

/* ─── Level definitions ─────────────────────────────────────────── */
const LEVELS = [
  { knives: 8,  speedDeg: 0.9,  dir: 1  },
  { knives: 9,  speedDeg: 1.2,  dir: -1 },
  { knives: 10, speedDeg: 1.5,  dir: 1  },
  { knives: 9,  speedDeg: 1.8,  dir: -1 },
  { knives: 11, speedDeg: 2.1,  dir: 1  },
  { knives: 10, speedDeg: 2.4,  dir: -1 },
];
function getLevel(n: number) { return LEVELS[Math.min(n - 1, LEVELS.length - 1)]; }

/* ─── Asset URLs ────────────────────────────────────────────────── */
const BASE = getApiUrl() + '/game/';
const BOSS_IMGS = [
  `${BASE}Bosses/boss-Ground.png`,
  `${BASE}Bosses/boss-Orange.png`,
  `${BASE}Bosses/boss-WaterMelon.png`,
  `${BASE}Bosses/boss-Meat.png`,
  `${BASE}Bosses/boss-Tire.png`,
  `${BASE}Bosses/boss-lid.png`,
];
const KNIFE_SKINS = [
  `${BASE}Knives/Knife.png`,
  `${BASE}Knives/item knife-01.png`,
  `${BASE}Knives/item knife-02.png`,
  `${BASE}Knives/item knife-03.png`,
];

/* ─── Types ─────────────────────────────────────────────────────── */
type Phase = 'menu' | 'playing' | 'game_over' | 'awarding' | 'reward';

interface StuckKnife {
  id: string;
  localAngle: number; // degrees relative to boss — 0 = right, 90 = down
}

/* ─── Helpers ───────────────────────────────────────────────────── */
function normAngleDiff(a: number, b: number) {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { addPowerTokens, powerTokens } = useWallet();

  /* Layout — computed once so no recalcs on re-render */
  const topPad   = Platform.OS === 'web' ? 67 : insets.top;
  const botPad   = Platform.OS === 'web' ? 34 : insets.bottom;
  const HUD_H    = 56;
  const BOSS_CY  = topPad + HUD_H + BOSS_R + 16;
  const KNIFE_START_Y = BOSS_CY + BOSS_R + KNIFE_H / 2 + 50;

  /* ── Animated values — no re-renders when updated ── */
  const bossRotAnim  = useRef(new Animated.Value(0)).current;
  const knifeYAnim   = useRef(new Animated.Value(KNIFE_START_Y)).current;

  /* ── Game-loop refs — pure JS, no React reconciler ── */
  const rafRef        = useRef<number | null>(null);
  const lastTsRef     = useRef<number>(0);
  const bossAngleRef  = useRef(0);           // current boss rotation (deg)
  const bossSpeedRef  = useRef(0.9);         // deg/frame normalised to 60fps
  const bossDirRef    = useRef<1|-1>(1);
  const knifeTopRef   = useRef(KNIFE_START_Y); // knife top edge y
  const isFlyingRef   = useRef(false);
  const phaseRef      = useRef<Phase>('menu');
  const stuckRef      = useRef<StuckKnife[]>([]);
  const knivesLeftRef = useRef(LEVELS[0].knives);
  const levelRef      = useRef(1);
  const scoreRef      = useRef(0);

  /* ── React state — drives UI re-renders only when needed ── */
  const [phase, setPhase]           = useState<Phase>('menu');
  const [level, setLevel]           = useState(1);
  const [stuckKnives, setStuckKnives] = useState<StuckKnife[]>([]);
  const [knivesLeft, setKnivesLeft] = useState(LEVELS[0].knives);
  const [totalKnives, setTotalKnives] = useState(LEVELS[0].knives);
  const [bossIdx, setBossIdx]       = useState(0);
  const [skinIdx]                   = useState(() => Math.floor(Math.random() * KNIFE_SKINS.length));
  const [score, setScore]           = useState(0);
  const [ptEarned, setPtEarned]     = useState(0);
  const [isLoadingAd, setIsLoadingAd] = useState(false);

  /* ── Game loop ──────────────────────────────────────── */
  function gameLoop(ts: number) {
    if (phaseRef.current !== 'playing') return;

    const dt = lastTsRef.current ? Math.min((ts - lastTsRef.current) / 16.67, 3) : 1;
    lastTsRef.current = ts;

    // Rotate boss
    bossAngleRef.current += bossSpeedRef.current * bossDirRef.current * dt;
    bossRotAnim.setValue(bossAngleRef.current);

    // Move flying knife upward
    if (isFlyingRef.current) {
      knifeTopRef.current -= 14 * dt;           // 14 px/frame at 60fps
      knifeYAnim.setValue(knifeTopRef.current);

      // Knife tip = knifeTopRef.current (top edge)
      // Hit when tip enters boss circle from below
      const tipY = knifeTopRef.current;
      if (tipY <= BOSS_CY + BOSS_R) {
        onKnifeHit();
        return;
      }
      // Safety: knife overshot boss without hitting (shouldn't happen)
      if (tipY < BOSS_CY - BOSS_R - 10) {
        isFlyingRef.current = false;
        resetKnifePosition();
      }
    }

    rafRef.current = requestAnimationFrame(gameLoop);
  }

  /* ── Knife hit ──────────────────────────────────────── */
  function onKnifeHit() {
    isFlyingRef.current = false;

    // Impact is always at the bottom of the boss (angle = 90° from boss center)
    // Local angle = impact_global - current_boss_rotation
    const impactGlobal = 90;
    let local = ((impactGlobal - bossAngleRef.current) % 360 + 360) % 360;
    if (local > 180) local -= 360;  // normalize to -180..180

    // Collision check against every stuck knife
    const collision = stuckRef.current.some(k => normAngleDiff(local, k.localAngle) < 20);

    if (collision) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      endGame();
      return;
    }

    // Stick the knife
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const newKnife: StuckKnife = { id, localAngle: local };
    stuckRef.current = [...stuckRef.current, newKnife];
    knivesLeftRef.current--;
    scoreRef.current += 10;

    setStuckKnives([...stuckRef.current]);
    setScore(scoreRef.current);
    setKnivesLeft(knivesLeftRef.current);

    if (knivesLeftRef.current <= 0) {
      // Level cleared
      setTimeout(() => advanceLevel(), 400);
    } else {
      resetKnifePosition();
      rafRef.current = requestAnimationFrame(gameLoop);
    }
  }

  /* ── Level advance ──────────────────────────────────── */
  function advanceLevel() {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const nextLevel = levelRef.current + 1;
    levelRef.current = nextLevel;
    scoreRef.current += nextLevel * 5;

    const cfg = getLevel(nextLevel);
    bossSpeedRef.current = cfg.speedDeg;
    bossDirRef.current   = cfg.dir as 1 | -1;
    knivesLeftRef.current = cfg.knives;
    stuckRef.current = [];

    setLevel(nextLevel);
    setScore(scoreRef.current);
    setBossIdx(b => (b + 1) % BOSS_IMGS.length);
    setKnivesLeft(cfg.knives);
    setTotalKnives(cfg.knives);
    setStuckKnives([]);
    resetKnifePosition();
    rafRef.current = requestAnimationFrame(gameLoop);
  }

  /* ── Game over ──────────────────────────────────────── */
  function endGame() {
    cancelAnimationFrame(rafRef.current!);
    phaseRef.current = 'game_over';
    const pt = Math.max(1, Math.floor((scoreRef.current + stuckRef.current.length * 10) / 20));
    setPtEarned(pt);
    setPhase('game_over');
  }

  /* ── Start / restart ────────────────────────────────── */
  function startGame() {
    cancelAnimationFrame(rafRef.current!);
    levelRef.current   = 1;
    scoreRef.current   = 0;
    const cfg          = getLevel(1);
    bossSpeedRef.current   = cfg.speedDeg;
    bossDirRef.current     = 1;
    bossAngleRef.current   = 0;
    knivesLeftRef.current  = cfg.knives;
    stuckRef.current       = [];
    lastTsRef.current      = 0;

    bossRotAnim.setValue(0);
    setLevel(1);
    setScore(0);
    setBossIdx(0);
    setKnivesLeft(cfg.knives);
    setTotalKnives(cfg.knives);
    setStuckKnives([]);
    setPtEarned(0);
    resetKnifePosition();

    phaseRef.current = 'playing';
    setPhase('playing');
    rafRef.current = requestAnimationFrame(gameLoop);
  }

  function resetKnifePosition() {
    knifeTopRef.current = KNIFE_START_Y;
    knifeYAnim.setValue(KNIFE_START_Y);
    isFlyingRef.current = false;
  }

  /* ── Tap to throw ───────────────────────────────────── */
  function handleTap() {
    if (phaseRef.current !== 'playing' || isFlyingRef.current) return;
    isFlyingRef.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  /* ── Token awarding ─────────────────────────────────── */
  async function awardPT(amount: number) {
    phaseRef.current = 'awarding';
    setPhase('awarding');
    try {
      await addPowerTokens(amount, 'knife_hit');
      phaseRef.current = 'reward';
      setPhase('reward');
      setPtEarned(amount);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Could not save tokens. Check your connection and try again.');
      phaseRef.current = 'game_over';
      setPhase('game_over');
    }
  }

  async function handleCollect() {
    await awardPT(ptEarned);
  }

  async function handleDoubleAd() {
    if (isLoadingAd) return;
    setIsLoadingAd(true);
    try {
      await adService.showAdMobRewarded((rewarded: boolean) => {
        setIsLoadingAd(false);
        if (rewarded) {
          awardPT(ptEarned * 2);
        } else {
          Alert.alert('Ad incomplete', 'Finish the ad to double your tokens.');
        }
      });
    } catch {
      setIsLoadingAd(false);
      awardPT(ptEarned);
    }
  }

  /* ── Cleanup on unmount ─────────────────────────────── */
  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  /* ── Derived rendering values ───────────────────────── */
  const bossInterpolate = bossRotAnim.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '360deg'],
    extrapolate: 'extend',  // allows values beyond 360
  });
  const bossAnimStyle = { transform: [{ rotate: bossInterpolate }] };

  /* ── Render stuck knife (inside boss-local space) ───── */
  function renderStuckKnife(k: StuckKnife) {
    const aRad  = (k.localAngle * Math.PI) / 180;
    // Center of knife View = boss_center_local + outward unit * (BOSS_R + half_knife)
    const cx    = BOSS_R + Math.cos(aRad) * (BOSS_R + KNIFE_H / 2);
    const cy    = BOSS_R + Math.sin(aRad) * (BOSS_R + KNIFE_H / 2);
    // Rotation: knife image points up by default → rotate so tip points outward
    const rot   = `${k.localAngle + 90}deg`;
    return (
      <View
        key={k.id}
        style={{
          position: 'absolute',
          left: cx - KNIFE_W / 2,
          top:  cy - KNIFE_H / 2,
          width: KNIFE_W,
          height: KNIFE_H,
          transform: [{ rotate: rot }],
        }}
      >
        <Image
          source={{ uri: KNIFE_SKINS[skinIdx] }}
          style={{ width: KNIFE_W, height: KNIFE_H }}
          resizeMode="stretch"
        />
      </View>
    );
  }

  /* ══════════════ RENDER ══════════════════════════════ */
  const isTappable = phase === 'playing';

  return (
    <Pressable
      style={styles.root}
      onPress={isTappable ? handleTap : undefined}
    >
      {/* ── Background ──────────────────────────────────── */}
      <Image
        source={{ uri: `${BASE}bg_wood.png` }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      />
      <View style={[StyleSheet.absoluteFill, styles.bgOverlay]} />

      {/* ── HUD ─────────────────────────────────────────── */}
      <View style={[styles.hud, { paddingTop: topPad + 8 }]}>
        <View style={styles.hudLeft}>
          <Text style={styles.hudLabel}>LEVEL</Text>
          <Text style={styles.hudValue}>{level}</Text>
        </View>
        <View style={styles.hudCenter}>
          {phase === 'playing' && (
            <View style={styles.knifeDotsRow}>
              {Array.from({ length: totalKnives }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.knifeDot,
                    { backgroundColor: i < (totalKnives - knivesLeft) ? Colors.gold : 'rgba(255,255,255,0.25)' },
                    i < (totalKnives - knivesLeft) && styles.knifeDotActive,
                  ]}
                />
              ))}
            </View>
          )}
        </View>
        <View style={styles.hudRight}>
          <Text style={styles.hudLabel}>PT</Text>
          <Text style={styles.hudValue}>{powerTokens}</Text>
        </View>
      </View>

      {/* ── Game objects ────────────────────────────────── */}
      <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
        {/* Rotating boss container — stuck knives live inside here */}
        <Animated.View
          style={[
            styles.bossContainer,
            {
              left:  SW / 2 - BOSS_R,
              top:   BOSS_CY - BOSS_R,
              width: BOSS_SIZE,
              height: BOSS_SIZE,
            },
            bossAnimStyle,
          ]}
        >
          {/* Boss image */}
          {(phase === 'playing' || phase === 'game_over' || phase === 'awarding') && (
            <Image
              source={{ uri: BOSS_IMGS[bossIdx] }}
              style={{ width: BOSS_SIZE, height: BOSS_SIZE, borderRadius: BOSS_R }}
              resizeMode="cover"
            />
          )}
          {/* Stuck knives — rotate with boss */}
          {stuckKnives.map(renderStuckKnife)}
        </Animated.View>

        {/* Flying / waiting knife — always at screen center X */}
        {(phase === 'playing') && (
          <Animated.View
            style={[
              styles.knifeContainer,
              {
                left:   SW / 2 - KNIFE_W / 2,
                width:  KNIFE_W,
                height: KNIFE_H,
                top:    knifeYAnim,
              },
            ]}
          >
            <Image
              source={{ uri: KNIFE_SKINS[skinIdx] }}
              style={{ width: KNIFE_W, height: KNIFE_H }}
              resizeMode="stretch"
            />
          </Animated.View>
        )}
      </View>

      {/* ── MENU ─────────────────────────────────────────── */}
      {phase === 'menu' && (
        <View style={[styles.centeredOverlay, { paddingTop: topPad + HUD_H + BOSS_SIZE + 40 }]}>
          <View style={styles.menuCard}>
            <MaterialCommunityIcons name="knife" size={44} color={Colors.gold} />
            <Text style={styles.menuTitle}>Knife Hit</Text>
            <Text style={styles.menuDesc}>
              Throw all knives into the spinning target — without hitting the ones already stuck!
            </Text>
            <View style={styles.ptBadge}>
              <Ionicons name="flash" size={14} color={Colors.gold} />
              <Text style={styles.ptBadgeText}>Win Power Tokens · Double with Ad</Text>
            </View>
            <Pressable style={styles.bigBtn} onPress={startGame}>
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                style={styles.bigBtnInner}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              >
                <Ionicons name="play" size={20} color="#000" />
                <Text style={styles.bigBtnText}>Play Now</Text>
              </LinearGradient>
            </Pressable>
          </View>
        </View>
      )}

      {/* ── TAP HINT ─────────────────────────────────────── */}
      {phase === 'playing' && (
        <View
          style={{
            position: 'absolute',
            left: 0, right: 0,
            bottom: botPad + 40,
            alignItems: 'center',
            pointerEvents: 'none',
          }}
        >
          <Text style={styles.tapHint}>tap anywhere to throw</Text>
        </View>
      )}

      {/* ── GAME OVER OVERLAY ────────────────────────────── */}
      {(phase === 'game_over' || phase === 'awarding' || phase === 'reward') && (
        <View style={[styles.overlayWrapper, { pointerEvents: 'box-none' }]}>
          <LinearGradient
            colors={['rgba(0,0,0,0)', 'rgba(8,4,0,0.96)', '#080400']}
            style={[styles.overlayGrad, { paddingBottom: botPad + 24 }]}
          >
            {/* Awarding state */}
            {phase === 'awarding' && (
              <View style={styles.overlayCard}>
                <ActivityIndicator size="large" color={Colors.gold} />
                <Text style={styles.awardText}>Saving tokens...</Text>
              </View>
            )}

            {/* Game over — pick reward */}
            {phase === 'game_over' && (
              <View style={styles.overlayCard}>
                <Text style={styles.gameOverTag}>GAME OVER</Text>
                <Text style={styles.scoreBig}>{score}</Text>
                <Text style={styles.scoreTag}>score · level {level}</Text>

                <View style={styles.ptRow}>
                  <Ionicons name="flash" size={16} color={Colors.gold} />
                  <Text style={styles.ptRowText}>{ptEarned} Power Token{ptEarned !== 1 ? 's' : ''} earned</Text>
                </View>

                {/* Double with ad */}
                <Pressable
                  style={({ pressed }) => [styles.bigBtn, { opacity: pressed || isLoadingAd ? 0.7 : 1 }]}
                  onPress={handleDoubleAd}
                  disabled={isLoadingAd}
                >
                  <LinearGradient
                    colors={[Colors.neonOrange, Colors.gold]}
                    style={styles.bigBtnInner}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  >
                    {isLoadingAd
                      ? <ActivityIndicator size="small" color="#000" />
                      : <Ionicons name="play-circle" size={20} color="#000" />}
                    <Text style={styles.bigBtnText}>
                      {isLoadingAd ? 'Loading...' : `Watch Ad → Get ${ptEarned * 2} PT`}
                    </Text>
                  </LinearGradient>
                </Pressable>

                {/* Collect without ad */}
                <Pressable style={styles.ghostBtn} onPress={handleCollect}>
                  <Text style={styles.ghostBtnText}>Collect {ptEarned} PT (no ad)</Text>
                </Pressable>
              </View>
            )}

            {/* Reward success */}
            {phase === 'reward' && (
              <View style={styles.overlayCard}>
                <Ionicons name="checkmark-circle" size={52} color={Colors.success} />
                <Text style={styles.rewardTitle}>+{ptEarned} PT Added!</Text>
                <Text style={styles.rewardSub}>Tokens saved to your wallet</Text>
                <Pressable style={styles.bigBtn} onPress={startGame}>
                  <LinearGradient
                    colors={[Colors.gold, Colors.neonOrange]}
                    style={styles.bigBtnInner}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  >
                    <Ionicons name="refresh" size={18} color="#000" />
                    <Text style={styles.bigBtnText}>Play Again</Text>
                  </LinearGradient>
                </Pressable>
              </View>
            )}
          </LinearGradient>
        </View>
      )}
    </Pressable>
  );
}

/* ─── Styles ────────────────────────────────────────────────────── */
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#1a0800',
  },
  bgOverlay: {
    backgroundColor: 'rgba(0,0,0,0.30)',
  },

  /* HUD */
  hud: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  hudLeft:  { flex: 1, alignItems: 'flex-start' },
  hudCenter:{ flex: 2, alignItems: 'center', paddingTop: 6 },
  hudRight: { flex: 1, alignItems: 'flex-end' },
  hudLabel: {
    fontFamily: 'Inter_500Medium',
    fontSize: 10,
    color: Colors.textMuted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  hudValue: {
    fontFamily: 'Inter_700Bold',
    fontSize: 22,
    color: Colors.gold,
    lineHeight: 26,
  },

  /* Knife dots */
  knifeDotsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 5,
    maxWidth: SW * 0.45,
  },
  knifeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  knifeDotActive: {
    shadowColor: Colors.gold,
    shadowRadius: 4,
    shadowOpacity: 0.8,
    shadowOffset: { width: 0, height: 0 },
  },

  /* Game objects */
  bossContainer: {
    position: 'absolute',
    overflow: 'visible',
  },
  knifeContainer: {
    position: 'absolute',
    overflow: 'visible',
  },

  /* Tap hint */
  tapHint: {
    fontFamily: 'Inter_400Regular',
    fontSize: 13,
    color: 'rgba(255,255,255,0.45)',
    letterSpacing: 0.5,
  },

  /* Menu */
  centeredOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 24,
  },
  menuCard: {
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,200,0,0.2)',
    width: '100%',
  },
  menuTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 26,
    color: Colors.gold,
  },
  menuDesc: {
    fontFamily: 'Inter_400Regular',
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  ptBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(244,196,48,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.25)',
  },
  ptBadgeText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
    color: Colors.gold,
  },

  /* Buttons */
  bigBtn: {
    width: '100%',
    borderRadius: 14,
    overflow: 'hidden',
  },
  bigBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
  },
  bigBtnText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
    color: '#000',
  },
  ghostBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  ghostBtnText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
  },

  /* Game-over overlay */
  overlayWrapper: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  overlayGrad: {
    paddingTop: 80,
    paddingHorizontal: 20,
  },
  overlayCard: {
    alignItems: 'center',
    gap: 12,
    paddingBottom: 8,
  },

  /* Awarding */
  awardText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 15,
    color: Colors.textMuted,
    marginTop: 8,
  },

  /* Score */
  gameOverTag: {
    fontFamily: 'Inter_700Bold',
    fontSize: 11,
    color: Colors.textMuted,
    letterSpacing: 3,
  },
  scoreBig: {
    fontFamily: 'Inter_700Bold',
    fontSize: 64,
    color: Colors.gold,
    lineHeight: 68,
  },
  scoreTag: {
    fontFamily: 'Inter_400Regular',
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: -8,
  },
  ptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(244,196,48,0.1)',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.2)',
  },
  ptRowText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
    color: Colors.gold,
  },

  /* Reward */
  rewardTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 26,
    color: Colors.success,
    marginTop: 4,
  },
  rewardSub: {
    fontFamily: 'Inter_500Medium',
    fontSize: 14,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
  },
});
