import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Dimensions, Animated, Easing, Pressable,
  Image, ImageBackground, Platform, Modal, ActivityIndicator, Switch,
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

// ─── Asset base — server /game route → public/game/Knife hit Template/ ────────
const BASE = `${getApiUrl()}/game/`;
const { width: SW } = Dimensions.get('window');

// ─── Responsive layout (CONT_S ≤ SW — no clipping on Android) ────────────────
const BOSS_SIZE   = Math.min(Math.floor(SW * 0.50), 190);
const BOSS_R      = BOSS_SIZE / 2;
const KNIFE_W     = 24;
const KNIFE_H     = Math.floor((SW - BOSS_SIZE) / 2) - 4;
const CONT_S      = BOSS_SIZE + KNIFE_H * 2;          // ≤ SW
const CENTER      = CONT_S / 2;
// 50% of blade (blade ≈ 60% of knife) digs into wood = 30% of KNIFE_H
const PENETRATION = Math.round(KNIFE_H * 0.30);
// Radial distance from container center to knife image center
const RADIAL_DIST = BOSS_R + KNIFE_H / 2 - PENETRATION;

// ─── Game constants ───────────────────────────────────────────────────────────
const HUD_H          = 58;
const CHAPTER_SIZE   = 5;
const KNIVES_NORMAL  = 7;
const KNIVES_BOSS    = 10;
const THROW_DURATION = 190;    // ms — knife travels fast for snappy feel
const CLASH_DEG      = 14;
const PT_PER_KNIFE   = 2;
const PT_BOSS_BONUS  = 12;
// ms for one full rotation
const ROT_NORMAL_MS  = 3600;
const ROT_BOSS_MS    = 1800;

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
const KEY_SOUND = 'knife_hit_sound';

type Phase = 'home' | 'playing' | 'game_over' | 'awarding' | 'reward';
interface StuckKnife { id: number; localAngle: number }

// ─── Main Component ───────────────────────────────────────────────────────────
export default function GamesScreen() {
  const insets     = useSafeAreaInsets();
  const { powerTokens, addPowerTokens } = useWallet();
  const { pbUser } = useAuth();

  const TOP_PAD     = Platform.OS === 'web' ? 67 : insets.top;
  const CONT_TOP    = TOP_PAD + HUD_H + 6;
  const BOSS_CY     = CONT_TOP + CENTER;
  // Flying knife starts below the boss; tip stops PENETRATION into the boss
  const KNIFE_START = BOSS_CY + BOSS_R + KNIFE_H * 0.6 + 20;
  const HIT_Y       = BOSS_CY + BOSS_R - PENETRATION;

  // ── Animated values ───────────────────────────────────────────────────────
  const bossRotAnim = useRef(new Animated.Value(0)).current;  // 0..1 (native)
  const knifeAnim   = useRef(new Animated.Value(0)).current;  // JS driver, y-offset

  // ── Refs ──────────────────────────────────────────────────────────────────
  const rotLoopRef   = useRef<Animated.CompositeAnimation | null>(null);
  const bossAngleRef = useRef(0);   // degrees, updated by addListener
  const stuckRef     = useRef<StuckKnife[]>([]);
  const earnedRef    = useRef(0);
  const stageRef     = useRef(1);
  const scoreRef     = useRef(0);
  const knivesRef    = useRef(KNIVES_NORMAL);
  const inFlightRef  = useRef(false);
  const sndHit       = useRef<Audio.Sound | null>(null);
  const sndClash     = useRef<Audio.Sound | null>(null);
  const sndCoin      = useRef<Audio.Sound | null>(null);

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
  const [bossImgUri, setBossImgUri]   = useState(BOSS_IMGS[0]);
  const [shopVisible, setShopVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const isBoss          = (s: number) => s % CHAPTER_SIZE === 0;
  const stageInChapter  = (s: number) => ((s - 1) % CHAPTER_SIZE) + 1;

  // ── Persist boss angle via listener (native driver → JS-readable) ─────────
  useEffect(() => {
    const id = bossRotAnim.addListener(({ value }) => {
      bossAngleRef.current = value * 360;
    });
    return () => bossRotAnim.removeListener(id);
  }, [bossRotAnim]);

  // ── Load persisted prefs ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [sk, bs, sc, sn] = await Promise.all([
          AsyncStorage.getItem(KEY_SKIN),
          AsyncStorage.getItem(KEY_STAGE),
          AsyncStorage.getItem(KEY_SCORE),
          AsyncStorage.getItem(KEY_SOUND),
        ]);
        if (sk) { const f = SKINS.find(s => s.id === sk); if (f) setEquippedSkin(f); }
        if (bs) setBestStage(parseInt(bs, 10));
        if (sc) setBestScore(parseInt(sc, 10));
        if (sn !== null) setSoundEnabled(sn === '1');
      } catch { /* ignore */ }
    })();
  }, []);

  // ── Sound loading ─────────────────────────────────────────────────────────
  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
    const load = async (uri: string) => {
      try {
        const { sound } = await Audio.Sound.createAsync({ uri }, { volume: 0.7 });
        return sound;
      } catch { return null; }
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

  const playSound = useCallback(async (s: Audio.Sound | null) => {
    if (!soundEnabled || !s) return;
    try { await s.replayAsync(); } catch { /* ignore */ }
  }, [soundEnabled]);

  // ── Boss rotation — native driver for silky 60 FPS ────────────────────────
  const startRotation = useCallback((boss: boolean) => {
    rotLoopRef.current?.stop();
    bossRotAnim.setValue(0);
    bossAngleRef.current = 0;
    rotLoopRef.current = Animated.loop(
      Animated.timing(bossRotAnim, {
        toValue: 1,
        duration: boss ? ROT_BOSS_MS : ROT_NORMAL_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    rotLoopRef.current.start();
  }, [bossRotAnim]);

  const stopRotation = useCallback(() => {
    rotLoopRef.current?.stop();
  }, []);

  useEffect(() => () => { rotLoopRef.current?.stop(); }, []);

  // ── Start a stage ─────────────────────────────────────────────────────────
  const startStage = useCallback((s: number) => {
    const boss   = isBoss(s);
    const knives = boss ? KNIVES_BOSS : KNIVES_NORMAL;
    if (boss) setBossImgUri(BOSS_IMGS[Math.floor(Math.random() * BOSS_IMGS.length)]);
    stuckRef.current = [];
    setStuckKnives([]);
    knivesRef.current = knives;
    inFlightRef.current = false;
    setKnivesLeft(knives);
    setTotalKnives(knives);
    setInFlight(false);
    knifeAnim.setValue(0);
    startRotation(boss);
  }, [knifeAnim, startRotation]);

  // ── Start game ────────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    stageRef.current  = 1;
    scoreRef.current  = 0;
    earnedRef.current = 0;
    setStage(1);
    setScore(0);
    setEarnedPT(0);
    setClashFlash(false);
    setPhase('playing');
    startStage(1);
  }, [startStage]);

  // ── Handle knife landing ──────────────────────────────────────────────────
  const handleKnifeHit = useCallback(() => {
    // Compute local angle: where knife sticks ON the boss (0=right, 90=bottom…)
    const localAngle = ((90 - bossAngleRef.current) % 360 + 360) % 360;

    // Clash detection
    const clashed = stuckRef.current.some(k => {
      let diff = Math.abs(k.localAngle - localAngle) % 360;
      if (diff > 180) diff = 360 - diff;
      return diff < CLASH_DEG;
    });

    if (clashed) {
      setClashFlash(true);
      playSound(sndClash.current);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      stopRotation();
      setTimeout(() => { setClashFlash(false); setPhase('game_over'); }, 450);
      return;
    }

    // Stick knife
    const knife: StuckKnife = { id: Date.now() + Math.random(), localAngle };
    stuckRef.current = [...stuckRef.current, knife];
    setStuckKnives([...stuckRef.current]);
    playSound(sndHit.current);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    scoreRef.current += 1;
    setScore(scoreRef.current);

    inFlightRef.current = false;
    setInFlight(false);
    knifeAnim.setValue(0);

    knivesRef.current = Math.max(0, knivesRef.current - 1);
    const remaining = knivesRef.current;
    setKnivesLeft(remaining);

    if (remaining <= 0) {
      // Stage cleared
      stopRotation();
      const boss = isBoss(stageRef.current);
      const pts  = stuckRef.current.length * PT_PER_KNIFE + (boss ? PT_BOSS_BONUS : 0);
      earnedRef.current += pts;
      setEarnedPT(earnedRef.current);
      playSound(sndCoin.current);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => {
        const next = stageRef.current + 1;
        stageRef.current = next;
        setStage(next);
        startStage(next);
      }, 650);
    }
  }, [knifeAnim, stopRotation, startStage, playSound]);

  // ── Throw knife — instant on tap ─────────────────────────────────────────
  const throwKnife = useCallback(() => {
    if (inFlightRef.current || phase !== 'playing' || knivesRef.current <= 0) return;
    inFlightRef.current = true;
    setInFlight(true);
    Animated.timing(knifeAnim, {
      toValue: -(KNIFE_START - HIT_Y),
      duration: THROW_DURATION,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start(({ finished }) => { if (finished) handleKnifeHit(); });
  }, [phase, knifeAnim, KNIFE_START, HIT_Y, handleKnifeHit]);

  // ── Collect PT ────────────────────────────────────────────────────────────
  const collectPT = useCallback(async () => {
    if (!earnedRef.current) { setPhase('home'); return; }
    setPhase('awarding');
    try {
      await addPowerTokens(earnedRef.current, 'knife_hit');
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
  }, [addPowerTokens, bestStage, bestScore]);

  const goHome = useCallback(() => {
    stopRotation();
    stuckRef.current = [];
    setStuckKnives([]);
    setPhase('home');
  }, [stopRotation]);

  const handleEquip = useCallback((skinId: string) => {
    const found = SKINS.find(s => s.id === skinId);
    if (found) {
      setEquippedSkin(found);
      AsyncStorage.setItem(KEY_SKIN, skinId).catch(() => {});
    }
    setShopVisible(false);
  }, []);

  const toggleSound = useCallback((val: boolean) => {
    setSoundEnabled(val);
    AsyncStorage.setItem(KEY_SOUND, val ? '1' : '0').catch(() => {});
  }, []);

  // ── Render stuck knife (handles outward, tip inside boss) ─────────────────
  function renderStuckKnife(knife: StuckKnife) {
    const rad = (knife.localAngle * Math.PI) / 180;
    // Center of knife image in container coords
    const cx  = CENTER + Math.cos(rad) * RADIAL_DIST;
    const cy  = CENTER + Math.sin(rad) * RADIAL_DIST;
    // rotation = localAngle - 90 → tip toward boss center (handle outward)
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

  // ── Left-side remaining knife indicators ──────────────────────────────────
  function renderLeftIndicators() {
    const SLOT  = 26;
    const top   = BOSS_CY - (totalKnives * SLOT) / 2;
    const thrown = totalKnives - knivesLeft;
    return (
      <View
        style={{
          position: 'absolute', left: 10, top,
          alignItems: 'center', gap: 2, zIndex: 30,
          pointerEvents: 'none',
        }}
      >
        {Array.from({ length: totalKnives }).map((_, i) => (
          <View key={i} style={{ width: 14, height: 22, opacity: i < thrown ? 0.22 : 0.85 }}>
            <Image
              source={{ uri: equippedSkin.uri }}
              style={{ width: 14, height: 22 }}
              resizeMode="contain"
            />
          </View>
        ))}
      </View>
    );
  }

  // ── Stage dots ────────────────────────────────────────────────────────────
  function renderStageIndicator() {
    const pos = stageInChapter(stage);
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
  //  SETTINGS MODAL
  // ═══════════════════════════════════════════════════════════════════════════
  const SettingsModal = (
    <Modal visible={settingsVisible} transparent animationType="fade">
      <Pressable style={styles.modalBg} onPress={() => setSettingsVisible(false)}>
        <View style={styles.settingsCard} onStartShouldSetResponder={() => true}>
          <Text style={styles.settingsTitle}>Settings</Text>

          <View style={styles.settingsRow}>
            <Ionicons
              name={soundEnabled ? 'volume-high' : 'volume-mute'}
              size={22}
              color={soundEnabled ? Colors.gold : Colors.textMuted}
            />
            <Text style={styles.settingsLabel}>Sound Effects</Text>
            <Switch
              value={soundEnabled}
              onValueChange={toggleSound}
              trackColor={{ false: '#333', true: Colors.gold }}
              thumbColor="#fff"
            />
          </View>

          <Pressable style={styles.settingsCloseBtn} onPress={() => setSettingsVisible(false)}>
            <Text style={styles.settingsCloseTxt}>Done</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  //  HOME SCREEN
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
            <Pressable onPress={() => setSettingsVisible(true)} hitSlop={12}>
              <Image
                source={{ uri: `${BASE}Home/HomeIcon_Setting.png` }}
                style={styles.settingIcon}
                resizeMode="contain"
              />
            </Pressable>
            <View style={styles.ptBadge}>
              <Ionicons name="flash" size={14} color={Colors.gold} />
              <Text style={styles.ptText}>{powerTokens} PT</Text>
            </View>
          </View>

          {/* Title */}
          <View style={styles.titleBlock}>
            <Text style={styles.titleKnife}>KNIFE</Text>
            <Text style={styles.titleHit}>HIT</Text>
          </View>

          {/* Stage / Score */}
          <Text style={styles.stageLine}>
            STAGE {bestStage}{'  ♦  '}SCORE {bestScore}
          </Text>

          {/* Knife preview */}
          <View style={styles.homeKnifeWrap}>
            <Image
              source={{ uri: equippedSkin.uri }}
              style={styles.homeKnifeImg}
              resizeMode="contain"
            />
          </View>

          {/* Buttons */}
          <View style={styles.homeBtnRow}>
            <Pressable style={styles.shopButton} onPress={() => setShopVisible(true)}>
              <Ionicons name="cart" size={20} color="#fff" />
              <Text style={styles.shopBtnText}>SHOP</Text>
            </Pressable>
            <Pressable style={styles.playButton} onPress={startGame}>
              <Text style={styles.playBtnText}>PLAY  ▶</Text>
            </Pressable>
          </View>

          {/* Diamond */}
          <Image
            source={{ uri: `${BASE}Home/Untitled-2.png` }}
            style={styles.homeDiamond}
            resizeMode="contain"
          />
        </ImageBackground>

        {SettingsModal}
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
        {/* ── Top HUD ── */}
        <View style={[styles.gameTopRow, { paddingTop: TOP_PAD + 6 }]}>
          <Text style={styles.scoreNum}>{score}</Text>
          {renderStageIndicator()}
          <View style={styles.ptBadge}>
            <Ionicons name="flash" size={13} color={Colors.gold} />
            <Text style={styles.ptText}>{powerTokens} PT</Text>
          </View>
        </View>

        {/* ── Left knife indicators ── */}
        {phase === 'playing' && renderLeftIndicators()}

        {/* ── Boss container (native-driven rotation) ── */}
        <Animated.View
          style={{
            position: 'absolute',
            left: SW / 2 - CENTER,
            top: CONT_TOP,
            width: CONT_S,
            height: CONT_S,
            transform: [{
              rotate: bossRotAnim.interpolate({
                inputRange: [0, 1],
                outputRange: ['0deg', '360deg'],
              }),
            }],
          }}
        >
          {/* Boss / target image — padded by KNIFE_H inside container */}
          <Image
            source={{ uri: isBoss(stage) ? bossImgUri : `${BASE}Target_Normal.png` }}
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
              width: BOSS_SIZE, height: BOSS_SIZE, borderRadius: BOSS_R,
              backgroundColor: 'rgba(200,0,0,0.15)',
            }} />
          )}
          {/* Stuck knives — 50% blade embedded, handle outward */}
          {stuckKnives.map(renderStuckKnife)}
        </Animated.View>

        {/* ── Flying knife (JS driver — throws fast, 190ms) ── */}
        <Animated.View
          style={{
            position: 'absolute',
            left: SW / 2 - KNIFE_W / 2,
            top: KNIFE_START,
            width: KNIFE_W,
            height: KNIFE_H,
            zIndex: 25,
            pointerEvents: 'none',
            transform: [{ translateY: knifeAnim }],
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
            <View style={styles.clashOverlay} />
            <Text style={[styles.clashText, { top: BOSS_CY - 30, left: SW / 2 - 44 }]}>
              CLASH!
            </Text>
          </View>
        )}

        {/* ── Boss badge ── */}
        {isBoss(stage) && (
          <View style={[styles.bossBadge, { top: CONT_TOP - 28, left: SW / 2 - 70 }]}>
            <Text style={styles.bossBadgeText}>⚔  BOSS STAGE</Text>
          </View>
        )}

        {/* ── Tap hint ── */}
        {!inFlight && knivesLeft > 0 && phase === 'playing' && (
          <Text style={[styles.tapHint, { bottom: BOTTOM_PAD + 14 }]}>TAP TO THROW</Text>
        )}

        {/* ── Bottom diamond ── */}
        <Image
          source={{ uri: `${BASE}Home/Untitled-2.png` }}
          style={[styles.gameDiamond, { bottom: BOTTOM_PAD + 10 }]}
          resizeMode="contain"
        />

        {/* ── Settings icon in game (top-left, behind score) ── */}
        <Pressable
          style={[styles.gameSettingsBtn, { top: TOP_PAD + 2 }]}
          onPress={() => setSettingsVisible(true)}
          hitSlop={12}
        >
          <Ionicons name="settings-outline" size={20} color="rgba(255,255,255,0.45)" />
        </Pressable>

        {/* ══ GAME OVER ══ */}
        <Modal visible={phase === 'game_over'} transparent animationType="fade">
          <View style={styles.modalBg}>
            <View style={styles.goCard}>
              <Text style={styles.goTitle}>GAME OVER</Text>
              <Text style={styles.goSub}>Stage {stage}  •  Score {score}</Text>
              <View style={styles.earnRow}>
                <Ionicons name="flash" size={20} color={Colors.gold} />
                <Text style={styles.earnText}>{earnedPT} PT earned</Text>
              </View>
              <Pressable style={styles.collectBtn} onPress={collectPT}>
                <Text style={styles.collectBtnText}>Collect Tokens</Text>
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={goHome}>
                <Ionicons name="home-outline" size={16} color="rgba(255,255,255,0.4)" />
                <Text style={styles.ghostBtnText}>Home</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* ══ AWARDING ══ */}
        <Modal visible={phase === 'awarding'} transparent animationType="fade">
          <View style={styles.modalBg}>
            <View style={styles.awardCard}>
              <ActivityIndicator size="large" color={Colors.gold} />
              <Text style={styles.awardText}>Saving tokens…</Text>
            </View>
          </View>
        </Modal>

        {/* ══ REWARD ══ */}
        <Modal visible={phase === 'reward'} transparent animationType="fade">
          <View style={styles.modalBg}>
            <View style={styles.rewardCard}>
              <Text style={styles.rewardEmoji}>🎉</Text>
              <Text style={styles.rewardTitle}>Tokens Collected!</Text>
              <View style={styles.earnRow}>
                <Ionicons name="flash" size={22} color={Colors.gold} />
                <Text style={styles.rewardPT}>+{earnedPT} PT</Text>
              </View>
              <Text style={styles.rewardBal}>{powerTokens} PT total</Text>
              <Pressable style={styles.collectBtn} onPress={startGame}>
                <Text style={styles.collectBtnText}>Play Again</Text>
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={goHome}>
                <Ionicons name="home-outline" size={16} color="rgba(255,255,255,0.4)" />
                <Text style={styles.ghostBtnText}>Home</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {SettingsModal}
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
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingHorizontal: 18,
  },
  settingIcon: { width: 34, height: 34 },
  ptBadge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  ptText:  { fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.gold },

  titleBlock:  { alignItems: 'center', marginTop: 22 },
  titleKnife:  { fontFamily: 'Inter_700Bold', fontSize: 54, color: '#4ade80', letterSpacing: 4, lineHeight: 58 },
  titleHit:    { fontFamily: 'Inter_700Bold', fontSize: 54, color: Colors.gold, letterSpacing: 4, lineHeight: 58, marginTop: -6 },
  stageLine:   { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#fff', letterSpacing: 2, textAlign: 'center', marginTop: 10 },

  homeKnifeWrap: { alignItems: 'center', justifyContent: 'center', flex: 1, marginVertical: 8 },
  homeKnifeImg:  { width: 60, height: 170 },

  homeBtnRow: { flexDirection: 'row', paddingHorizontal: 26, gap: 14, marginBottom: 28 },
  shopButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: '#7c3aed', paddingVertical: 16, borderRadius: 14,
  },
  shopBtnText: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#fff', letterSpacing: 1 },
  playButton:  {
    flex: 1.4, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#22c55e', paddingVertical: 16, borderRadius: 14,
  },
  playBtnText: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#fff', letterSpacing: 2 },
  homeDiamond: { position: 'absolute', bottom: 16, right: 20, width: 28, height: 28, opacity: 0.7 },

  // ── Game HUD ──────────────────────────────────────────────────────────────
  gameTopRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, gap: 8, zIndex: 30,
  },
  scoreNum: { fontFamily: 'Inter_700Bold', fontSize: 26, color: '#fff', minWidth: 34 },

  stageWrap:          { flex: 1, alignItems: 'center', gap: 3 },
  stageDots:          { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stageDot:           { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.22)' },
  stageDotActive:     { backgroundColor: Colors.gold },
  stageKnifeIcon:     { width: 18, height: 18, opacity: 0.3 },
  stageKnifeIconActive: { opacity: 1 },
  stageLabel:         { fontFamily: 'Inter_700Bold', fontSize: 11, color: '#fff', letterSpacing: 2 },

  bossBadge: {
    position: 'absolute', width: 140, alignItems: 'center',
    backgroundColor: 'rgba(180,0,0,0.82)', paddingHorizontal: 14, paddingVertical: 4,
    borderRadius: 10, zIndex: 30,
  },
  bossBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 11, color: '#fff', letterSpacing: 1 },

  clashOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,0,0,0.2)' },
  clashText:    { position: 'absolute', fontFamily: 'Inter_700Bold', fontSize: 22, color: '#ff4444', letterSpacing: 3 },
  tapHint:      { position: 'absolute', alignSelf: 'center', fontFamily: 'Inter_500Medium', fontSize: 10, color: 'rgba(255,255,255,0.28)', letterSpacing: 3 },
  gameDiamond:  { position: 'absolute', right: 20, width: 22, height: 22, opacity: 0.55 },

  gameSettingsBtn: { position: 'absolute', right: 60, zIndex: 40 },

  // ── Settings modal ────────────────────────────────────────────────────────
  settingsCard: {
    backgroundColor: '#0e1e1b', borderRadius: 20, padding: 28, width: SW * 0.82,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.18)', gap: 20,
  },
  settingsTitle: { fontFamily: 'Inter_700Bold', fontSize: 20, color: Colors.text, textAlign: 'center' },
  settingsRow:   { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingsLabel: { fontFamily: 'Inter_500Medium', fontSize: 15, color: Colors.text, flex: 1 },
  settingsCloseBtn: {
    backgroundColor: Colors.gold, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
  },
  settingsCloseTxt: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#000' },

  // ── Modals ────────────────────────────────────────────────────────────────
  modalBg:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.76)', alignItems: 'center', justifyContent: 'center' },
  goCard:    { backgroundColor: '#0d1a17', borderRadius: 22, paddingHorizontal: 32, paddingVertical: 32, alignItems: 'center', gap: 12, width: SW * 0.82, borderWidth: 1, borderColor: 'rgba(255,80,80,0.2)' },
  goTitle:   { fontFamily: 'Inter_700Bold', fontSize: 28, color: '#ff5555', letterSpacing: 4 },
  goSub:     { fontFamily: 'Inter_500Medium', fontSize: 13, color: 'rgba(255,255,255,0.5)' },
  earnRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  earnText:  { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.gold },
  collectBtn:  { backgroundColor: Colors.gold, paddingHorizontal: 44, paddingVertical: 14, borderRadius: 28, width: '100%', alignItems: 'center' },
  collectBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 1 },
  ghostBtn:    { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  ghostBtnText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.4)' },
  awardCard:   { backgroundColor: '#0d1a17', borderRadius: 20, padding: 36, alignItems: 'center', gap: 16 },
  awardText:   { fontFamily: 'Inter_500Medium', fontSize: 16, color: Colors.text },
  rewardCard:  { backgroundColor: '#0d1a17', borderRadius: 24, paddingHorizontal: 36, paddingVertical: 36, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(244,196,48,0.25)', width: SW * 0.82, gap: 10 },
  rewardEmoji: { fontSize: 46 },
  rewardTitle: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.text, letterSpacing: 1 },
  rewardPT:    { fontFamily: 'Inter_700Bold', fontSize: 32, color: Colors.gold },
  rewardBal:   { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
});
