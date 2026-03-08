import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, Dimensions, Modal, Pressable,
  ActivityIndicator, Platform, BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useWallet } from '@/context/WalletContext';
import { useAuth } from '@/context/AuthContext';
import { getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';

// WebView is native-only; on web we fall back to iframe
let WebView: any = null;
if (Platform.OS !== 'web') {
  WebView = require('react-native-webview').WebView;
}

const { width: SW, height: SH } = Dimensions.get('window');
const GAME_URL = `${getApiUrl()}/arcade/index.html`;

// ─── Ad networks configuration ───────────────────────────────────────────────
type AdNetwork = 'admob' | 'unity' | 'applovin';
const AD_NETWORKS: AdNetwork[] = ['admob', 'unity', 'applovin'];

function pickNetwork(): AdNetwork {
  return AD_NETWORKS[Math.floor(Math.random() * AD_NETWORKS.length)];
}

// Simulated ad timer (replace with real SDK in a custom dev build)
function showSimulatedAd(
  type: 'interstitial' | 'rewarded',
  onComplete: (watched: boolean) => void,
  onFailed: () => void,
) {
  const duration = type === 'rewarded' ? 5000 : 3000;
  setTimeout(() => onComplete(true), duration);
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function GamesScreen() {
  const insets         = useSafeAreaInsets();
  const { addPowerTokens, powerTokens } = useWallet();
  const { user }       = useAuth();

  const wvRef          = useRef<WebView>(null);
  const pendingScore   = useRef(0);
  const [gameReady,    setGameReady]    = useState(false);
  const [phase, setPhase]              = useState<'game' | 'collect' | 'ad' | 'double_ad' | 'reward'>('game');
  const [score, setScore]              = useState(0);
  const [earned, setEarned]            = useState(0);
  const [adNetwork, setAdNetwork]      = useState<AdNetwork>('admob');
  const [adTimer, setAdTimer]          = useState(0);
  const adInterval                     = useRef<ReturnType<typeof setInterval> | null>(null);

  const TOP = Platform.OS === 'web' ? 67 : insets.top;
  const BOT = Platform.OS === 'web' ? 34 : insets.bottom;

  // ── Handle messages from Construct 3 bridge ──────────────────────────────
  const onMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);

      if (msg.type === 'BRIDGE_READY') {
        setGameReady(true);
        // Inject user context so the game knows the player
        wvRef.current?.injectJavaScript(
          `window.__rnUserId = ${JSON.stringify(user?.pbId || '')};`
        );
      }

      if (msg.type === 'GAME_OVER') {
        const s = Math.max(0, Math.round(Number(msg.score) || 0));
        pendingScore.current = s;
        setScore(s);
        setPhase('collect');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch { /* ignore malformed messages */ }
  }, [user]);

  // ── Collect tokens (standard, no double) ────────────────────────────────
  const handleCollect = useCallback(async () => {
    const net = pickNetwork();
    setAdNetwork(net);
    setPhase('ad');
    startAdCountdown(3);

    showSimulatedAd('interstitial',
      async () => {
        clearAdTimer();
        const pts = pendingScore.current;
        if (pts > 0) {
          try { await addPowerTokens(pts, 'knife_hit'); } catch { /* silent */ }
        }
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      },
      () => { clearAdTimer(); handleDirectCollect(); }
    );
  }, [addPowerTokens]);

  const handleDirectCollect = useCallback(async () => {
    const pts = pendingScore.current;
    if (pts > 0) {
      try { await addPowerTokens(pts, 'knife_hit'); } catch { /* silent */ }
    }
    setEarned(pts);
    setPhase('reward');
  }, [addPowerTokens]);

  // ── Double tokens (2× after watching rewarded ad) ───────────────────────
  const handleDouble = useCallback(() => {
    const net = pickNetwork();
    setAdNetwork(net);
    setPhase('double_ad');
    startAdCountdown(5);

    showSimulatedAd('rewarded',
      async (watched) => {
        clearAdTimer();
        if (!watched) { setPhase('collect'); return; }
        const pts = pendingScore.current * 2;
        if (pts > 0) {
          try { await addPowerTokens(pts, 'knife_hit'); } catch { /* silent */ }
        }
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      },
      () => { clearAdTimer(); setPhase('collect'); }
    );
  }, [addPowerTokens]);

  // ── Ad countdown UI ──────────────────────────────────────────────────────
  function startAdCountdown(secs: number) {
    setAdTimer(secs);
    const iv = setInterval(() => {
      setAdTimer(t => {
        if (t <= 1) { clearInterval(iv); return 0; }
        return t - 1;
      });
    }, 1000);
    adInterval.current = iv;
  }

  function clearAdTimer() {
    if (adInterval.current) { clearInterval(adInterval.current); adInterval.current = null; }
    setAdTimer(0);
  }

  // ── Play again (reload WebView) ──────────────────────────────────────────
  const playAgain = useCallback(() => {
    pendingScore.current = 0;
    setScore(0);
    setEarned(0);
    setGameReady(false);
    setPhase('game');
    wvRef.current?.reload();
  }, []);

  // ── Clean up ad timer on unmount ─────────────────────────────────────────
  useEffect(() => () => { clearAdTimer(); }, []);

  // ── Network label helper ─────────────────────────────────────────────────
  const networkLabel: Record<AdNetwork, string> = {
    admob: 'AdMob',
    unity: 'Unity Ads',
    applovin: 'AppLovin',
  };

  // ── Web platform: listen for postMessage from iframe ────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e: MessageEvent) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (!data || !data.type) return;
        if (data.type === 'BRIDGE_READY') setGameReady(true);
        if (data.type === 'GAME_OVER') {
          const s = Math.max(0, Math.round(Number(data.score) || 0));
          pendingScore.current = s;
          setScore(s);
          setPhase('collect');
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Android back button ──────────────────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase !== 'game') { setPhase('game'); return true; }
      wvRef.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, [phase]);

  // ── Render game container ────────────────────────────────────────────────
  const renderGame = () => {
    if (Platform.OS === 'web') {
      const IFrame = 'iframe' as any;
      return (
        <IFrame
          src={GAME_URL}
          style={{ flex: 1, border: 'none', width: '100%', height: '100%' }}
          allow="autoplay"
          title="Weapon Master"
        />
      );
    }
    return (
      <WebView
        ref={wvRef}
        source={{ uri: GAME_URL }}
        style={styles.webview}
        originWhitelist={['*']}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo={false}
        mixedContentMode="always"
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={styles.loadingText}>Loading Game…</Text>
          </View>
        )}
        onError={() => setGameReady(false)}
        containerStyle={{ flex: 1 }}
      />
    );
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>

      {/* ── GAME (WebView on native, iframe on web) ── */}
      {renderGame()}

      {/* ── PT badge (always visible over game) ── */}
      <View style={[styles.ptBadge, { top: TOP + 8 }]} pointerEvents="none">
        <Ionicons name="flash" size={13} color={Colors.gold} />
        <Text style={styles.ptText}>{powerTokens} PT</Text>
      </View>

      {/* ══════════════════════════════════════════════════════════════════
          COLLECT MODAL — shown when game ends
      ══════════════════════════════════════════════════════════════════ */}
      <Modal visible={phase === 'collect'} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>GAME OVER</Text>

            <View style={styles.scoreRow}>
              <Text style={styles.scoreLabel}>Score</Text>
              <Text style={styles.scoreValue}>{score}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.earnRow}>
              <Ionicons name="flash" size={22} color={Colors.gold} />
              <Text style={styles.earnText}>{score} PT</Text>
              <Text style={styles.earnSub}>1 score = 1 token</Text>
            </View>

            {/* Double with rewarded ad */}
            {score > 0 && (
              <Pressable style={styles.doubleBtn} onPress={handleDouble}>
                <Ionicons name="play-circle" size={20} color="#fff" />
                <Text style={styles.doubleBtnText}>Double My Tokens  ✕2</Text>
              </Pressable>
            )}

            {/* Collect standard */}
            <Pressable style={styles.collectBtn} onPress={handleCollect}>
              <Text style={styles.collectBtnText}>Collect {score} PT</Text>
            </Pressable>

            <Pressable style={styles.ghost} onPress={playAgain}>
              <Text style={styles.ghostText}>Skip & Play Again</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════════
          INTERSTITIAL AD MODAL
      ══════════════════════════════════════════════════════════════════ */}
      <Modal visible={phase === 'ad'} transparent animationType="fade">
        <View style={styles.adOverlay}>
          <View style={styles.adCard}>
            <Text style={styles.adNetwork}>{networkLabel[adNetwork]}</Text>
            <View style={styles.adPlaceholder}>
              <Ionicons name="megaphone-outline" size={48} color="rgba(255,255,255,0.25)" />
              <Text style={styles.adPlaceholderText}>Advertisement</Text>
              <Text style={styles.adPlaceholderSub}>
                Replace with real {networkLabel[adNetwork]} SDK{'\n'}in your custom dev build
              </Text>
            </View>
            {adTimer > 0 && (
              <View style={styles.adTimer}>
                <Text style={styles.adTimerText}>{adTimer}s</Text>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════════
          REWARDED AD MODAL (double tokens)
      ══════════════════════════════════════════════════════════════════ */}
      <Modal visible={phase === 'double_ad'} transparent animationType="fade">
        <View style={styles.adOverlay}>
          <View style={styles.adCard}>
            <Text style={styles.adNetwork}>{networkLabel[adNetwork]}  •  Rewarded</Text>
            <View style={styles.adPlaceholder}>
              <Ionicons name="gift-outline" size={48} color={Colors.gold} />
              <Text style={[styles.adPlaceholderText, { color: Colors.gold }]}>Watch to Double</Text>
              <Text style={styles.adPlaceholderSub}>
                Watching full ad = {score * 2} PT{'\n'}
                Replace with real {networkLabel[adNetwork]} SDK
              </Text>
            </View>
            {adTimer > 0 && (
              <View style={styles.adTimer}>
                <Text style={styles.adTimerText}>{adTimer}s</Text>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════════
          REWARD MODAL — tokens successfully added
      ══════════════════════════════════════════════════════════════════ */}
      <Modal visible={phase === 'reward'} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={{ fontSize: 48 }}>🎉</Text>
            <Text style={styles.cardTitle}>+{earned} PT</Text>
            <Text style={styles.cardSub}>{powerTokens} PT total balance</Text>

            <Pressable style={styles.collectBtn} onPress={playAgain}>
              <Text style={styles.collectBtnText}>Play Again</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#000' },
  webview: { flex: 1 },

  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0a1f1c',
    alignItems: 'center', justifyContent: 'center', gap: 14,
  },
  loadingText: { color: Colors.textMuted, fontFamily: 'Inter_500Medium', fontSize: 14 },

  ptBadge: {
    position: 'absolute', right: 14,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, zIndex: 50,
  },
  ptText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.gold },

  // Modal scaffolding
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.82)', alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: '#0d1a17', borderRadius: 24, padding: 32, width: SW * 0.84,
    alignItems: 'center', gap: 16, borderWidth: 1, borderColor: 'rgba(244,196,48,0.18)',
  },
  cardTitle: { fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.text, letterSpacing: 2 },
  cardSub:   { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },

  // Score row
  scoreRow:   { flexDirection: 'row', justifyContent: 'space-between', width: '100%', alignItems: 'center' },
  scoreLabel: { fontFamily: 'Inter_500Medium', fontSize: 16, color: Colors.textMuted },
  scoreValue: { fontFamily: 'Inter_700Bold', fontSize: 32, color: Colors.text },
  divider:    { width: '100%', height: 1, backgroundColor: 'rgba(255,255,255,0.07)' },

  earnRow:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  earnText: { fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.gold },
  earnSub:  { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },

  // Buttons
  doubleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#7c3aed', paddingVertical: 14, borderRadius: 28,
    width: '100%', justifyContent: 'center',
  },
  doubleBtnText: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#fff', letterSpacing: 0.5 },

  collectBtn: {
    backgroundColor: Colors.gold, paddingVertical: 14, borderRadius: 28,
    width: '100%', alignItems: 'center',
  },
  collectBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 0.5 },

  ghost:     { paddingVertical: 6 },
  ghostText: { fontFamily: 'Inter_500Medium', fontSize: 13, color: 'rgba(255,255,255,0.32)' },

  // Ad overlay
  adOverlay: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  adCard: {
    width: SW * 0.92, backgroundColor: '#111', borderRadius: 16, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', alignItems: 'center',
  },
  adNetwork: {
    paddingVertical: 8, paddingHorizontal: 16, backgroundColor: 'rgba(255,255,255,0.06)',
    alignSelf: 'stretch', textAlign: 'right',
    fontFamily: 'Inter_500Medium', fontSize: 11, color: 'rgba(255,255,255,0.4)', letterSpacing: 1,
  },
  adPlaceholder: {
    height: SH * 0.48, alignItems: 'center', justifyContent: 'center', gap: 12, width: '100%',
  },
  adPlaceholderText: {
    fontFamily: 'Inter_700Bold', fontSize: 18, color: 'rgba(255,255,255,0.55)', letterSpacing: 1,
  },
  adPlaceholderSub: {
    fontFamily: 'Inter_400Regular', fontSize: 11, color: 'rgba(255,255,255,0.2)',
    textAlign: 'center', lineHeight: 18,
  },
  adTimer: {
    position: 'absolute', top: 44, right: 14,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  adTimerText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#fff' },
});
