import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, Dimensions, Modal, Pressable,
  ActivityIndicator, Platform, BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useWallet } from '@/context/WalletContext';
import { getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';

// Native WebView only on iOS/Android
let WebView: any = null;
if (Platform.OS !== 'web') {
  WebView = require('react-native-webview').WebView;
}

const { width: SW, height: SH } = Dimensions.get('window');
const GAME_URL     = `${getApiUrl()}/arcade/index.html`;
const SETTINGS_URL = `${getApiUrl()}/api/app/settings`;

/* ─── Ad settings ─────────────────────────────────────────────────────────── */
type AdNetwork = 'admob' | 'unity' | 'applovin';
interface AdSettings {
  showAds: boolean;
  activeAdNetwork: string;
  admobUnitId: string;
  applovinRewardedId: string;
  applovinSdkKey: string;
  unityGameId: string;
  unityRewardedId: string;
}
const DEFAULT: AdSettings = {
  showAds: false, activeAdNetwork: '', admobUnitId: '',
  applovinRewardedId: '', applovinSdkKey: '', unityGameId: '', unityRewardedId: '',
};

function networkOrder(active: string): AdNetwork[] {
  const k = (active || '').toLowerCase();
  const prio: AdNetwork | null =
    k.includes('admob') ? 'admob' : k.includes('unity') ? 'unity' :
    (k.includes('applovin') || k.includes('max')) ? 'applovin' : null;
  const all: AdNetwork[] = ['admob', 'unity', 'applovin'];
  return prio ? [prio, ...all.filter(n => n !== prio)] : all;
}

/* ─── Simulated ad (replace with real SDK in custom dev build) ────────────── */
function showAd(
  type: 'interstitial' | 'rewarded',
  network: AdNetwork,
  cfg: AdSettings,
  onDone: (watched: boolean) => void,
) {
  const TAG = '[Games][Ad]';
  console.log(TAG, 'Showing', type, 'via', network,
    '| adMob:', cfg.admobUnitId || '(no ID)',
    '| unity:', cfg.unityGameId || '(no ID)',
    '| applovin:', cfg.applovinSdkKey || '(no key)');

  // ── Uncomment & fill in when doing custom dev build ──
  // if (network === 'admob' && cfg.admobUnitId) { … }
  // if (network === 'unity' && cfg.unityGameId) { … }
  // if (network === 'applovin' && cfg.applovinSdkKey) { … }

  // Stub: delay then done
  setTimeout(() => {
    console.log(TAG, 'Ad complete (simulated)');
    onDone(true);
  }, type === 'rewarded' ? 5000 : 3000);
}

/* ─── Component ───────────────────────────────────────────────────────────── */
type Phase = 'game' | 'exit_modal' | 'retry_ad' | 'claim_ad' | 'double_ad' | 'saving' | 'reward';
const NET_LABEL: Record<AdNetwork, string> = { admob: 'AdMob', unity: 'Unity Ads', applovin: 'AppLovin MAX' };

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { addPowerTokens, powerTokens } = useWallet();

  const wvRef        = useRef<any>(null);
  const adCfg        = useRef<AdSettings>(DEFAULT);
  const netQueue     = useRef<AdNetwork[]>(['admob', 'unity', 'applovin']);
  const netIdx       = useRef(0);
  const scoreRef     = useRef(0);

  const [phase,   setPhase]   = useState<Phase>('game');
  const [score,   setScore]   = useState(0);
  const [earned,  setEarned]  = useState(0);
  const [adNet,   setAdNet]   = useState<AdNetwork>('admob');
  const [adTimer, setAdTimer] = useState(0);
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  const TOP = Platform.OS === 'web' ? 67 : insets.top;

  /* ── Load settings ── */
  useEffect(() => {
    console.log('[Games] Fetching ad settings from', SETTINGS_URL);
    fetch(SETTINGS_URL)
      .then(r => r.json())
      .then(s => {
        adCfg.current = { ...DEFAULT, ...s };
        netQueue.current = networkOrder(s.activeAdNetwork || '');
        console.log('[Games] Ad settings loaded:', JSON.stringify(adCfg.current));
        console.log('[Games] Network order:', netQueue.current);
      })
      .catch(err => console.warn('[Games] Settings fetch failed:', err));
  }, []);

  /* ── Helpers ── */
  const nextNetwork = () => {
    const n = netQueue.current[netIdx.current % netQueue.current.length];
    netIdx.current += 1;
    return n as AdNetwork;
  };

  const startTimer = (secs: number) => {
    setAdTimer(secs);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setAdTimer(t => { if (t <= 1) { clearInterval(timerRef.current!); return 0; } return t - 1; });
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setAdTimer(0);
  };

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  /* ── Send a message INTO the WebView / iframe ── */
  const sendToGame = useCallback((msg: object) => {
    const json = JSON.stringify(msg);
    console.log('[Games] Sending to game:', json);
    if (Platform.OS !== 'web') {
      wvRef.current?.injectJavaScript(
        `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(json)}}));true;`
      );
    } else {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="WeaponMaster"]');
      frame?.contentWindow?.postMessage(json, '*');
    }
  }, []);

  /* ── Reload the game completely ── */
  const reloadGame = useCallback(() => {
    console.log('[Games] Reloading game');
    scoreRef.current = 0;
    setScore(0);
    setEarned(0);
    setPhase('game');
    if (Platform.OS !== 'web') {
      wvRef.current?.reload();
    } else {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="WeaponMaster"]');
      if (frame) { frame.src = ''; frame.src = GAME_URL; }
    }
  }, []);

  /* ────────────────────────────────────────────────────────────────────────
   *  GAME_OVER received → show the exit modal
   * ────────────────────────────────────────────────────────────────────── */
  const handleGameOver = useCallback((rawScore: number) => {
    const s = Math.max(0, Math.round(rawScore));
    console.log('[Games] GAME_OVER received — score =', s);
    scoreRef.current = s;
    setScore(s);
    setPhase('exit_modal');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  /* ────────────────────────────────────────────────────────────────────────
   *  RETRY (Circle button in game) → interstitial → reload game
   * ────────────────────────────────────────────────────────────────────── */
  const handleRetry = useCallback(() => {
    const net = nextNetwork();
    setAdNet(net);
    setPhase('retry_ad');
    startTimer(3);
    console.log('[Games] RETRY — showing interstitial via', net);
    showAd('interstitial', net, adCfg.current, () => {
      stopTimer();
      console.log('[Games] Retry ad done — reloading game');
      reloadGame();
    });
  }, [reloadGame]);

  /* ────────────────────────────────────────────────────────────────────────
   *  CLAIM (Arrow/Back button → user taps "Claim") → interstitial → tokens
   * ────────────────────────────────────────────────────────────────────── */
  const handleClaim = useCallback(async () => {
    const net = nextNetwork();
    setAdNet(net);
    setPhase('claim_ad');
    startTimer(3);
    console.log('[Games] CLAIM — showing interstitial via', net, 'score=', scoreRef.current);
    showAd('interstitial', net, adCfg.current, async () => {
      stopTimer();
      setPhase('saving');
      const pts = scoreRef.current;
      console.log('[Games] Interstitial done — adding', pts, 'PT to DB');
      try {
        await addPowerTokens(pts, 'knife_hit');
        console.log('[Games] DB updated ✓ — awarded', pts, 'PT');
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        console.error('[Games] addPowerTokens FAILED:', err);
        setPhase('reward');   // still show reward UI with what we tried
        setEarned(pts);
      }
    });
  }, [addPowerTokens]);

  /* ────────────────────────────────────────────────────────────────────────
   *  DOUBLE (2×) → rewarded ad → tokens × 2
   * ────────────────────────────────────────────────────────────────────── */
  const handleDouble = useCallback(async () => {
    const net = nextNetwork();
    setAdNet(net);
    setPhase('double_ad');
    startTimer(5);
    console.log('[Games] DOUBLE — showing rewarded ad via', net, 'score=', scoreRef.current);
    showAd('rewarded', net, adCfg.current, async (watched) => {
      stopTimer();
      if (!watched) { console.log('[Games] Rewarded ad skipped — reverting to exit_modal'); setPhase('exit_modal'); return; }
      setPhase('saving');
      const pts = scoreRef.current * 2;
      console.log('[Games] Rewarded done — adding', pts, 'PT (2×) to DB');
      try {
        await addPowerTokens(pts, 'knife_hit');
        console.log('[Games] DB updated ✓ — awarded', pts, 'PT');
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        console.error('[Games] addPowerTokens FAILED:', err);
        setEarned(pts);
        setPhase('reward');
      }
    });
  }, [addPowerTokens]);

  /* ── Handle messages from bridge.js (native WebView) ── */
  const onNativeMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      console.log('[Games] Native message:', JSON.stringify(msg));
      if (msg.type === 'BRIDGE_READY') console.log('[Games] Bridge ready ✓');
      if (msg.type === 'GAME_OVER')    handleGameOver(Number(msg.score) || 0);
      if (msg.type === 'RETRY_GAME')   handleRetry();
    } catch (err) { console.warn('[Games] Bad native message:', e.nativeEvent.data); }
  }, [handleGameOver, handleRetry]);

  /* ── Handle messages from bridge.js (web iframe) ── */
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e: MessageEvent) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (!data || !data.type) return;
        console.log('[Games][web] iframe message:', JSON.stringify(data));
        if (data.type === 'BRIDGE_READY') console.log('[Games][web] Bridge ready ✓');
        if (data.type === 'GAME_OVER')    handleGameOver(Number(data.score) || 0);
        if (data.type === 'RETRY_GAME')   handleRetry();
      } catch { /* ignore non-JSON */ }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [handleGameOver, handleRetry]);

  /* ── Android hardware back ── */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase !== 'game') { setPhase('game'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [phase]);

  /* ── Render ── */
  const renderGameView = () => {
    if (Platform.OS === 'web') {
      return (
        <iframe
          src={GAME_URL}
          title="WeaponMaster"
          style={{ flex: 1, border: 'none', width: '100%', height: '100%' } as any}
          allow="autoplay"
        />
      );
    }
    return (
      <WebView
        ref={wvRef}
        source={{ uri: GAME_URL }}
        style={{ flex: 1 }}
        onMessage={onNativeMessage}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        originWhitelist={['*']}
        startInLoadingState
        renderLoading={() => (
          <View style={S.loader}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.loaderTxt}>Loading…</Text>
          </View>
        )}
        containerStyle={{ flex: 1 }}
      />
    );
  };

  const adPlaying = phase === 'retry_ad' || phase === 'claim_ad' || phase === 'double_ad';

  return (
    <View style={S.root}>
      {renderGameView()}

      {/* ── PT badge ─────────────────────────────────── */}
      <View style={[S.badge, { top: TOP + 8 }]} pointerEvents="none">
        <Ionicons name="flash" size={13} color={Colors.gold} />
        <Text style={S.badgeTxt}>{powerTokens} PT</Text>
      </View>

      {/* ══════════════ EXIT MODAL ═══════════════════ */}
      <Modal visible={phase === 'exit_modal'} transparent animationType="slide">
        <View style={S.overlay}>
          <View style={S.card}>
            <Text style={S.title}>GAME OVER</Text>

            <View style={S.row}>
              <Text style={S.muted}>Your Score</Text>
              <Text style={S.bigNum}>{score}</Text>
            </View>
            <View style={S.sep} />
            <View style={S.row}>
              <Ionicons name="flash" size={18} color={Colors.gold} />
              <Text style={S.ptNum}>{score} PT</Text>
              <Text style={S.muted}>1 score = 1 PT</Text>
            </View>

            {/* Retry — no tokens */}
            <Pressable style={S.retryBtn} onPress={handleRetry}>
              <Ionicons name="refresh-circle-outline" size={20} color={Colors.text} />
              <Text style={S.retryTxt}>Retry (watch ad, no tokens)</Text>
            </Pressable>

            {/* Double — rewarded */}
            {score > 0 && (
              <Pressable style={S.doubleBtn} onPress={handleDouble}>
                <Ionicons name="play-circle" size={20} color="#fff" />
                <Text style={S.doubleTxt}>Watch Ad → Get {score * 2} PT (2×)</Text>
              </Pressable>
            )}

            {/* Claim — interstitial */}
            <Pressable style={S.claimBtn} onPress={handleClaim}>
              <Text style={S.claimTxt}>Claim {score} PT</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ══════════════ AD MODAL ═════════════════════ */}
      <Modal visible={adPlaying} transparent animationType="fade">
        <View style={S.adFull}>
          <View style={S.adCard}>
            <View style={S.adBar}>
              <Text style={S.adNetTxt}>{NET_LABEL[adNet]}</Text>
              {adTimer > 0 && (
                <View style={S.timerPill}><Text style={S.timerTxt}>{adTimer}s</Text></View>
              )}
            </View>
            <View style={S.adBody}>
              <Ionicons
                name={phase === 'double_ad' ? 'gift-outline' : 'megaphone-outline'}
                size={56}
                color={phase === 'double_ad' ? Colors.gold : 'rgba(255,255,255,0.18)'}
              />
              <Text style={[S.adLabel, phase === 'double_ad' && { color: Colors.gold }]}>
                {phase === 'double_ad' ? 'Rewarded Video' : 'Advertisement'}
              </Text>
              <Text style={S.adSub}>
                {phase === 'retry_ad'  ? 'Resuming game after ad…' :
                 phase === 'claim_ad'  ? 'Claiming your tokens…'  :
                                         `Watch to earn ${score * 2} PT (2×)`}
              </Text>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══════════════ SAVING ═══════════════════════ */}
      <Modal visible={phase === 'saving'} transparent animationType="fade">
        <View style={S.overlay}>
          <View style={S.card}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.muted}>Saving to database…</Text>
          </View>
        </View>
      </Modal>

      {/* ══════════════ REWARD ═══════════════════════ */}
      <Modal visible={phase === 'reward'} transparent animationType="fade">
        <View style={S.overlay}>
          <View style={S.card}>
            <Text style={{ fontSize: 48 }}>🎉</Text>
            <Text style={S.title}>+{earned} PT</Text>
            <Text style={S.muted}>New balance: {powerTokens} PT</Text>
            <Pressable style={S.claimBtn} onPress={reloadGame}>
              <Text style={S.claimTxt}>Play Again</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* ─── Styles ──────────────────────────────────────────────────────────────── */
const S = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#000' },

  loader: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0a1f1c', alignItems: 'center', justifyContent: 'center', gap: 12 },
  loaderTxt: { color: Colors.textMuted, fontFamily: 'Inter_500Medium', fontSize: 14 },

  badge: { position: 'absolute', right: 14, flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, zIndex: 99 },
  badgeTxt: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.gold },

  // Modals
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center' },
  card: { backgroundColor: '#0d1a17', borderRadius: 24, padding: 28, width: SW * 0.86,
    alignItems: 'center', gap: 14, borderWidth: 1, borderColor: 'rgba(244,196,48,0.2)' },
  title:  { fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.text, letterSpacing: 2 },
  row:    { flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%', justifyContent: 'space-between' },
  bigNum: { fontFamily: 'Inter_700Bold', fontSize: 38, color: Colors.text },
  ptNum:  { fontFamily: 'Inter_700Bold', fontSize: 28, color: Colors.gold },
  muted:  { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
  sep:    { width: '100%', height: 1, backgroundColor: 'rgba(255,255,255,0.07)' },

  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingVertical: 13, borderRadius: 28, width: '100%' },
  retryTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text },

  doubleBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
    backgroundColor: '#7c3aed', paddingVertical: 14, borderRadius: 28, width: '100%' },
  doubleTxt: { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#fff', letterSpacing: 0.4 },

  claimBtn: { backgroundColor: Colors.gold, paddingVertical: 14, borderRadius: 28, width: '100%', alignItems: 'center' },
  claimTxt: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 0.5 },

  // Ad overlay
  adFull: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  adCard: { width: SW * 0.92, backgroundColor: '#111', borderRadius: 16, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  adBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10, backgroundColor: 'rgba(255,255,255,0.04)' },
  adNetTxt: { fontFamily: 'Inter_500Medium', fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: 1 },
  timerPill: { backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  timerTxt:  { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#fff' },
  adBody: { height: SH * 0.42, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 24 },
  adLabel: { fontFamily: 'Inter_700Bold', fontSize: 18, color: 'rgba(255,255,255,0.5)', letterSpacing: 1 },
  adSub:   { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.32)', textAlign: 'center' },
});
