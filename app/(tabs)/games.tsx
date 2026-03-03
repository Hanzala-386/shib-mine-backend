import React, { useState, useRef, useEffect } from 'react';
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
} from 'react-native-reanimated';
import { useWallet } from '@/context/WalletContext';
import Colors from '@/constants/colors';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const GAME_AREA_HEIGHT = 320;
const LOG_RADIUS = 70;
const KNIFE_LENGTH = 50;
const KNIFE_WIDTH = 6;
const MAX_KNIVES = 12;
const WIN_KNIVES = 8;
const PT_REWARD = 3;

interface Knife {
  id: string;
  angleDeg: number;
}

type GameState = 'menu' | 'playing' | 'won' | 'lost';

function degreesToRad(d: number) { return (d * Math.PI) / 180; }

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { addPowerTokens } = useWallet();
  const [gameState, setGameState] = useState<GameState>('menu');
  const [knivesOnLog, setKnivesOnLog] = useState<Knife[]>([]);
  const [knifeReady, setKnifeReady] = useState(true);
  const [level, setLevel] = useState(1);
  const [ptEarned, setPtEarned] = useState(0);

  const rotationDeg = useSharedValue(0);
  const knifeY = useSharedValue(160);
  const knifeOpacity = useSharedValue(1);
  const resultScale = useSharedValue(0);

  const rotationRef = useRef(0);
  const isAnimating = useRef(false);

  const speed = 1.5 + level * 0.3;

  useEffect(() => {
    if (gameState === 'playing') {
      rotationDeg.value = withRepeat(
        withTiming(rotationDeg.value + 360, { duration: (3000 / speed), easing: Easing.linear }),
        -1, false
      );
    } else {
      rotationDeg.value = withTiming(rotationDeg.value, { duration: 300 });
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

  function startGame() {
    setKnivesOnLog([]);
    setKnifeReady(true);
    setGameState('playing');
    setPtEarned(0);
    knifeY.value = 160;
    knifeOpacity.value = 1;
    resultScale.value = 0;
  }

  function throwKnife() {
    if (!knifeReady || gameState !== 'playing' || isAnimating.current) return;
    isAnimating.current = true;
    setKnifeReady(false);

    const currentAngle = rotationDeg.value % 360;
    const normalizedAngle = ((currentAngle % 360) + 360) % 360;

    const MIN_ANGLE_DIFF = 22;
    const collision = knivesOnLog.some((k) => {
      const diff = Math.abs(((normalizedAngle - k.angleDeg + 540) % 360) - 180);
      return diff < MIN_ANGLE_DIFF;
    });

    if (collision) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      knifeY.value = withTiming(-50, { duration: 200, easing: Easing.in(Easing.quad) }, () => {
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
    knifeY.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.quad) }, () => {});

    setTimeout(() => {
      setKnivesOnLog(prev => {
        const next = [...prev, { id: Date.now().toString() + Math.random(), angleDeg: normalizedAngle }];
        if (next.length >= WIN_KNIVES) {
          setTimeout(async () => {
            setGameState('won');
            resultScale.value = withSpring(1, { damping: 12, stiffness: 200 });
            const earned = PT_REWARD;
            setPtEarned(earned);
            await addPowerTokens(earned, `Knife Hit level ${level} win`);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            isAnimating.current = false;
          }, 100);
        } else {
          knifeY.value = 160;
          knifeOpacity.value = 1;
          setKnifeReady(true);
          isAnimating.current = false;
        }
        return next;
      });
    }, 200);
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: () => {
        throwKnife();
      },
    })
  ).current;

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
              <Text style={styles.rewardBadgeText}>{PT_REWARD} Power Tokens per win</Text>
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
                  { backgroundColor: i < knivesOnLog.length ? Colors.gold : Colors.darkSurface }
                ]}
              />
            ))}
          </View>

          <View style={[styles.logArea, { width: SCREEN_WIDTH, height: GAME_AREA_HEIGHT }]}>
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
                  colors={['#6B4C2A', '#3D2A15', '#6B4C2A']}
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
                        borderColor: `rgba(150,100,50,${0.15 + i * 0.03})`,
                      }
                    ]}
                  />
                ))}
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
                    },
                    knifeStyle,
                  ]}
                />
              )}
            </View>
          </View>

          {gameState === 'playing' && (
            <View style={styles.tapHint}>
              <Text style={styles.tapText}>Tap anywhere to throw</Text>
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
                  onPress={startGame}
                >
                  <Text style={[styles.playAgainText, { color: gameState === 'won' ? '#000' : '#fff' }]}>
                    Play Again
                  </Text>
                </Pressable>
                <Pressable onPress={() => setGameState('menu')} style={styles.menuLink}>
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
    paddingHorizontal: 20, paddingBottom: 16,
  },
  title: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.textPrimary },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rewardText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  menuArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  menuCard: {
    backgroundColor: Colors.darkCard, borderRadius: 24,
    padding: 32, alignItems: 'center', gap: 16,
    borderWidth: 1, borderColor: Colors.darkBorder, width: '100%',
  },
  menuTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.textPrimary },
  menuDesc: {
    fontFamily: 'Inter_400Regular', fontSize: 14,
    color: Colors.textSecondary, textAlign: 'center', lineHeight: 22,
  },
  rewardBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(244,196,48,0.12)', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 8,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.25)',
  },
  rewardBadgeText: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.gold },
  playBtn: { width: '100%' },
  playGradient: {
    height: 52, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  playText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  gameArea: { flex: 1, alignItems: 'center' },
  knifeCounter: {
    flexDirection: 'row', gap: 6, marginBottom: 16, paddingHorizontal: 20,
  },
  counterDot: { width: 10, height: 10, borderRadius: 5 },
  logArea: { position: 'relative' },
  log: { position: 'absolute', overflow: 'hidden' },
  logRing: {
    position: 'absolute', borderWidth: 1, borderRadius: 100,
  },
  stuckKnife: {
    position: 'absolute',
    backgroundColor: '#C0C0C0',
    borderRadius: 3,
    borderTopLeftRadius: 1,
    borderTopRightRadius: 1,
  },
  flyingKnife: {
    position: 'absolute',
    width: KNIFE_WIDTH,
    height: KNIFE_LENGTH,
    backgroundColor: '#C0C0C0',
    borderRadius: 3,
    borderTopLeftRadius: 1,
    borderTopRightRadius: 1,
  },
  tapHint: { alignItems: 'center', marginTop: 8 },
  tapText: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
  resultOverlay: {
    position: 'absolute', bottom: 24, left: 20, right: 20,
  },
  resultCard: {
    borderRadius: 24, padding: 28,
    alignItems: 'center', gap: 10,
  },
  resultTitle: { fontFamily: 'Inter_700Bold', fontSize: 28, color: '#000' },
  resultSub: { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(0,0,0,0.7)' },
  playAgainBtn: {
    backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: 12,
    paddingHorizontal: 32, paddingVertical: 12, marginTop: 8,
  },
  playAgainText: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  menuLink: { paddingVertical: 4 },
  menuLinkText: { fontFamily: 'Inter_500Medium', fontSize: 14 },
});
