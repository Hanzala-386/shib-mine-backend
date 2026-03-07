import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, Alert, Platform,
  ActivityIndicator,
} from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { useWallet } from '@/context/WalletContext';
import { api } from '@/lib/api';
import { getApiUrl } from '@/lib/query-client';
import { adService } from '@/lib/AdService';
import Colors from '@/constants/colors';

interface GameResult {
  score: number;
  pt: number;
  level: number;
}

type OverlayState = 'hidden' | 'game_over' | 'awarding' | 'done';

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { pbUser } = useAuth();
  const { refreshBalance } = useWallet();

  const webViewRef = useRef<WebView>(null);
  const [webviewReady, setWebviewReady] = useState(false);
  const [webviewError, setWebviewError] = useState(false);
  const [overlay, setOverlay] = useState<OverlayState>('hidden');
  const [result, setResult] = useState<GameResult | null>(null);
  const [finalPt, setFinalPt] = useState(0);
  const [isLoadingAd, setIsLoadingAd] = useState(false);
  const [isAwardingPt, setIsAwardingPt] = useState(false);
  const alreadyProcessed = useRef(false);

  const gameUrl = `${getApiUrl()}/game/`;

  /* ── Message bridge: game → app ─────────────────────── */
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'GAME_OVER' && !alreadyProcessed.current) {
        alreadyProcessed.current = true;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        const r: GameResult = {
          score: data.score || 0,
          pt: Math.max(1, data.pt || 1),
          level: data.level || 1,
        };
        setResult(r);
        setFinalPt(r.pt);
        setOverlay('game_over');
      }
    } catch {}
  }, []);

  /* ── Award PT to PocketBase ─────────────────────────── */
  async function awardPT(amount: number) {
    const pbId = pbUser?.pbId;
    if (!pbId) { Alert.alert('Error', 'Account not ready. Please try again.'); return; }
    setIsAwardingPt(true);
    setOverlay('awarding');
    try {
      await api.gameReward(pbId, amount, 'knife_hit');
      await refreshBalance();
      setFinalPt(amount);
      setOverlay('done');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Could not award tokens. Please try again.');
      setOverlay('game_over');
    } finally {
      setIsAwardingPt(false);
    }
  }

  /* ── Collect without ad ─────────────────────────────── */
  async function handleCollect() {
    if (!result) return;
    await awardPT(result.pt);
  }

  /* ── Double reward with rewarded ad ────────────────── */
  async function handleDoubleAd() {
    if (!result || isLoadingAd) return;
    setIsLoadingAd(true);
    try {
      await adService.showAdMobRewarded((rewarded: boolean) => {
        setIsLoadingAd(false);
        if (rewarded) {
          awardPT(result.pt * 2);
        } else {
          Alert.alert('No reward', 'You need to finish the ad to double your tokens.');
        }
      });
    } catch {
      setIsLoadingAd(false);
      awardPT(result.pt);
    }
  }

  /* ── Play again ─────────────────────────────────────── */
  function handlePlayAgain() {
    alreadyProcessed.current = false;
    setOverlay('hidden');
    setResult(null);
    setFinalPt(0);
    webViewRef.current?.reload();
  }

  /* ── Layout ─────────────────────────────────────────── */
  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <View style={styles.root}>
      {/* Header bar */}
      <View style={[styles.header, { paddingTop: topInset + 8 }]}>
        <View style={styles.headerInner}>
          <MaterialCommunityIcons name="knife" size={22} color={Colors.gold} />
          <Text style={styles.headerTitle}>Knife Hit</Text>
        </View>
        <View style={styles.headerRight}>
          <Ionicons name="flash" size={14} color={Colors.gold} />
          <Text style={styles.headerSub}>Score → Power Tokens</Text>
        </View>
      </View>

      {/* WebView playing area */}
      <View style={styles.webviewWrapper}>
        {!webviewError && (
          <WebView
            ref={webViewRef}
            source={{ uri: gameUrl }}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            allowsInlineMediaPlayback={true}
            mediaPlaybackRequiresUserAction={false}
            originWhitelist={['*']}
            onMessage={onMessage}
            onLoadEnd={() => setWebviewReady(true)}
            onError={() => setWebviewError(true)}
            style={styles.webview}
            scrollEnabled={false}
            bounces={false}
            overScrollMode="never"
            showsVerticalScrollIndicator={false}
            showsHorizontalScrollIndicator={false}
          />
        )}
        {/* Loading spinner */}
        {!webviewReady && !webviewError && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={styles.loadingText}>Loading Knife Hit...</Text>
          </View>
        )}
        {/* Error state */}
        {webviewError && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={48} color={Colors.textMuted} />
            <Text style={styles.errorText}>Could not load the game.</Text>
            <Pressable
              style={styles.retryBtn}
              onPress={() => { setWebviewError(false); setWebviewReady(false); }}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Native overlay — appears on game over */}
      {overlay !== 'hidden' && (
        <View style={[styles.overlayContainer, { pointerEvents: 'box-none' }]}>
          <LinearGradient
            colors={['rgba(0,0,0,0)', 'rgba(5,3,0,0.94)', '#050300']}
            style={[styles.overlayGrad, { paddingBottom: bottomInset + 20, pointerEvents: 'box-none' }]}
          >
            {/* Awarding state */}
            {overlay === 'awarding' && (
              <View style={styles.awardingBox}>
                <ActivityIndicator size="large" color={Colors.gold} />
                <Text style={styles.awardingText}>Awarding Power Tokens...</Text>
              </View>
            )}

            {/* Game over — show score + reward options */}
            {overlay === 'game_over' && result && (
              <View style={styles.card}>
                <Text style={styles.gameOverLabel}>GAME OVER</Text>

                <Text style={styles.scoreVal}>{result.score}</Text>
                <Text style={styles.scoreLabel}>score · level {result.level}</Text>

                <View style={styles.ptBadge}>
                  <Ionicons name="flash" size={16} color={Colors.gold} />
                  <Text style={styles.ptBadgeText}>{result.pt} Power Token{result.pt !== 1 ? 's' : ''} earned</Text>
                </View>

                {/* Double with ad */}
                <Pressable
                  style={({ pressed }) => [
                    styles.doubleBtn,
                    { opacity: pressed || isLoadingAd ? 0.7 : 1 },
                  ]}
                  onPress={handleDoubleAd}
                  disabled={isLoadingAd || isAwardingPt}
                >
                  <LinearGradient
                    colors={[Colors.neonOrange, Colors.gold]}
                    style={styles.doubleBtnInner}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                  >
                    {isLoadingAd
                      ? <ActivityIndicator size="small" color="#000" />
                      : <Ionicons name="play-circle" size={20} color="#000" />}
                    <Text style={styles.doubleBtnText}>
                      {isLoadingAd
                        ? 'Loading ad...'
                        : `Watch Ad → Get ${result.pt * 2} PT`}
                    </Text>
                  </LinearGradient>
                </Pressable>

                {/* Collect without ad */}
                <Pressable
                  style={[styles.collectBtn, { opacity: isAwardingPt ? 0.5 : 1 }]}
                  onPress={handleCollect}
                  disabled={isAwardingPt || isLoadingAd}
                >
                  <Text style={styles.collectText}>Collect {result.pt} PT (no ad)</Text>
                </Pressable>
              </View>
            )}

            {/* Done — tokens awarded */}
            {overlay === 'done' && (
              <View style={styles.card}>
                <Ionicons name="checkmark-circle" size={56} color={Colors.success} />
                <Text style={styles.doneTitle}>Tokens Added!</Text>
                <Text style={styles.doneSub}>
                  +{finalPt} Power Token{finalPt !== 1 ? 's' : ''} added to your wallet
                </Text>
                <Pressable
                  style={styles.playAgainBtn}
                  onPress={handlePlayAgain}
                >
                  <LinearGradient
                    colors={[Colors.gold, Colors.neonOrange]}
                    style={styles.playAgainInner}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                  >
                    <Ionicons name="refresh" size={18} color="#000" />
                    <Text style={styles.playAgainText}>Play Again</Text>
                  </LinearGradient>
                </Pressable>
              </View>
            )}
          </LinearGradient>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#050300',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingBottom: 10,
    paddingHorizontal: 18,
  },
  headerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 18,
    color: Colors.gold,
    letterSpacing: 0.4,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerSub: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    color: Colors.textMuted,
  },
  webviewWrapper: {
    flex: 1,
    backgroundColor: '#1a0a02',
    position: 'relative',
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#050300',
    gap: 14,
  },
  loadingText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 15,
    color: Colors.textMuted,
  },
  errorBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
    padding: 24,
  },
  errorText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 15,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    backgroundColor: Colors.gold,
    borderRadius: 12,
  },
  retryText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 15,
    color: '#000',
  },
  overlayContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  overlayGrad: {
    paddingTop: 80,
    paddingHorizontal: 20,
  },
  awardingBox: {
    alignItems: 'center',
    gap: 14,
    paddingVertical: 48,
  },
  awardingText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 15,
    color: Colors.textMuted,
  },
  card: {
    alignItems: 'center',
    gap: 12,
    paddingBottom: 8,
  },
  gameOverLabel: {
    fontFamily: 'Inter_700Bold',
    fontSize: 12,
    color: Colors.textMuted,
    letterSpacing: 3,
    textTransform: 'uppercase',
  },
  scoreVal: {
    fontFamily: 'Inter_700Bold',
    fontSize: 64,
    color: Colors.gold,
    lineHeight: 68,
  },
  scoreLabel: {
    fontFamily: 'Inter_400Regular',
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: -6,
  },
  ptBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(244,196,48,0.12)',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.25)',
    marginVertical: 2,
  },
  ptBadgeText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
    color: Colors.gold,
  },
  doubleBtn: {
    width: '100%',
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 4,
  },
  doubleBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
    paddingHorizontal: 20,
  },
  doubleBtnText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
    color: '#000',
  },
  collectBtn: {
    paddingVertical: 11,
    paddingHorizontal: 28,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  collectText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 14,
    color: 'rgba(255,255,255,0.55)',
  },
  doneTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    color: Colors.success,
    marginTop: 4,
  },
  doneSub: {
    fontFamily: 'Inter_500Medium',
    fontSize: 15,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    paddingHorizontal: 16,
    lineHeight: 22,
  },
  playAgainBtn: {
    width: '100%',
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 4,
  },
  playAgainInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
  },
  playAgainText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 16,
    color: '#000',
  },
});
