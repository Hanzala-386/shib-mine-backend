import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Dimensions, Animated, Pressable,
  Image, ImageBackground, Platform, Modal, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useWallet } from '@/context/WalletContext';
import { useAuth } from '@/context/AuthContext';
import { getApiUrl } from '@/lib/query-client';
import KnifeShop, { SKINS, SkinDef } from '@/components/KnifeShop';
import Colors from '@/constants/colors';

// ─── Asset paths (all use the SAME correct base) ─────────────────────────────
const { width: SW } = Dimensions.get('window');
const BASE = `${getApiUrl()}/game/`;

// ─── Responsive dimensions — CONT_S ≤ SW so no overflow clipping ─────────────
const BOSS_SIZE  = Math.min(Math.floor(SW * 0.48), 180);
const BOSS_R     = BOSS_SIZE / 2;
const KNIFE_W    = 22;
const KNIFE_H    = Math.floor((SW - BOSS_SIZE) / 2) - 4; // CONT_S = SW-8
const CONT_S     = BOSS_SIZE + KNIFE_H * 2;
const CENTER     = CONT_S / 2;

// ─── Game constants ───────────────────────────────────────────────────────────
const HUD_H          = 58;
const CHAPTER_SIZE   = 5;       // 4 normal + 1 boss
const KNIVES_NORMAL  = 7;
const KNIVES_BOSS    = 10;
const NORMAL_SPEED   = 0.09;    // deg/ms
const BOSS_SPEED     = 0.15;
const CLASH_DEG      = 15;
const PT_PER_KNIFE   = 2;
const PT_BOSS_BONUS  = 12;

const BOSS_IMGS = [
  `${BASE}Bosses/boss-Ground.png`,
  `${BASE}Bosses/boss-Orange.png`,
  `${BASE}Bosses/boss-WaterMelon.png`,
  `${BASE}Bosses/boss-Meat.png`,
  `${BASE}Bosses/boss-lid.png`,
  `${BASE}Bosses/boss-Tire.png`,
];

const KEY_SKIN  = 'knife_hit_skin';
const KEY_STAGE = 'knife_hit_best_stage';
const KEY_SCORE = 'knife_hit_best_score';

type Phase = 'home' | 'playing' | 'game_over' | 'awarding' | 'reward';
interface StuckKnife { id: number; localAngle: number }

// ─── Component ───────────────────────────────────────────────────────────────
export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens, addPowerTokens } = useWallet();
  const { pbUser } = useAuth();

  const TOP_PAD    = Platform.OS === 'web' ? 67 : insets.top;
  const CONT_TOP   = TOP_PAD + HUD_H + 8;
  const BOSS_CY    = CONT_TOP + CENTER;
  const KNIFE_START = BOSS_CY + BOSS_R + KNIFE_H * 0.5 + 36;
  const HIT_Y       = BOSS_CY + BOSS_R - KNIFE_H * 0.06;

  // ── State ─────────────────────────────────────────────────────────────────
  const [phase, setPhase]             = useState<Phase>('home');
  const [stage, setStage]             = useState(1);
  const [score, setScore]             = useState(0);
  const [knivesLeft, setKnivesLeft]   = useState(KNIVES_NORMAL);
  const [totalKnives, setTotalKnives] = useState(KNIVES_NORMAL);
  const [stuckKnives, setStuckKnives] = useState<StuckKnife[]>([]);
  const [inFlight, setInFlight]       = useState(false);
  const [clashFlash, setClashFlash]   = useState(false);
  const [earnedPT, setEarnedPT]       = useState(0);
  const [bestStage, setBestStage]     = useState(0);
  const [bestScore, setBestScore]     = useState(0);
  const [equippedSkin, setEquippedSkin] = useState<SkinDef>(SKINS[0]);
  const [shopVisible, setShopVisible] = useState(false);
  const [bossImg, setBossImg]         = useState(BOSS_IMGS[0]);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const bossRotAnim   = useRef(new Animated.Value(0)).current;
  const knifeAnim     = useRef(new Animated.Value(0)).current;
  const bossAngleRef  = useRef(0);
  const rafRef        = useRef<number>(0);
  const lastTimeRef   = useRef<number>(0);
  const stuckRef      = useRef<StuckKnife[]>([]);
  const earnedRef     = useRef(0);
  const stageRef      = useRef(1);
  const scoreRef      = useRef(0);
  const knivesRef     = useRef(KNIVES_NORMAL);

  const isBoss = (s: number) => s % CHAPTER_SIZE === 0;
  const stageInChapter = (s: number) => ((s - 1) % CHAPTER_SIZE) + 1; // 1..5

  // ── Load persisted prefs ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [sk, bs, sc] = await Promise.all([
          AsyncStorage.getItem(KEY_SKIN),
          AsyncStorage.getItem(KEY_STAGE),
          AsyncStorage.getItem(KEY_SCORE),
        ]);
        if (sk) { const f = SKINS.find(s => s.id === sk); if (f) setEquippedSkin(f); }
        if (bs) setBestStage(parseInt(bs, 10));
        if (sc) setBestScore(parseInt(sc, 10));
      } catch { /* ignore */ }
    })();
  }, []);

  // ── Sounds ────────────────────────────────────────────────────────────────
  const sndHit   = useRef<Audio.Sound | null>(null);
  const sndClash = useRef<Audio.Sound | null>(null);
  const sndCoin  = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
    const load = async (uri: string) => {
      try { const { sound } = await Audio.Sound.createAsync({ uri }, { volume: 0.7 }); return sound; }
      catch { return null; }
    };
    (async () => {
      sndHit.current   = await load(`${BASE}sound/UsedInGame/ev_apple_hit_1.mp3`);
      sndClash.current = await load(`${BASE}sound/UsedInGame/ev_boss_fight_hit.mp3`);
      sndCoin.current  = await load(`${BASE}sound/UsedInGame/ev_apples_coins.mp3`);
    })();
    return () => {
      sndHit.current?.unloadAsync(); sndClash.current?.unloadAsync(); sndCoin.current?.unloadAsync();
    };
  }, []);

  // ── Boss rotation RAF ─────────────────────────────────────────────────────
  const startRotation = useCallback((speed: number) => {
    cancelAnimationFrame(rafRef.current);
    lastTimeRef.current = 0;
    function frame(now: number) {
      if (lastTimeRef.current === 0) lastTimeRef.current = now;
      const dt = Math.min(now - lastTimeRef.current, 50);
      lastTimeRef.current = now;
      const v = 1 + 0.3 * Math.sin(now * 0.0014);
      bossAngleRef.current += speed * dt * v;
      bossRotAnim.setValue(bossAngleRef.current);
      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);
  }, [bossRotAnim]);

  const stopRotation = useCallback(() => cancelAnimationFrame(rafRef.current), []);
  useEffect(() => () => { stopRotation(); }, [stopRotation]);

  // ── Start a stage ─────────────────────────────────────────────────────────
  const startStage = useCallback((s: number) => {
    const boss   = isBoss(s);
    const knives = boss ? KNIVES_BOSS : KNIVES_NORMAL;
    if (boss) setBossImg(BOSS_IMGS[Math.floor(Math.random() * BOSS_IMGS.length)]);
    stuckRef.current = [];
    setStuckKnives([]);
    knivesRef.current = knives;
    setKnivesLeft(knives);
    setTotalKnives(knives);
    setInFlight(false);
    knifeAnim.setValue(0);
    startRotation(boss ? BOSS_SPEED : NORMAL_SPEED);
  }, [knifeAnim, startRotation]);

  // ── Start game ────────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    bossAngleRef.current = 0;
    bossRotAnim.setValue(0);
    stageRef.current  = 1;
    scoreRef.current  = 0;
    earnedRef.current = 0;
    setStage(1);
    setScore(0);
    setEarnedPT(0);
    setClashFlash(false);
    setPhase('playing');
    startStage(1);
  }, [bossRotAnim, startStage]);

  // ── Handle knife sticking in boss ─────────────────────────────────────────
  const handleKnifeHit = useCallback(() => {
    const localAngle = ((90 - bossAngleRef.current) % 360 + 360) % 360;

    // Clash check
    const clashed = stuckRef.current.some(k => {
      let diff = Math.abs(k.localAngle - localAngle) % 360;
      if (diff > 180) diff = 360 - diff;
      return diff < CLASH_DEG;
    });

    if (clashed) {
      setClashFlash(true);
      sndClash.current?.replayAsync().catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      stopRotation();
      setTimeout(() => { setClashFlash(false); setPhase('game_over'); }, 450);
      return;
    }

    // Stick knife
    const knife: StuckKnife = { id: Date.now() + Math.random(), localAngle };
    stuckRef.current = [...stuckRef.current, knife];
    setStuckKnives([...stuckRef.current]);
    sndHit.current?.replayAsync().catch(() => {});
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Update score
    scoreRef.current += 1;
    setScore(scoreRef.current);

    setInFlight(false);
    knifeAnim.setValue(0);

    knivesRef.current = Math.max(0, knivesRef.current - 1);
    setKnivesLeft(prev => {
      const next = prev - 1;
      if (next <= 0) {
        stopRotation();
        const boss   = isBoss(stageRef.current);
        const earned = stuckRef.current.length * PT_PER_KNIFE + (boss ? PT_BOSS_BONUS : 0);
        earnedRef.current += earned;
        setEarnedPT(earnedRef.current);
        sndCoin.current?.replayAsync().catch(() => {});
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setTimeout(() => {
          const nextStage = stageRef.current + 1;
          stageRef.current = nextStage;
          setStage(nextStage);
          startStage(nextStage);
        }, 700);
      }
      return next;
    });
  }, [knifeAnim, stopRotation, startStage]);

  // ── Throw knife ───────────────────────────────────────────────────────────
  const throwKnife = useCallback(() => {
    if (inFlight || phase !== 'playing' || knivesRef.current <= 0) return;
    setInFlight(true);
    Animated.timing(knifeAnim, {
      toValue: -(KNIFE_START - HIT_Y),
      duration: 210,
      useNativeDriver: false,
    }).start(({ finished }) => { if (finished) handleKnifeHit(); });
  }, [inFlight, phase, knifeAnim, KNIFE_START, HIT_Y, handleKnifeHit]);

  // ── Collect PT ────────────────────────────────────────────────────────────
  const collectPT = useCallback(async () => {
    if (!earnedRef.current) { setPhase('home'); return; }
    setPhase('awarding');
    try {
      await addPowerTokens(earnedRef.current, 'knife_hit');
      // Save best records
      const newBestStage = Math.max(bestStage, stageRef.current);
      const newBestScore = Math.max(bestScore, scoreRef.current);
      setBestStage(newBestStage);
      setBestScore(newBestScore);
      await Promise.all([
        AsyncStorage.setItem(KEY_STAGE, String(newBestStage)),
        AsyncStorage.setItem(KEY_SCORE, String(newBestScore)),
      ]);
    } catch { /* ignore */ }
    setPhase('reward');
  }, [earnedRef, addPowerTokens, bestStage, bestScore]);

  const goHome = useCallback(() => {
    stopRotation();
    stuckRef.current = [];
    setStuckKnives([]);
    setPhase('home');
  }, [stopRotation]);

  // ── Equip skin ────────────────────────────────────────────────────────────
  const handleEquip = useCallback((skinId: string) => {
    const found = SKINS.find(s => s.id === skinId);
    if (found) { setEquippedSkin(found); AsyncStorage.setItem(KEY_SKIN, skinId).catch(() => {}); }
    setShopVisible(false);
  }, []);

  // ── Render stuck knife (FIXED rotation: localAngle - 90) ─────────────────
  function renderStuckKnife(knife: StuckKnife) {
    const rad = (knife.localAngle * Math.PI) / 180;
    const cx  = CENTER + Math.cos(rad) * (BOSS_R + KNIFE_H / 2);
    const cy  = CENTER + Math.sin(rad) * (BOSS_R + KNIFE_H / 2);
    // ── FIX: "-90" makes tip point TOWARD boss center (handle outward) ──────
    const rot = knife.localAngle - 90;
    return (
      <View
        key={knife.id}
        style={{
          position: 'absolute',
          left:   cx - KNIFE_W / 2,
          top:    cy - KNIFE_H / 2,
          width:  KNIFE_W,
          height: KNIFE_H,
          transform: [{ rotate: `${rot}deg` }],
          zIndex: 12,
        }}
      >
        <Image
          source={{ uri: equippedSkin.uri }}
          style={{ width: KNIFE_W, height: KNIFE_H }}
          resizeMode="contain"
        />
      </View>
    );
  }

  // ── Left side remaining knife indicators ─────────────────────────────────
  function renderLeftIndicators() {
    const SLOT = 28;
    const top  = BOSS_CY - (totalKnives * SLOT) / 2;
    const thrown = totalKnives - knivesLeft;
    return (
      <View style={{ position: 'absolute', left: 12, top, zIndex: 30, alignItems: 'center', gap: 2 }}>
        {Array.from({ length: totalKnives }).map((_, i) => (
          <View key={i} style={{ width: 16, height: 24, opacity: i < thrown ? 0.3 : 1 }}>
            <Image
              source={{ uri: equippedSkin.uri }}
              style={{ width: 16, height: 24 }}
              resizeMode="contain"
            />
          </View>
        ))}
      </View>
    );
  }

  // ── Stage indicator dots ──────────────────────────────────────────────────
  function renderStageIndicator() {
    const pos = stageInChapter(stage); // 1..5
    return (
      <View style={styles.stageWrap}>
        <View style={styles.stageDots}>
          {[1, 2, 3, 4].map(i => (
            <View key={i} style={[styles.stageDot, pos === i && styles.stageDotActive]} />
          ))}
          <Image
            source={{ uri: `${BASE}GamePlay%20Screen/CrossKnife.png` }}
            style={[styles.stageKnifeIcon, pos === 5 && styles.stageKnifeIconActive]}
            resizeMode="contain"
          />
        </View>
        <Text style={styles.stageLabel}>STAGE {stage}</Text>
      </View>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HOME SCREEN — matches screenshot exactly
  // ═══════════════════════════════════════════════════════════════════════════
  if (phase === 'home') {
    return (
      <View style={styles.root}>
        <ImageBackground
          source={{ uri: `${BASE}Home/home_background.png` }}
          style={styles.root}
          resizeMode="cover"
        >
          {/* Top bar */}
          <View style={[styles.homeTopRow, { paddingTop: TOP_PAD + 8 }]}>
            <Pressable onPress={() => {}} hitSlop={10}>
              <Image
                source={{ uri: `${BASE}Home/HomeIcon_Setting.png` }}
                style={styles.settingIcon}
                resizeMode="contain"
              />
            </Pressable>
            <View style={styles.homePTBadge}>
              <Ionicons name="flash" size={14} color={Colors.gold} />
              <Text style={styles.homePTText}>{powerTokens} PT</Text>
            </View>
          </View>

          {/* "KNIFE HIT" title */}
          <View style={styles.titleBlock}>
            <Text style={styles.titleKnife}>KNIFE</Text>
            <Text style={styles.titleHit}>HIT</Text>
          </View>

          {/* Stage / Score line */}
          <Text style={styles.stageScoreLine}>
            STAGE {bestStage}{'  ♦  '}SCORE {bestScore}
          </Text>

          {/* Current knife preview */}
          <View style={styles.homeKnifeWrap}>
            <Image
              source={{ uri: equippedSkin.uri }}
              style={styles.homeKnifeImg}
              resizeMode="contain"
            />
          </View>

          {/* SHOP + PLAY buttons */}
          <View style={styles.homeBtnRow}>
            <Pressable style={styles.shopButton} onPress={() => setShopVisible(true)}>
              <Ionicons name="cart" size={20} color="#fff" />
              <Text style={styles.shopBtnText}>SHOP</Text>
            </Pressable>
            <Pressable style={styles.playButton} onPress={startGame}>
              <Text style={styles.playBtnText}>PLAY  ▶</Text>
            </Pressable>
          </View>

          {/* Bottom-right diamond */}
          <Image
            source={{ uri: `${BASE}Home/Untitled-2.png` }}
            style={styles.homeDiamond}
            resizeMode="contain"
          />
        </ImageBackground>

        <KnifeShop
          visible={shopVisible}
          equippedId={equippedSkin.id}
          onClose={() => setShopVisible(false)}
          onEquip={handleEquip}
        />
      </View>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GAME SCREEN
  // ═══════════════════════════════════════════════════════════════════════════
  const BOTTOM_PAD = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <Pressable style={styles.root} onPress={throwKnife}>
      <ImageBackground
        source={{ uri: `${BASE}bg_wood.png` }}
        style={styles.root}
        resizeMode="cover"
      >
        {/* ── Top HUD row ── */}
        <View style={[styles.gameTopRow, { paddingTop: TOP_PAD + 6 }]}>
          <Text style={styles.scoreNum}>{score}</Text>
          {renderStageIndicator()}
          <View style={styles.gamePTBadge}>
            <Ionicons name="flash" size={13} color={Colors.gold} />
            <Text style={styles.gamePTText}>{powerTokens} PT</Text>
          </View>
        </View>

        {/* ── Left knife indicators ── */}
        {phase === 'playing' && renderLeftIndicators()}

        {/* ── Rotating expanded container (BOSS + stuck knives) ── */}
        <Animated.View
          style={{
            position: 'absolute',
            left: SW / 2 - CENTER,
            top: CONT_TOP,
            width: CONT_S,
            height: CONT_S,
            transform: [{
              rotate: bossRotAnim.interpolate({
                inputRange: [0, 360],
                outputRange: ['0deg', '360deg'],
              }),
            }],
          }}
        >
          {/* Target/Boss image — padded by KNIFE_H inside the container */}
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
            <View style={{
              position: 'absolute', left: KNIFE_H, top: KNIFE_H,
              width: BOSS_SIZE, height: BOSS_SIZE,
              borderRadius: BOSS_R, backgroundColor: 'rgba(180,0,0,0.16)',
            }} />
          )}
          {/* Stuck knives — ROTATION FIXED: localAngle - 90 */}
          {stuckKnives.map(renderStuckKnife)}
        </Animated.View>

        {/* ── Flying knife (waiting + in-flight) ── */}
        <Animated.View
          style={{
            position: 'absolute',
            left: SW / 2 - KNIFE_W / 2,
            top: KNIFE_START,
            width: KNIFE_W,
            height: KNIFE_H,
            zIndex: 25,
            transform: [{ translateY: knifeAnim }],
            pointerEvents: 'box-none',
          }}
        >
          <Image
            source={{ uri: equippedSkin.uri }}
            style={{ width: KNIFE_W, height: KNIFE_H }}
            resizeMode="contain"
          />
        </Animated.View>

        {/* ── Clash flash ── */}
        {clashFlash && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View style={styles.clashFlash} />
            <Text style={[styles.clashText, { top: BOSS_CY - 28, left: SW / 2 - 44 }]}>
              CLASH!
            </Text>
          </View>
        )}

        {/* ── Tap hint ── */}
        {!inFlight && knivesLeft > 0 && phase === 'playing' && (
          <Text style={[styles.tapHint, { bottom: BOTTOM_PAD + 16 }]}>TAP TO THROW</Text>
        )}

        {/* ── Boss level badge ── */}
        {isBoss(stage) && (
          <View style={[styles.bossBadge, { top: CONT_TOP - 28 }]}>
            <Text style={styles.bossBadgeText}>⚔ BOSS STAGE</Text>
          </View>
        )}

        {/* ── Bottom-right diamond ── */}
        <Image
          source={{ uri: `${BASE}Home/Untitled-2.png` }}
          style={[styles.gameDiamond, { bottom: BOTTOM_PAD + 10 }]}
          resizeMode="contain"
        />

        {/* ═══ GAME OVER MODAL ═══ */}
        <Modal visible={phase === 'game_over'} transparent animationType="fade">
          <View style={styles.modalBg}>
            <ImageBackground
              source={{ uri: `${BASE}GamePlay%20Screen/gameOveScoreBG.png` }}
              style={styles.goCard}
              resizeMode="stretch"
            >
              <Text style={styles.goTitle}>GAME OVER</Text>
              <Text style={styles.goSub}>Stage {stage}  •  Score {score}</Text>
              <View style={styles.goPTRow}>
                <Ionicons name="flash" size={20} color={Colors.gold} />
                <Text style={styles.goPT}>{earnedPT} PT earned</Text>
              </View>
              <Pressable style={styles.collectBtn} onPress={collectPT}>
                <Text style={styles.collectBtnText}>Collect Tokens</Text>
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={goHome}>
                <Ionicons name="home-outline" size={16} color="rgba(255,255,255,0.5)" />
                <Text style={styles.ghostBtnText}>Home</Text>
              </Pressable>
            </ImageBackground>
          </View>
        </Modal>

        {/* ═══ AWARDING MODAL ═══ */}
        <Modal visible={phase === 'awarding'} transparent animationType="fade">
          <View style={styles.modalBg}>
            <View style={styles.awardCard}>
              <ActivityIndicator size="large" color={Colors.gold} />
              <Text style={styles.awardText}>Saving tokens…</Text>
            </View>
          </View>
        </Modal>

        {/* ═══ REWARD MODAL ═══ */}
        <Modal visible={phase === 'reward'} transparent animationType="fade">
          <View style={styles.modalBg}>
            <View style={styles.rewardCard}>
              <Text style={styles.rewardEmoji}>🎉</Text>
              <Text style={styles.rewardTitle}>Tokens Collected!</Text>
              <View style={styles.goPTRow}>
                <Ionicons name="flash" size={22} color={Colors.gold} />
                <Text style={styles.rewardPT}>+{earnedPT} PT</Text>
              </View>
              <Text style={styles.rewardBal}>{powerTokens} PT total</Text>
              <Pressable style={styles.collectBtn} onPress={startGame}>
                <Text style={styles.collectBtnText}>Play Again</Text>
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={goHome}>
                <Ionicons name="home-outline" size={16} color="rgba(255,255,255,0.5)" />
                <Text style={styles.ghostBtnText}>Home</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <KnifeShop
          visible={shopVisible}
          equippedId={equippedSkin.id}
          onClose={() => setShopVisible(false)}
          onEquip={handleEquip}
        />
      </ImageBackground>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a1f1c' },

  // ── Home ──────────────────────────────────────────────────────────────────
  homeTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  settingIcon: { width: 34, height: 34 },
  homePTBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
  },
  homePTText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.gold },

  titleBlock: {
    alignItems: 'center',
    marginTop: 24,
  },
  titleKnife: {
    fontFamily: 'Inter_700Bold',
    fontSize: 56,
    color: '#4ade80',         // bright green
    letterSpacing: 4,
    lineHeight: 60,
  },
  titleHit: {
    fontFamily: 'Inter_700Bold',
    fontSize: 56,
    color: Colors.gold,       // gold/yellow
    letterSpacing: 4,
    lineHeight: 60,
    marginTop: -8,
  },

  stageScoreLine: {
    fontFamily: 'Inter_700Bold',
    fontSize: 15,
    color: '#fff',
    letterSpacing: 2,
    textAlign: 'center',
    marginTop: 10,
  },

  homeKnifeWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 28,
  },
  homeKnifeImg: {
    width: 60,
    height: 160,
  },

  homeBtnRow: {
    flexDirection: 'row',
    paddingHorizontal: 28,
    gap: 14,
    marginTop: 4,
  },
  shopButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#7c3aed',   // violet/purple
    paddingVertical: 16,
    borderRadius: 14,
  },
  shopBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#fff', letterSpacing: 1 },
  playButton: {
    flex: 1.4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#22c55e',   // green
    paddingVertical: 16,
    borderRadius: 14,
  },
  playBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#fff', letterSpacing: 2 },

  homeDiamond: {
    position: 'absolute',
    bottom: 16,
    right: 20,
    width: 28,
    height: 28,
    opacity: 0.7,
  },

  // ── Game HUD ──────────────────────────────────────────────────────────────
  gameTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 8,
    zIndex: 30,
  },
  scoreNum: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    color: '#fff',
    minWidth: 32,
  },
  gamePTBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  gamePTText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.gold },

  // Stage indicator
  stageWrap: { flex: 1, alignItems: 'center', gap: 3 },
  stageDots: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stageDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  stageDotActive: { backgroundColor: Colors.gold },
  stageKnifeIcon: { width: 18, height: 18, opacity: 0.35 },
  stageKnifeIconActive: { opacity: 1 },
  stageLabel: {
    fontFamily: 'Inter_700Bold', fontSize: 12, color: '#fff', letterSpacing: 2,
  },

  // Boss badge
  bossBadge: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(180,0,0,0.8)',
    paddingHorizontal: 14, paddingVertical: 4,
    borderRadius: 10,
    zIndex: 30,
    left: SW / 2 - 70, width: 140, alignItems: 'center',
  },
  bossBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 11, color: '#fff', letterSpacing: 1 },

  // Clash
  clashFlash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,0,0,0.22)',
  },
  clashText: {
    position: 'absolute',
    fontFamily: 'Inter_700Bold', fontSize: 22,
    color: '#ff4444', letterSpacing: 3,
  },

  // Tap hint
  tapHint: {
    position: 'absolute', alignSelf: 'center',
    fontFamily: 'Inter_500Medium', fontSize: 11,
    color: 'rgba(255,255,255,0.28)', letterSpacing: 3,
  },

  // Diamond bottom-right
  gameDiamond: {
    position: 'absolute', right: 20,
    width: 24, height: 24, opacity: 0.6,
  },

  // ── Modals ────────────────────────────────────────────────────────────────
  modalBg: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.76)',
    alignItems: 'center', justifyContent: 'center',
  },
  goCard: {
    width: SW * 0.82,
    borderRadius: 20,
    overflow: 'hidden',
    paddingHorizontal: 32, paddingVertical: 36,
    alignItems: 'center', gap: 12,
    backgroundColor: '#0d1a17',
  },
  goTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, color: '#ff5555', letterSpacing: 4 },
  goSub:   { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.55)' },
  goPTRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  goPT:    { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.gold },
  collectBtn: {
    backgroundColor: Colors.gold,
    paddingHorizontal: 44, paddingVertical: 14,
    borderRadius: 28, marginTop: 6, width: '100%', alignItems: 'center',
  },
  collectBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 1 },
  ghostBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  ghostBtnText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.45)' },
  awardCard: { backgroundColor: '#0d1a17', borderRadius: 20, padding: 36, alignItems: 'center', gap: 16 },
  awardText: { fontFamily: 'Inter_500Medium', fontSize: 16, color: Colors.text },
  rewardCard: {
    backgroundColor: '#0d1a17', borderRadius: 24,
    paddingHorizontal: 36, paddingVertical: 36,
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(244,196,48,0.25)',
    width: SW * 0.82, gap: 10,
  },
  rewardEmoji: { fontSize: 46 },
  rewardTitle: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.text, letterSpacing: 1 },
  rewardPT:    { fontFamily: 'Inter_700Bold', fontSize: 32, color: Colors.gold },
  rewardBal:   { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
});
