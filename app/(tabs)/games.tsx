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

// ─── Dimensions & game constants ─────────────────────────────────────────────
const { width: SW } = Dimensions.get('window');
const BASE       = `${getApiUrl()}/game/Knife hit Template/`;
const BOSS_SIZE  = Math.min(Math.floor(SW * 0.40), 145);
const BOSS_R     = BOSS_SIZE / 2;
const KNIFE_W    = 16;
const KNIFE_H    = Math.round(BOSS_SIZE * 0.72);
// Expanded container: boss + knife_H padding on every side → knives always fit, no overflow clipping
const CONT_S     = BOSS_SIZE + KNIFE_H * 2;
const CENTER     = CONT_S / 2;          // boss center inside container
const HUD_H      = 56;
const CLASH_DEG  = 16;                  // ±degrees that counts as a clash

const NORMAL_SPEED  = 0.10;             // deg/ms
const BOSS_SPEED    = 0.17;
const NORMAL_KNIVES = 5;
const BOSS_KNIVES   = 8;
const PT_PER_KNIFE  = 2;
const PT_BOSS_BONUS = 10;

const BOSS_IMGS = [
  `${BASE}Bosses/boss-Ground.png`,
  `${BASE}Bosses/boss-Orange.png`,
  `${BASE}Bosses/boss-WaterMelon.png`,
  `${BASE}Bosses/boss-Meat.png`,
  `${BASE}Bosses/boss-lid.png`,
  `${BASE}Bosses/boss-Tire.png`,
];

const STORAGE_BEST = 'knife_hit_best_level';
const STORAGE_SKIN = 'knife_hit_skin';

type Phase = 'home' | 'playing' | 'game_over' | 'awarding' | 'reward';
interface StuckKnife { id: number; localAngle: number }

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens, addPowerTokens } = useWallet();
  const { pbUser } = useAuth();

  // Layout derived values
  const TOP_PAD      = Platform.OS === 'web' ? 67 : insets.top;
  const CONT_TOP     = TOP_PAD + HUD_H + 12;    // container absolute top
  const BOSS_CY      = CONT_TOP + CENTER;        // boss center Y in screen coords
  const KNIFE_START  = BOSS_CY + BOSS_R + KNIFE_H * 0.6 + 40;
  const HIT_Y        = BOSS_CY + BOSS_R - KNIFE_H * 0.08;

  // ── State ─────────────────────────────────────────────────────────────────
  const [phase, setPhase]           = useState<Phase>('home');
  const [level, setLevel]           = useState(1);
  const [knivesLeft, setKnivesLeft] = useState(NORMAL_KNIVES);
  const [totalKnives, setTotalKnives] = useState(NORMAL_KNIVES);
  const [stuckKnives, setStuckKnives] = useState<StuckKnife[]>([]);
  const [inFlight, setInFlight]     = useState(false);
  const [clashFlash, setClashFlash] = useState(false);
  const [earnedPT, setEarnedPT]     = useState(0);
  const [bestLevel, setBestLevel]   = useState(1);
  const [equippedSkin, setEquippedSkin] = useState<SkinDef>(SKINS[0]);
  const [shopVisible, setShopVisible]   = useState(false);
  const [bossImg, setBossImg]       = useState(BOSS_IMGS[0]);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const bossRotAnim  = useRef(new Animated.Value(0)).current;
  const knifeAnim    = useRef(new Animated.Value(0)).current;  // translateY from KNIFE_START
  const bossAngleRef = useRef(0);
  const rafRef       = useRef<number>(0);
  const lastTimeRef  = useRef<number>(0);
  const stuckRef      = useRef<StuckKnife[]>([]);
  const earnedRef     = useRef(0);
  const levelRef      = useRef(1);
  const knivesLeftRef = useRef(NORMAL_KNIVES);

  const isBoss = (lv: number) => lv % 5 === 0;

  // Sounds
  const sndHit   = useRef<Audio.Sound | null>(null);
  const sndClash = useRef<Audio.Sound | null>(null);
  const sndCoin  = useRef<Audio.Sound | null>(null);

  // ── Load persistent prefs ─────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const bl = await AsyncStorage.getItem(STORAGE_BEST);
        if (bl) setBestLevel(parseInt(bl, 10));
        const sk = await AsyncStorage.getItem(STORAGE_SKIN);
        if (sk) { const f = SKINS.find(s => s.id === sk); if (f) setEquippedSkin(f); }
      } catch { /* ignore */ }
    })();
  }, []);

  // ── Load sounds ────────────────────────────────────────────────────────────
  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
    const load = async (uri: string) => {
      try { const { sound } = await Audio.Sound.createAsync({ uri }, { volume: 0.6 }); return sound; }
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

  // ── Boss rotation loop ─────────────────────────────────────────────────────
  const startRotation = useCallback((speed: number) => {
    cancelAnimationFrame(rafRef.current);
    lastTimeRef.current = 0;
    function frame(now: number) {
      if (lastTimeRef.current === 0) lastTimeRef.current = now;
      const dt = Math.min(now - lastTimeRef.current, 50);
      lastTimeRef.current = now;
      const variation = 1 + 0.28 * Math.sin(now * 0.0013);
      bossAngleRef.current += speed * dt * variation;
      bossRotAnim.setValue(bossAngleRef.current);
      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);
  }, [bossRotAnim]);

  const stopRotation = useCallback(() => cancelAnimationFrame(rafRef.current), []);
  useEffect(() => () => { stopRotation(); }, [stopRotation]);

  // ── Start a level ──────────────────────────────────────────────────────────
  const startLevel = useCallback((lv: number) => {
    const boss   = isBoss(lv);
    const knives = boss ? BOSS_KNIVES : NORMAL_KNIVES;
    if (boss) setBossImg(BOSS_IMGS[Math.floor(Math.random() * BOSS_IMGS.length)]);
    stuckRef.current = [];
    setStuckKnives([]);
    knivesLeftRef.current = knives;
    setKnivesLeft(knives);
    setTotalKnives(knives);
    setInFlight(false);
    knifeAnim.setValue(0);
    startRotation(boss ? BOSS_SPEED : NORMAL_SPEED);
  }, [knifeAnim, startRotation]);

  // ── Start game ─────────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    bossAngleRef.current = 0;
    bossRotAnim.setValue(0);
    levelRef.current = 1;
    earnedRef.current = 0;
    setLevel(1);
    setEarnedPT(0);
    setClashFlash(false);
    setPhase('playing');
    startLevel(1);
  }, [bossRotAnim, startLevel]);

  // ── Handle knife landing ───────────────────────────────────────────────────
  const handleKnifeHit = useCallback(() => {
    const localAngle = ((90 - bossAngleRef.current) % 360 + 360) % 360;

    // Clash detection
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

    // Stick
    const knife: StuckKnife = { id: Date.now() + Math.random(), localAngle };
    stuckRef.current = [...stuckRef.current, knife];
    setStuckKnives([...stuckRef.current]);
    sndHit.current?.replayAsync().catch(() => {});
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setInFlight(false);
    knifeAnim.setValue(0);

    knivesLeftRef.current = Math.max(0, knivesLeftRef.current - 1);
    setKnivesLeft(prev => {
      const next = prev - 1;
      if (next <= 0) {
        // Level cleared
        stopRotation();
        const boss   = isBoss(levelRef.current);
        const earned = stuckRef.current.length * PT_PER_KNIFE + (boss ? PT_BOSS_BONUS : 0);
        earnedRef.current += earned;
        setEarnedPT(earnedRef.current);
        sndCoin.current?.replayAsync().catch(() => {});
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setTimeout(() => {
          const nextLv = levelRef.current + 1;
          levelRef.current = nextLv;
          setLevel(nextLv);
          startLevel(nextLv);
        }, 650);
      }
      return next;
    });
  }, [knifeAnim, stopRotation, startLevel]);

  // ── Throw knife ────────────────────────────────────────────────────────────
  const throwKnife = useCallback(() => {
    if (inFlight || phase !== 'playing' || knivesLeftRef.current <= 0) return;
    setInFlight(true);
    Animated.timing(knifeAnim, {
      toValue: -(KNIFE_START - HIT_Y),
      duration: 220,
      useNativeDriver: true,
    }).start(({ finished }) => { if (finished) handleKnifeHit(); });
  }, [inFlight, phase, knifeAnim, KNIFE_START, HIT_Y, handleKnifeHit]);

  // ── Collect PT ─────────────────────────────────────────────────────────────
  const collectPT = useCallback(async () => {
    if (!earnedRef.current) { setPhase('home'); return; }
    setPhase('awarding');
    try {
      await addPowerTokens(earnedRef.current, 'knife_hit');
      sndCoin.current?.replayAsync().catch(() => {});
    } catch { /* ignore */ }
    setPhase('reward');
  }, [addPowerTokens]);

  const goHome = useCallback(() => {
    stopRotation();
    stuckRef.current = [];
    setStuckKnives([]);
    setPhase('home');
  }, [stopRotation]);

  // ── Equip skin ─────────────────────────────────────────────────────────────
  const handleEquip = useCallback((skinId: string) => {
    const found = SKINS.find(s => s.id === skinId);
    if (found) { setEquippedSkin(found); AsyncStorage.setItem(STORAGE_SKIN, skinId).catch(() => {}); }
    setShopVisible(false);
  }, []);

  // ── Render stuck knife (inside expanded container) ─────────────────────────
  function renderStuckKnife(knife: StuckKnife) {
    const rad = (knife.localAngle * Math.PI) / 180;
    const cx  = CENTER + Math.cos(rad) * (BOSS_R + KNIFE_H / 2);
    const cy  = CENTER + Math.sin(rad) * (BOSS_R + KNIFE_H / 2);
    return (
      <View
        key={knife.id}
        style={{
          position: 'absolute',
          left:   cx - KNIFE_W / 2,
          top:    cy - KNIFE_H / 2,
          width:  KNIFE_W,
          height: KNIFE_H,
          transform: [{ rotate: `${knife.localAngle + 90}deg` }],
          zIndex: 12,
        }}
      >
        <Image source={{ uri: equippedSkin.uri }} style={{ width: KNIFE_W, height: KNIFE_H }} resizeMode="contain" />
      </View>
    );
  }

  // ── Left knife indicators ──────────────────────────────────────────────────
  function renderIndicators() {
    const thrown = totalKnives - knivesLeft;
    const SLOT_H = 29; // height (26) + gap (3)
    const indicatorTop = CONT_TOP + CENTER - (totalKnives * SLOT_H) / 2;
    return (
      <View style={[styles.indicators, { top: indicatorTop }]}>
        {Array.from({ length: totalKnives }).map((_, i) => (
          <View key={i} style={[styles.indicatorSlot, i < thrown ? styles.indicatorFired : styles.indicatorIdle]}>
            <Image source={{ uri: equippedSkin.uri }} style={{ width: 9, height: 20 }} resizeMode="contain" />
          </View>
        ))}
      </View>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  HOME SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  if (phase === 'home') {
    return (
      <View style={styles.root}>
        <ImageBackground source={{ uri: `${BASE}bg_wood.png` }} style={styles.root} resizeMode="cover">
          <View style={styles.overlay} />

          <View style={[styles.topBar, { paddingTop: TOP_PAD + 10 }]}>
            <View style={styles.ptBadge}>
              <Ionicons name="flash" size={14} color={Colors.gold} />
              <Text style={styles.ptBadgeText}>{powerTokens} PT</Text>
            </View>
            <Pressable style={styles.shopIconBtn} onPress={() => setShopVisible(true)} hitSlop={10}>
              <Ionicons name="storefront" size={20} color={Colors.gold} />
            </Pressable>
          </View>

          <View style={styles.homeContent}>
            <Text style={styles.gameTitle}>KNIFE HIT</Text>
            <Text style={styles.gameSub}>Tap to throw · Don't clash!</Text>

            {/* Decorative spinning target */}
            <Animated.View style={[styles.homeTarget, {
              transform: [{ rotate: bossRotAnim.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] }) }],
            }]}>
              <Image source={{ uri: `${BASE}Target_Normal.png` }} style={{ width: BOSS_SIZE, height: BOSS_SIZE }} resizeMode="cover" />
            </Animated.View>

            {bestLevel > 1 && (
              <View style={styles.bestBadge}>
                <Ionicons name="trophy" size={13} color={Colors.gold} />
                <Text style={styles.bestText}>Best Level {bestLevel}</Text>
              </View>
            )}

            <Pressable style={styles.playButton} onPress={startGame}>
              <Text style={styles.playButtonText}>▶  PLAY</Text>
            </Pressable>

            <Pressable style={styles.skinRow} onPress={() => setShopVisible(true)}>
              <Image source={{ uri: equippedSkin.uri }} style={styles.skinRowImg} resizeMode="contain" />
              <Text style={styles.skinRowName}>{equippedSkin.name}</Text>
              <Text style={styles.skinRowChange}>Change →</Text>
            </Pressable>
          </View>
        </ImageBackground>

        <KnifeShop visible={shopVisible} equippedId={equippedSkin.id} onClose={() => setShopVisible(false)} onEquip={handleEquip} />
      </View>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  GAME SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  const isBossLevel = isBoss(level);
  const BOTTOM_PAD  = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <Pressable style={styles.root} onPress={throwKnife}>
      <ImageBackground source={{ uri: `${BASE}bg_wood.png` }} style={styles.root} resizeMode="cover">
        <View style={styles.overlay} />

        {/* HUD */}
        <View style={[styles.hud, { paddingTop: TOP_PAD }]}>
          <View>
            <Text style={styles.hudLabel}>LEVEL</Text>
            <Text style={styles.hudLevel}>{level}</Text>
          </View>
          {isBossLevel && <View style={styles.bossBadge}><Text style={styles.bossBadgeText}>⚔ BOSS</Text></View>}
          <View style={styles.hudRight}>
            <Ionicons name="flash" size={13} color={Colors.gold} />
            <Text style={styles.hudPT}>{powerTokens}</Text>
          </View>
        </View>

        {/* Left indicators */}
        {phase === 'playing' && renderIndicators()}

        {/* ── Expanded rotating container ── */}
        <Animated.View
          style={{
            position: 'absolute',
            left: SW / 2 - CENTER,
            top: CONT_TOP,
            width: CONT_S,
            height: CONT_S,
            transform: [{ rotate: bossRotAnim.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] }) }],
          }}
        >
          {/* Target/Boss image — centered inside expanded container with KNIFE_H padding */}
          <Image
            source={{ uri: isBossLevel ? bossImg : `${BASE}Target_Normal.png` }}
            style={{ position: 'absolute', left: KNIFE_H, top: KNIFE_H, width: BOSS_SIZE, height: BOSS_SIZE, borderRadius: BOSS_R }}
            resizeMode="cover"
          />
          {isBossLevel && (
            <View style={{ position: 'absolute', left: KNIFE_H, top: KNIFE_H, width: BOSS_SIZE, height: BOSS_SIZE, borderRadius: BOSS_R, backgroundColor: 'rgba(180,0,0,0.18)' }} />
          )}
          {/* Stuck knives — rendered after boss image so they appear on top */}
          {stuckKnives.map(renderStuckKnife)}
        </Animated.View>

        {/* Flying knife */}
        <Animated.View
          style={{
            position: 'absolute',
            left: SW / 2 - KNIFE_W / 2,
            top: KNIFE_START,
            width: KNIFE_W,
            height: KNIFE_H,
            zIndex: 25,
            transform: [{ translateY: knifeAnim }],
            pointerEvents: 'none',
          }}
        >
          <Image source={{ uri: equippedSkin.uri }} style={{ width: KNIFE_W, height: KNIFE_H }} resizeMode="contain" />
        </Animated.View>

        {/* Clash flash */}
        {clashFlash && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View style={styles.clashFlash} />
            <Text style={[styles.clashLabel, { top: BOSS_CY - 30, left: SW / 2 - 45 }]}>CLASH!</Text>
          </View>
        )}

        {/* Tap hint */}
        {!inFlight && knivesLeft > 0 && phase === 'playing' && (
          <Text style={[styles.tapHint, { bottom: BOTTOM_PAD + 20 }]}>TAP TO THROW</Text>
        )}

        {/* ── Game Over modal ── */}
        <Modal visible={phase === 'game_over'} transparent animationType="fade">
          <View style={styles.modalBg}>
            <View style={styles.goCard}>
              <Text style={styles.goTitle}>GAME OVER</Text>
              <Text style={styles.goSub}>Reached Level {level}</Text>
              <View style={styles.goPTRow}>
                <Ionicons name="flash" size={20} color={Colors.gold} />
                <Text style={styles.goPT}>{earnedPT} PT earned</Text>
              </View>
              <Pressable style={styles.collectBtn} onPress={collectPT}>
                <Text style={styles.collectBtnText}>Collect Tokens</Text>
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={goHome}>
                <Ionicons name="home-outline" size={16} color={Colors.textMuted} />
                <Text style={styles.ghostBtnText}>Home</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* ── Awarding modal ── */}
        <Modal visible={phase === 'awarding'} transparent animationType="fade">
          <View style={styles.modalBg}>
            <View style={styles.awardCard}>
              <ActivityIndicator size="large" color={Colors.gold} />
              <Text style={styles.awardText}>Saving tokens…</Text>
            </View>
          </View>
        </Modal>

        {/* ── Reward modal ── */}
        <Modal visible={phase === 'reward'} transparent animationType="fade">
          <View style={styles.modalBg}>
            <View style={styles.rewardCard}>
              <Text style={styles.rewardEmoji}>🎉</Text>
              <Text style={styles.rewardTitle}>Tokens Collected!</Text>
              <View style={styles.goPTRow}>
                <Ionicons name="flash" size={22} color={Colors.gold} />
                <Text style={styles.rewardPT}>+{earnedPT} PT</Text>
              </View>
              <Text style={styles.rewardBalance}>{powerTokens} PT total</Text>
              <Pressable style={styles.collectBtn} onPress={startGame}>
                <Text style={styles.collectBtnText}>Play Again</Text>
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={goHome}>
                <Ionicons name="home-outline" size={16} color={Colors.textMuted} />
                <Text style={styles.ghostBtnText}>Home</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <KnifeShop visible={shopVisible} equippedId={equippedSkin.id} onClose={() => setShopVisible(false)} onEquip={handleEquip} />
      </ImageBackground>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d0500' },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.52)' },

  // ── Home ──────────────────────────────────────────────────────────────────
  topBar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    zIndex: 20,
  },
  ptBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)',
  },
  ptBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.gold },
  shopIconBtn: {
    backgroundColor: 'rgba(0,0,0,0.55)', padding: 10, borderRadius: 20,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)',
  },
  homeContent: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24,
  },
  gameTitle: {
    fontFamily: 'Inter_700Bold', fontSize: 44, color: Colors.gold,
    letterSpacing: 6,
  },
  gameSub: {
    fontFamily: 'Inter_400Regular', fontSize: 13, color: 'rgba(255,255,255,0.5)',
    letterSpacing: 1.5, marginTop: 4,
  },
  homeTarget: {
    width: BOSS_SIZE, height: BOSS_SIZE, borderRadius: BOSS_R,
    overflow: 'hidden', marginVertical: 26,
  },
  bestBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8,
  },
  bestText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  playButton: {
    backgroundColor: Colors.gold, paddingHorizontal: 56, paddingVertical: 16, borderRadius: 36,
    elevation: 8,
    ...(Platform.OS !== 'web'
      ? { shadowColor: Colors.gold, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12 }
      : { boxShadow: `0px 4px 12px ${Colors.gold}80` } as any),
  },
  playButtonText: { fontFamily: 'Inter_700Bold', fontSize: 18, color: '#000', letterSpacing: 3 },
  skinRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 24,
    backgroundColor: 'rgba(255,255,255,0.07)',
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  skinRowImg: { width: 16, height: 38 },
  skinRowName: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text, flex: 1 },
  skinRowChange: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.gold },

  // ── HUD ───────────────────────────────────────────────────────────────────
  hud: {
    flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 20, paddingBottom: 8,
    height: HUD_H + (Platform.OS === 'web' ? 67 : 0), zIndex: 30,
  },
  hudLabel: { fontFamily: 'Inter_500Medium', fontSize: 10, color: 'rgba(255,255,255,0.45)', letterSpacing: 2 },
  hudLevel: { fontFamily: 'Inter_700Bold', fontSize: 28, color: '#fff' },
  hudRight: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  hudPT:    { fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.gold },
  bossBadge: {
    flex: 1, alignItems: 'center',
    backgroundColor: 'rgba(180,0,0,0.75)', paddingHorizontal: 12, paddingVertical: 4,
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,60,60,0.5)', alignSelf: 'flex-end', marginBottom: 4,
  },
  bossBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 11, color: '#fff', letterSpacing: 1 },

  // ── Indicators ────────────────────────────────────────────────────────────
  indicators: {
    position: 'absolute', left: 14, zIndex: 30, alignItems: 'center', gap: 3,
  },
  indicatorSlot: { width: 18, height: 26, alignItems: 'center', justifyContent: 'center' },
  indicatorIdle: { opacity: 0.25 },
  indicatorFired: { opacity: 1 },

  // ── Clash ─────────────────────────────────────────────────────────────────
  clashFlash: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,0,0,0.28)' },
  clashLabel: {
    position: 'absolute', fontFamily: 'Inter_700Bold', fontSize: 24,
    color: '#ff4444', letterSpacing: 3,
  },

  // ── Tap hint ──────────────────────────────────────────────────────────────
  tapHint: {
    position: 'absolute', alignSelf: 'center',
    fontFamily: 'Inter_500Medium', fontSize: 11, color: 'rgba(255,255,255,0.3)', letterSpacing: 3,
  },

  // ── Modals ────────────────────────────────────────────────────────────────
  modalBg: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', alignItems: 'center', justifyContent: 'center',
  },
  goCard: {
    backgroundColor: '#120800', borderRadius: 24, paddingHorizontal: 36, paddingVertical: 36,
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    width: SW * 0.82, gap: 12,
  },
  goTitle: { fontFamily: 'Inter_700Bold', fontSize: 30, color: '#ff5555', letterSpacing: 4 },
  goSub:   { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.55)' },
  goPTRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  goPT:    { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.gold },
  collectBtn: {
    backgroundColor: Colors.gold, paddingHorizontal: 44, paddingVertical: 14,
    borderRadius: 28, marginTop: 8, width: '100%', alignItems: 'center',
  },
  collectBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 1 },
  ghostBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  ghostBtnText: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },

  awardCard: { backgroundColor: '#120800', borderRadius: 20, padding: 36, alignItems: 'center', gap: 16 },
  awardText: { fontFamily: 'Inter_500Medium', fontSize: 16, color: Colors.text },

  rewardCard: {
    backgroundColor: '#120800', borderRadius: 24, paddingHorizontal: 36, paddingVertical: 36,
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(244,196,48,0.25)',
    width: SW * 0.82, gap: 10,
  },
  rewardEmoji:   { fontSize: 46 },
  rewardTitle:   { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.text, letterSpacing: 1 },
  rewardPT:      { fontFamily: 'Inter_700Bold', fontSize: 32, color: Colors.gold },
  rewardBalance: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
});
