import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, Dimensions, Alert,
  PanResponder, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming,
  Easing, withSpring, FadeInDown, FadeIn,
  withSequence, cancelAnimation,
} from 'react-native-reanimated';
import { useWallet } from '@/context/WalletContext';
import { adService } from '@/lib/AdService';
import Colors from '@/constants/colors';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const GAME_AREA_HEIGHT = 320;
const LOG_RADIUS = 72;
const KNIFE_LENGTH = 54;
const KNIFE_WIDTH = 7;
const WIN_KNIVES = 8;
const PT_REWARD = 3;
const MIN_ANGLE_DIFF = 21;

const KNIFE_COLORS = ['#C0C0C0', '#D4AF37', '#B87333', '#8B9DC3', '#E8E8E8'];
const BOSS_COLORS = [
  ['#6B4C2A', '#3D2A15', '#6B4C2A'],
  ['#1a3a1a', '#0d2a0d', '#1a3a1a'],
  ['#3a1a1a', '#2a0d0d', '#3a1a1a'],
  ['#1a1a3a', '#0d0d2a', '#1a1a3a'],
];

interface Knife {
  id: string;
  angleDeg: number;
  color: string;
}

type GameState = 'menu' | 'playing' | 'won' | 'lost';

function degreesToRad(d: number) { return (d * Math.PI) / 180; }

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { addPowerTokens } = useWallet();
  const [gameState, setGameState] = useState<GameState>('menu');
  const [knivesOnLog, setKnivesOnLog] = useState<Knife[]>([]);
  const [knifeReady, setKnifeReady] = useState(true);
  const [level, setLevel] = useState(1);
  const [ptEarned, setPtEarned] = useState(0);
  const [knifeColor] = useState(() => pickRandom(KNIFE_COLORS));
  const [bossColors] = useState(() => pickRandom(BOSS_COLORS));
  const [showDoubleOffer, setShowDoubleOffer] = useState(false);
  const [isLoadingAd, setIsLoadingAd] = useState(false);

  const rotationDeg = useSharedValue(0);
  const knifeY = useSharedValue(160);
  const knifeOpacity = useSharedValue(1);
  const resultScale = useSharedValue(0);
  const shakeX = useSharedValue(0);
  const shakeY = useSharedValue(0);

  const isAnimating = useRef(false);
  const knivesRef = useRef<Knife[]>([]);
  const rotationRef = useRef(0);

  const speed = 1.5 + level * 0.35;
  const rotationDuration = Math.max(1200, 3000 / speed);

  const directions = useRef([1, -1]);
  const currentDirection = useRef(0);

  useEffect(() => {
    if (gameState === 'playing') {
      const dir = directions.current[currentDirection.current % 2];
      rotationDeg.value = withRepeat(
        withTiming(rotationDeg.value + 360 * dir, {
          duration: rotationDuration,
          easing: Easing.linear,
        }),
        -1, false
      );
    } else {
      cancelAnimation(rotationDeg);
    }
  }, [gameState, speed]);

  const logStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotationDeg.value}deg` }],
  }));

  const knifeStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: knifeY.value - 160 }],
    opacity: knifeOpacity.value,
  }));

  const resultStyle = useAnimatedStyle(() => ({
    transform: [{ scale: resultScale.value }],
  }));

  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.value }, { translateY: shakeY.value }],
  }));

  function triggerScreenShake(intensity = 6) {
    const dur = 40;
    shakeX.value = withSequence(
      withTiming(intensity, { duration: dur }),
      withTiming(-intensity, { duration: dur }),
      withTiming(intensity * 0.7, { duration: dur }),
      withTiming(-intensity * 0.7, { duration: dur }),
      withTiming(intensity * 0.4, { duration: dur }),
      withTiming(0, { duration: dur }),
    );
    shakeY.value = withSequence(
      withTiming(-intensity * 0.5, { duration: dur }),
      withTiming(intensity * 0.5, { duration: dur }),
      withTiming(-intensity * 0.3, { duration: dur }),
      withTiming(intensity * 0.3, { duration: dur }),
      withTiming(0, { duration: dur * 2 }),
    );
  }

  function startGame() {
    knivesRef.current = [];
    setKnivesOnLog([]);
    setKnifeReady(true);
    setGameState('playing');
    setPtEarned(0);
    setShowDoubleOffer(false);
    knifeY.value = 160;
    knifeOpacity.value = 1;
    resultScale.value = 0;
    currentDirection.current += 1;
  }

  const throwKnife = useCallback(() => {
    if (!knifeReady || gameState !== 'playing' || isAnimating.current) return;
    isAnimating.current = true;
    setKnifeReady(false);

    const currentAngle = rotationDeg.value % 360;
    const normalizedAngle = ((currentAngle % 360) + 360) % 360;

    const collision = knivesRef.current.some((k) => {
      const diff = Math.abs(((normalizedAngle - k.angleDeg + 540) % 360) - 180);
      return diff < MIN_ANGLE_DIFF;
    });

    if (collision) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      triggerScreenShake(10);
      knifeY.value = withTiming(-60, { duration: 200, easing: Easing.in(Easing.quad) }, () => {
        knifeOpacity.value = 0;
      });
      setTimeout(() => {
        setGameState('lost');
        resultScale.value = withSpring(1, { damping: 12, stiffness: 200 });
        isAnimating.current = false;
      }, 300);
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    triggerScreenShake(4);
    knifeY.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.quad) }, () => { });

    setTimeout(() => {
      const newKnife: Knife = {
        id: Date.now().toString() + Math.random(),
        angleDeg: normalizedAngle,
        color: knifeColor,
      };
      const next = [...knivesRef.current, newKnife];
      knivesRef.current = next;
      setKnivesOnLog([...next]);

      if (next.length >= WIN_KNIVES) {
        setTimeout(async () => {
          setGameState('won');
          resultScale.value = withSpring(1, { damping: 12, stiffness: 200 });
          const earned = PT_REWARD;
          setPtEarned(earned);
          await addPowerTokens(earned, `Knife Hit level ${level} win`);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setShowDoubleOffer(true);
          isAnimating.current = false;
        }, 100);
      } else {
        knifeY.value = 160;
        knifeOpacity.value = 1;
        setKnifeReady(true);
        isAnimating.current = false;
      }
    }, 200);
  }, [knifeReady, gameState, knifeColor, level]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: throwKnife,
    })
  ).current;

  useEffect(() => {
    panResponder.panHandlers.onStartShouldSetResponder = () => true;
  }, [throwKnife]);

  async function handleDoubleTokens() {
    if (isLoadingAd) return;
    setIsLoadingAd(true);
    await adService.showAdMobRewarded((rewarded) => {
      if (rewarded) {
        addPowerTokens(PT_REWARD, `Double reward — Knife Hit level ${level}`);
        setPtEarned(PT_REWARD * 2);
        setShowDoubleOffer(false);
        Alert.alert('Doubled!', `You earned ${PT_REWARD * 2} Power Tokens!`);
      }
    });
    setIsLoadingAd(false);
  }

  const cx = SCREEN_WIDTH / 2;
  const cy = GAME_AREA_HEIGHT / 2;

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(255,107,0,0.15)', 'rgba(244,196,48,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />

      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16) }]}>
        <Text style={styles.title}>Knife Hit</Text>
        <View style={styles.headerRight}>
          <MaterialCommunityIcons name="lightning-bolt" size={16} color={Colors.gold} />
          <Text style={styles.rewardText}>{PT_REWARD} PT per win</Text>
        </View>
      </View>

      {gameState === 'menu' && (
        <Animated.View entering={FadeInDown.springify()} style={styles.menuArea}>
          <View style={styles.menuCard}>
            <MaterialCommunityIcons name="knife" size={56} color={Colors.gold} />
            <Text style={styles.menuTitle}>Knife Hit</Text>
            <Text style={styles.menuDesc}>
              Throw {WIN_KNIVES} knives into the rotating log without hitting existing knives. Win to earn Power Tokens!
            </Text>
            <View style={styles.rewardBadge}>
              <MaterialCommunityIcons name="lightning-bolt" size={18} color={Colors.gold} />
              <Text style={styles.rewardBadgeText}>{PT_REWARD} PT per win • Double with Ad</Text>
            </View>
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <Text style={styles.statNum}>{WIN_KNIVES}</Text>
                <Text style={styles.statLbl}>Knives</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statNum}>Lv.{level}</Text>
                <Text style={styles.statLbl}>Level</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statNum}>{speed.toFixed(1)}x</Text>
                <Text style={styles.statLbl}>Speed</Text>
              </View>
            </View>
            <Pressable
              style={({ pressed }) => [styles.playBtn, { opacity: pressed ? 0.85 : 1 }]}
              onPress={startGame}
            >
              <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.playGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                <Ionicons name="play" size={20} color="#000" />
                <Text style={styles.playText}>Play Now</Text>
              </LinearGradient>
            </Pressable>
          </View>
        </Animated.View>
      )}

      {(gameState === 'playing' || gameState === 'won' || gameState === 'lost') && (
        <View style={styles.gameArea} {...(gameState === 'playing' ? panResponder.panHandlers : {})}>
          <View style={styles.knifeCounter}>
            {[...Array(WIN_KNIVES)].map((_, i) => (
              <View
                key={i}
                style={[
                  styles.counterDot,
                  {
                    backgroundColor: i < knivesOnLog.length ? Colors.gold : Colors.darkSurface,
                    width: i < knivesOnLog.length ? 14 : 10,
                    height: i < knivesOnLog.length ? 14 : 10,
                  }
                ]}
              />
            ))}
          </View>

          <View style={styles.levelBadge}>
            <Text style={styles.levelText}>Lv.{level}</Text>
            <Text style={styles.speedText}>{speed.toFixed(1)}x</Text>
          </View>

          <Animated.View style={[styles.logArea, { width: SCREEN_WIDTH, height: GAME_AREA_HEIGHT }, shakeStyle]}>
            <View style={{ position: 'absolute', top: 0, left: 0, width: SCREEN_WIDTH, height: GAME_AREA_HEIGHT }}>
              <Animated.View
                style={[
                  styles.log,
                  {
                    left: cx - LOG_RADIUS,
                    top: cy - LOG_RADIUS,
                    borderRadius: LOG_RADIUS,
                    width: LOG_RADIUS * 2,
                    height: LOG_RADIUS * 2,
                  },
                  logStyle,
                ]}
              >
                <LinearGradient
                  colors={bossColors as [string, string, string]}
                  style={{ flex: 1, borderRadius: LOG_RADIUS }}
                />
                {[...Array(8)].map((_, i) => (
                  <View
                    key={i}
                    style={[
                      styles.logRing,
                      {
                        width: (LOG_RADIUS * 2 - i * 14),
                        height: (LOG_RADIUS * 2 - i * 14),
                        borderRadius: LOG_RADIUS - i * 7,
                        top: i * 7,
                        left: i * 7,
                        borderColor: `rgba(180,130,70,${0.12 + i * 0.025})`,
                      }
                    ]}
                  />
                ))}
                <View style={styles.logCenter}>
                  <View style={styles.logCenterDot} />
                </View>
              </Animated.View>

              {knivesOnLog.map((k) => {
                const angleRad = degreesToRad(k.angleDeg - 90);
                const kx = cx + Math.cos(angleRad) * LOG_RADIUS - KNIFE_WIDTH / 2;
                const ky = cy + Math.sin(angleRad) * LOG_RADIUS - KNIFE_LENGTH;
                return (
                  <View
                    key={k.id}
                    style={[
                      styles.stuckKnife,
                      {
                        left: kx,
                        top: ky,
                        width: KNIFE_WIDTH,
                        height: KNIFE_LENGTH,
                        transform: [{ rotate: `${k.angleDeg}deg` }],
                        backgroundColor: k.color,
                      },
                    ]}
                  />
                );
              })}

              {gameState === 'playing' && (
                <Animated.View
                  style={[
                    styles.flyingKnife,
                    {
                      left: cx - KNIFE_WIDTH / 2,
                      top: cy + LOG_RADIUS + 10,
                      backgroundColor: knifeColor,
                    },
                    knifeStyle,
                  ]}
                />
              )}
            </View>
          </Animated.View>

          {gameState === 'playing' && (
            <View style={styles.tapHint}>
              <Animated.View entering={FadeIn.delay(500)}>
                <Text style={styles.tapText}>Tap anywhere to throw</Text>
              </Animated.View>
            </View>
          )}

          {(gameState === 'won' || gameState === 'lost') && (
            <Animated.View style={[styles.resultOverlay, resultStyle]}>
              <LinearGradient
                colors={gameState === 'won' ? [Colors.gold, Colors.neonOrange] : ['#FF3D57', '#CC1A2A']}
                style={styles.resultCard}
              >
                {gameState === 'won' ? (
                  <>
                    <Ionicons name="trophy" size={48} color="#000" />
                    <Text style={styles.resultTitle}>You Won!</Text>
                    <Text style={styles.resultSub}>+{ptEarned} Power Tokens earned</Text>
                    {showDoubleOffer && (
                      <Pressable
                        style={({ pressed }) => [styles.doubleBtn, { opacity: pressed || isLoadingAd ? 0.75 : 1 }]}
                        onPress={handleDoubleTokens}
                        disabled={isLoadingAd}
                      >
                        <View style={styles.doubleBtnInner}>
                          <Ionicons name="tv-outline" size={16} color={Colors.gold} />
                          <Text style={styles.doubleBtnText}>
                            {isLoadingAd ? 'Loading...' : `Watch Ad → Double (+${PT_REWARD * 2} PT)`}
                          </Text>
                        </View>
                      </Pressable>
                    )}
                  </>
                ) : (
                  <>
                    <MaterialCommunityIcons name="knife" size={48} color="#fff" />
                    <Text style={[styles.resultTitle, { color: '#fff' }]}>Collision!</Text>
                    <Text style={[styles.resultSub, { color: 'rgba(255,255,255,0.8)' }]}>Knives hit each other</Text>
                  </>
                )}
                <Pressable
                  style={({ pressed }) => [styles.playAgainBtn, { opacity: pressed ? 0.8 : 1 }]}
                  onPress={() => {
                    if (gameState === 'won') setLevel(l => l + 1);
                    startGame();
                  }}
                >
                  <Text style={[styles.playAgainText, { color: gameState === 'won' ? '#000' : '#fff' }]}>
                    {gameState === 'won' ? `Next Level (${level + 1})` : 'Try Again'}
                  </Text>
                </Pressable>
                <Pressable onPress={() => { setGameState('menu'); setLevel(1); }} style={styles.menuLink}>
                  <Text style={[styles.menuLinkText, { color: gameState === 'won' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.6)' }]}>
                    Back to Menu
                  </Text>
                </Pressable>
              </LinearGradient>
            </Animated.View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12,
  },
  title: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.textPrimary },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rewardText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  menuArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  menuCard: {
    backgroundColor: Colors.darkCard, borderRadius: 24,
    padding: 28, alignItems: 'center', gap: 14,
    borderWidth: 1, borderColor: Colors.darkBorder, width: '100%',
  },
  menuTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.textPrimary },
  menuDesc: {
    fontFamily: 'Inter_400Regular', fontSize: 13,
    color: Colors.textSecondary, textAlign: 'center', lineHeight: 21,
  },
  rewardBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(244,196,48,0.12)', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 8,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.25)',
  },
  rewardBadgeText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  statItem: { alignItems: 'center', gap: 2 },
  statNum: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },
  statLbl: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },
  statDivider: { width: 1, height: 32, backgroundColor: Colors.darkBorder },
  playBtn: { width: '100%' },
  playGradient: {
    height: 52, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  playText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  gameArea: { flex: 1, alignItems: 'center' },
  knifeCounter: {
    flexDirection: 'row', gap: 7, marginBottom: 12, paddingHorizontal: 20,
    alignItems: 'center',
  },
  counterDot: { borderRadius: 7 },
  levelBadge: {
    flexDirection: 'row', gap: 10, alignItems: 'center', marginBottom: 4,
  },
  levelText: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textMuted },
  speedText: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.neonOrange },
  logArea: { position: 'relative' },
  log: { position: 'absolute', overflow: 'hidden' },
  logRing: {
    position: 'absolute', borderWidth: 1, borderRadius: 100,
  },
  logCenter: {
    position: 'absolute',
    top: LOG_RADIUS - 8,
    left: LOG_RADIUS - 8,
    width: 16, height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  logCenterDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)' },
  stuckKnife: {
    position: 'absolute',
    borderRadius: 3,
    borderTopLeftRadius: 1,
    borderTopRightRadius: 1,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
  },
  flyingKnife: {
    position: 'absolute',
    width: KNIFE_WIDTH,
    height: KNIFE_LENGTH,
    borderRadius: 3,
    borderTopLeftRadius: 1,
    borderTopRightRadius: 1,
    shadowColor: Colors.gold,
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  tapHint: { alignItems: 'center', marginTop: 8 },
  tapText: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
  resultOverlay: {
    position: 'absolute', bottom: 16, left: 16, right: 16,
  },
  resultCard: {
    borderRadius: 24, padding: 24,
    alignItems: 'center', gap: 8,
  },
  resultTitle: { fontFamily: 'Inter_700Bold', fontSize: 26, color: '#000' },
  resultSub: { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(0,0,0,0.7)' },
  doubleBtn: {
    marginTop: 4, borderRadius: 12, overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  doubleBtnInner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 18, paddingVertical: 10,
  },
  doubleBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  playAgainBtn: {
    backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: 12,
    paddingHorizontal: 28, paddingVertical: 11, marginTop: 6,
  },
  playAgainText: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  menuLink: { paddingVertical: 4 },
  menuLinkText: { fontFamily: 'Inter_500Medium', fontSize: 13 },
});
