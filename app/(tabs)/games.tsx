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
import { showInterstitialAd, showRewardedAd } from '@/lib/nativeAds';

// ─── pbId request header helper ───────────────────────────────────────────────
// Every server call includes X-PB-ID so the server always knows which user
function pbHeaders(pbId: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'X-PB-ID': pbId };
}

let WebView: any = null;
if (Platform.OS !== 'web') {
  WebView = require('react-native-webview').WebView;
}

const { width: SW, height: SH } = Dimensions.get('window');
const BASE        = getApiUrl();
const GAME_URL    = `${BASE}/arcade/index.html`;
const GAME_DATA   = (pbId: string) => `${BASE}/api/app/game/data/${pbId}`;
const SYNC_SCORE  = `${BASE}/api/app/game/sync-score`;
const SETTINGS_URL = `${BASE}/api/app/settings`;

/* ─── Ad types ────────────────────────────────────────────────────────────── */
type AdNetwork = 'admob' | 'unity' | 'applovin';
interface AdSettings {
  showAds: boolean; activeAdNetwork: string;
  admobUnitId: string; applovinRewardedId: string;
  applovinSdkKey: string; unityGameId: string; unityRewardedId: string;
}
const AD_DEFAULT: AdSettings = {
  showAds: false, activeAdNetwork: '',
  admobUnitId: '', applovinRewardedId: '', applovinSdkKey: '', unityGameId: '', unityRewardedId: '',
};
function networkOrder(active: string): AdNetwork[] {
  const k = (active || '').toLowerCase();
  const prio: AdNetwork | null =
    k.includes('admob')   ? 'admob'    :
    k.includes('unity')   ? 'unity'    :
    (k.includes('applovin') || k.includes('max')) ? 'applovin' : null;
  const all: AdNetwork[] = ['admob', 'unity', 'applovin'];
  return prio ? [prio, ...all.filter(n => n !== prio)] : all;
}


/* ─── Game data from server ───────────────────────────────────────────────── */
interface GameData {
  power_tokens: number;
  collected_tomatoes: number;
  last_session_score: number;
  total_accumulated_score: number;
}

/* ─── Phase state machine ─────────────────────────────────────────────────── */
type Phase = 'game' | 'exit_modal' | 'retry_ad' | 'claim_ad' | 'double_ad' | 'saving' | 'reward';
const NET_LABEL: Record<AdNetwork, string> = { admob: 'AdMob', unity: 'Unity Ads', applovin: 'AppLovin MAX' };

/* ─── Component ───────────────────────────────────────────────────────────── */
export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { addPowerTokens, powerTokens } = useWallet();
  const { pbUser, refreshBalance } = useAuth();

  const wvRef     = useRef<any>(null);
  const adCfg     = useRef<AdSettings>(AD_DEFAULT);
  const netQueue  = useRef<AdNetwork[]>(['admob', 'unity', 'applovin']);
  const netIdx    = useRef(0);
  const scoreRef  = useRef(0);
  const pbIdRef   = useRef<string>('');
  const gameDataRef = useRef<GameData | null>(null);

  const [phase,      setPhase]      = useState<Phase>('game');
  const [score,      setScore]      = useState(0);
  const [earned,     setEarned]     = useState(0);
  const [adNet,      setAdNet]      = useState<AdNetwork>('admob');
  const [adTimer,    setAdTimer]    = useState(0);
  const [gameStats,  setGameStats]  = useState<GameData | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const TOP = Platform.OS === 'web' ? 67 : insets.top;

  /* ── Store pbId when auth resolves ── */
  useEffect(() => {
    if (pbUser?.pbId) {
      pbIdRef.current = pbUser.pbId;
      console.log('[Games] pbId set:', pbUser.pbId);
    }
  }, [pbUser]);

  /* ── Load ad settings ── */
  useEffect(() => {
    fetch(SETTINGS_URL)
      .then(r => r.json())
      .then(s => {
        adCfg.current = { ...AD_DEFAULT, ...s };
        netQueue.current = networkOrder(s.activeAdNetwork || '');
        console.log('[Games] Settings loaded:', JSON.stringify(adCfg.current));
        console.log('[Games] Ad network order:', netQueue.current);
      })
      .catch(err => console.warn('[Games] Settings fetch failed:', err));
  }, []);

  /* ── Fetch game data from server for this user ── */
  const fetchGameData = useCallback(async (pbId: string) => {
    if (!pbId) return;
    try {
      console.log('[Games] Fetching game data for pbId:', pbId);
      const res = await fetch(GAME_DATA(pbId), { headers: { 'X-PB-ID': pbId } });
      const data: GameData = await res.json();
      console.log('[Games] Game data received:', JSON.stringify(data));
      gameDataRef.current = data;
      setGameStats(data);
      return data;
    } catch (err) {
      console.warn('[Games] fetchGameData failed:', err);
      return null;
    }
  }, []);

  /* ── Load game data on mount / when pbId available ── */
  useEffect(() => {
    const pbId = pbUser?.pbId;
    if (pbId) fetchGameData(pbId);
  }, [pbUser, fetchGameData]);

  /* ── Helpers ── */
  const nextNet = () => {
    const n = netQueue.current[netIdx.current % netQueue.current.length] as AdNetwork;
    netIdx.current += 1;
    return n;
  };

  const startTimer = (s: number) => {
    setAdTimer(s);
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

  /* ── Send message into WebView / iframe ── */
  const sendToGame = useCallback((msg: object) => {
    const json = JSON.stringify(msg);
    console.log('[Games] →game:', json);
    if (Platform.OS !== 'web') {
      wvRef.current?.injectJavaScript(
        `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(json)}}));true;`
      );
    } else {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="WeaponMaster"]');
      frame?.contentWindow?.postMessage(json, '*');
    }
  }, []);

  /* ── Reload the game ── */
  const reloadGame = useCallback(() => {
    console.log('[Games] Reloading game');
    scoreRef.current = 0; setScore(0); setEarned(0); setPhase('game');
    if (Platform.OS !== 'web') { wvRef.current?.reload(); }
    else {
      const f = document.querySelector<HTMLIFrameElement>('iframe[title="WeaponMaster"]');
      if (f) { const s = f.src; f.src = ''; f.src = s; }
    }
  }, []);

  /* ── Bridge ready → inject server data into C3 ── */
  const handleBridgeReady = useCallback(() => {
    console.log('[Games] Bridge ready — injecting game state');
    const pbId = pbIdRef.current;
    const buildInject = (data: GameData) => ({
      type:              'INJECT_VARS',
      pbId,                                              // stored in window.__shibGameState.pbId
      powerTokens:       data.power_tokens,
      collectedTomatoes: data.collected_tomatoes,        // number — from PocketBase number field
      lastSessionScore:  data.last_session_score,
      totalScore:        data.total_accumulated_score,
    });
    const data = gameDataRef.current;
    if (data) {
      sendToGame(buildInject(data));
    } else {
      if (pbId) {
        fetchGameData(pbId).then(d => {
          if (d) sendToGame(buildInject(d));
        });
      }
    }
  }, [sendToGame, fetchGameData]);

  /* ── Sync score to server on game-over ──────────────────────────────────────
   *  score              : C3 score global (read by bridge)
   *  clientTomatoes     : accumulated tomatoes value sent by the bridge's GAME_OVER
   *                       postMessage — always a NUMBER, never a string.
   *                       Server uses it directly; no string coercion on either end.
   * ────────────────────────────────────────────────────────────────────────── */
  const syncScore = useCallback(async (score: number, clientTomatoes?: number) => {
    const pbId = pbIdRef.current;
    if (!pbId) { console.warn('[Games] syncScore: no pbId'); return; }
    try {
      // Guarantee numbers — parseInt to strip any accidental floats/strings
      const safeScore    = Math.max(0, Math.round(Number(score) || 0));
      const safeTomatoes = typeof clientTomatoes === 'number'
                         ? Math.max(0, Math.round(clientTomatoes))
                         : undefined;
      const body: Record<string, number | string> = { pbId, score: safeScore };
      if (safeTomatoes !== undefined) body.collected_tomatoes = safeTomatoes;

      console.log(`[Games] syncScore → pbId=${pbId} score=${safeScore} collected_tomatoes=${safeTomatoes ?? 'server-computed'}`);
      const res = await fetch(SYNC_SCORE, {
        method: 'POST',
        headers: pbHeaders(pbId),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      console.log('[Games] sync-score response:', JSON.stringify(data));
      if (data.success) {
        // Both values come back as numbers from the server
        setGameStats(prev => prev ? {
          ...prev,
          last_session_score: Number(data.last_session_score),
          collected_tomatoes: Number(data.collected_tomatoes),
        } : prev);
      }
    } catch (err) {
      console.error('[Games] syncScore FAILED:', err);
    }
  }, []);

  /* ── GAME OVER — called by both native WebView onMessage and web iframe ── */
  const handleGameOver = useCallback((rawScore: number, rawTomatoes?: number) => {
    const s = Math.max(0, Math.round(Number(rawScore) || 0));
    const t = rawTomatoes !== undefined ? Math.max(0, Math.round(Number(rawTomatoes) || 0)) : undefined;
    console.log(`[Games] GAME_OVER — score=${s} collected_tomatoes=${t ?? 'N/A (server will compute)'}`);
    scoreRef.current = s;
    setScore(s);
    setPhase('exit_modal');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Immediately POST to sync-score with BOTH values as numbers
    syncScore(s, t);
  }, [syncScore]);

  /* ── RETRY (Circle) → interstitial → reload ── */
  const handleRetry = useCallback(() => {
    const net = nextNet();
    setAdNet(net); setPhase('retry_ad'); startTimer(3);
    console.log('[Games] RETRY — interstitial via', net);
    showInterstitialAd(net, adCfg.current, () => {
      stopTimer();
      console.log('[Games] Retry ad done — reloading');
      reloadGame();
    });
  }, [reloadGame]);

  /* ── CLAIM → interstitial → add score PT → reset last_session_score ── */
  const handleClaim = useCallback(async () => {
    const net = nextNet();
    setAdNet(net); setPhase('claim_ad'); startTimer(3);
    console.log('[Games] CLAIM — interstitial via', net, 'score=', scoreRef.current);
    showInterstitialAd(net, adCfg.current, async () => {
      stopTimer();
      setPhase('saving');
      const pts = scoreRef.current;
      try {
        console.log(`[Games] Adding ${pts} PT to PocketBase…`);
        await addPowerTokens(pts, 'knife_hit');
        console.log(`[Games] Claimed ${pts} PT — PocketBase updated`);
        // Force PT badge to refresh immediately
        await refreshBalance();
        console.log('[Games] refreshBalance() done after claim');
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Refresh game stats to reflect reset last_session_score
        if (pbIdRef.current) fetchGameData(pbIdRef.current);
      } catch (err) {
        console.error('[Games] addPowerTokens FAILED:', err);
        await refreshBalance().catch(() => {});
        setEarned(pts); setPhase('reward');
      }
    });
  }, [addPowerTokens, fetchGameData, refreshBalance]);

  /* ── DOUBLE (2×) → rewarded → add score×2 PT ── */
  const handleDouble = useCallback(async () => {
    const net = nextNet();
    setAdNet(net); setPhase('double_ad'); startTimer(5);
    console.log('[Games] DOUBLE — rewarded via', net, 'score=', scoreRef.current);
    // showRewardedAd: Expo Go → simulated; custom build → native AdMob/Unity/AppLovin SDK
    showRewardedAd(net, adCfg.current, async (watched) => {
      stopTimer();
      if (!watched) { setPhase('exit_modal'); return; }
      setPhase('saving');
      const pts = scoreRef.current * 2;
      try {
        console.log(`[Games] Adding ${pts} PT (2×) to PocketBase…`);
        await addPowerTokens(pts, 'knife_hit');
        console.log(`[Games] Double claimed ${pts} PT — PocketBase updated`);
        // Force PT badge to refresh immediately
        await refreshBalance();
        console.log('[Games] refreshBalance() done after double');
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (pbIdRef.current) fetchGameData(pbIdRef.current);
      } catch (err) {
        console.error('[Games] addPowerTokens FAILED:', err);
        await refreshBalance().catch(() => {});
        setEarned(pts); setPhase('reward');
      }
    });
  }, [addPowerTokens, fetchGameData, refreshBalance]);

  /* ── Handle native WebView messages ─────────────────────────────────────────
   *  GAME_OVER payload from bridge.js:
   *    { type: 'GAME_OVER', score: <number>, collected_tomatoes: <number>, pb_id: <string> }
   *  Both score and collected_tomatoes are JavaScript numbers — not strings.
   * ────────────────────────────────────────────────────────────────────────── */
  const onNativeMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      console.log('[Games] native msg:', JSON.stringify(msg));
      if (msg.type === 'BRIDGE_READY') {
        handleBridgeReady();
      }
      if (msg.type === 'GAME_OVER') {
        // Extract score and collected_tomatoes as numbers — bridge sends both
        const score    = Number(msg.score)              || 0;
        const tomatoes = Number(msg.collected_tomatoes) || 0;
        console.log(`[Games][onMessage] GAME_OVER score=${score} collected_tomatoes=${tomatoes}`);
        handleGameOver(score, tomatoes);
      }
      // RETRY_REQUEST = sprite14 clicked in C3 death screen → interstitial → reload
      if (msg.type === 'RETRY_REQUEST' || msg.type === 'RETRY_GAME') {
        console.log('[Games][onMessage] RETRY_REQUEST — showing interstitial then reload');
        handleRetry();
      }
      if (msg.type === 'INJECT_DONE') console.log('[Games] C3 inject confirmed:', JSON.stringify(msg));
    } catch { /* ignore non-JSON */ }
  }, [handleBridgeReady, handleGameOver, handleRetry]);

  /* ── Handle web iframe messages ── */
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const h = (e: MessageEvent) => {
      try {
        const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (!msg?.type) return;
        console.log('[Games][web] iframe msg:', JSON.stringify(msg));
        if (msg.type === 'BRIDGE_READY') handleBridgeReady();
        if (msg.type === 'GAME_OVER') {
          const score    = Number(msg.score)              || 0;
          const tomatoes = Number(msg.collected_tomatoes) || 0;
          console.log(`[Games][web][onMessage] GAME_OVER score=${score} collected_tomatoes=${tomatoes}`);
          handleGameOver(score, tomatoes);
        }
        // RETRY_REQUEST = sprite14 clicked → interstitial → reload (no token modal)
        if (msg.type === 'RETRY_REQUEST' || msg.type === 'RETRY_GAME') {
          console.log('[Games][web][onMessage] RETRY_REQUEST — showing interstitial then reload');
          handleRetry();
        }
        if (msg.type === 'INJECT_DONE')  console.log('[Games][web] C3 inject confirmed:', JSON.stringify(msg));
      } catch { /* ignore non-JSON */ }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [handleBridgeReady, handleGameOver, handleRetry]);

  /* ── Android back button ── */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase !== 'game') { setPhase('game'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [phase]);

  /* ── Render game view ── */
  const renderGame = () => {
    if (Platform.OS === 'web') {
      return (
        <iframe src={GAME_URL} title="WeaponMaster"
          style={{ flex: 1, border: 'none', width: '100%', height: '100%' } as any}
          allow="autoplay" />
      );
    }
    return (
      <WebView ref={wvRef} source={{ uri: GAME_URL }} style={{ flex: 1 }}
        onMessage={onNativeMessage}
        javaScriptEnabled domStorageEnabled allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false} mixedContentMode="always"
        originWhitelist={['*']} startInLoadingState
        renderLoading={() => (
          <View style={S.loader}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.loaderTxt}>Loading game…</Text>
          </View>
        )}
        containerStyle={{ flex: 1 }} />
    );
  };

  const adPlaying = phase === 'retry_ad' || phase === 'claim_ad' || phase === 'double_ad';

  return (
    <View style={S.root}>
      {renderGame()}

      {/* ── PT badge ── */}
      <View style={[S.badge, { top: TOP + 8 }]} pointerEvents="none">
        <Ionicons name="flash" size={13} color={Colors.gold} />
        <Text style={S.badgeTxt}>{powerTokens} PT</Text>
      </View>

      {/* ══ EXIT MODAL ══════════════════════════════════ */}
      <Modal visible={phase === 'exit_modal'} transparent animationType="slide">
        <View style={S.overlay}>
          <View style={S.card}>
            <Text style={S.title}>GAME OVER</Text>

            <View style={S.row}>
              <Text style={S.muted}>Score</Text>
              <Text style={S.bigNum}>{score}</Text>
            </View>

            {gameStats && (
              <View style={S.statsBox}>
                <StatRow label="High Score (All-time)" value={gameStats.total_accumulated_score} gold />
                <StatRow label="Total Tomatoes" value={gameStats.collected_tomatoes} />
                <StatRow label="Wallet PT" value={powerTokens} />
              </View>
            )}

            <View style={S.sep} />

            {/* Retry — no tokens */}
            <Pressable style={S.retryBtn} onPress={handleRetry}>
              <Ionicons name="refresh-circle-outline" size={18} color={Colors.textMuted} />
              <Text style={S.retryTxt}>Retry (no tokens)</Text>
            </Pressable>

            {/* Double — rewarded ad */}
            {score > 0 && (
              <Pressable style={S.doubleBtn} onPress={handleDouble}>
                <Ionicons name="play-circle" size={18} color="#fff" />
                <Text style={S.doubleTxt}>Watch Ad  →  {score * 2} PT (2×)</Text>
              </Pressable>
            )}

            {/* Claim — interstitial */}
            <Pressable style={S.claimBtn} onPress={handleClaim}>
              <Text style={S.claimTxt}>Claim {score} PT</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ══ AD MODAL ════════════════════════════════════ */}
      <Modal visible={adPlaying} transparent animationType="fade">
        <View style={S.adFull}>
          <View style={S.adCard}>
            <View style={S.adBar}>
              <Text style={S.adNetTxt}>{NET_LABEL[adNet]}</Text>
              {adTimer > 0 && <View style={S.timerPill}><Text style={S.timerTxt}>{adTimer}s</Text></View>}
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
                {phase === 'retry_ad' ? 'Resuming game…' :
                 phase === 'claim_ad' ? 'Preparing your reward…' :
                 `Earn ${score * 2} PT for watching`}
              </Text>
              <Text style={S.adHint}>Network: {NET_LABEL[adNet]}</Text>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══ SAVING ══════════════════════════════════════ */}
      <Modal visible={phase === 'saving'} transparent animationType="fade">
        <View style={S.overlay}>
          <View style={S.card}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.muted}>Updating database…</Text>
          </View>
        </View>
      </Modal>

      {/* ══ REWARD ══════════════════════════════════════ */}
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

/* ── Stat row helper ── */
function StatRow({ label, value, gold }: { label: string; value: number; gold?: boolean }) {
  return (
    <View style={S.statRow}>
      <Text style={S.statLabel}>{label}</Text>
      <Text style={[S.statVal, gold && { color: Colors.gold }]}>{value}</Text>
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

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.86)', alignItems: 'center', justifyContent: 'center' },
  card: { backgroundColor: '#0d1a17', borderRadius: 24, padding: 26, width: SW * 0.87,
    alignItems: 'center', gap: 12, borderWidth: 1, borderColor: 'rgba(244,196,48,0.18)' },
  title:  { fontFamily: 'Inter_700Bold', fontSize: 24, color: Colors.text, letterSpacing: 2 },
  row:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' },
  bigNum: { fontFamily: 'Inter_700Bold', fontSize: 36, color: Colors.text },
  muted:  { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
  sep:    { width: '100%', height: 1, backgroundColor: 'rgba(255,255,255,0.07)' },

  statsBox: { width: '100%', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 12, gap: 6 },
  statRow:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statLabel: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
  statVal:   { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text },

  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingVertical: 12, borderRadius: 28, width: '100%' },
  retryTxt: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textMuted },

  doubleBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
    backgroundColor: '#7c3aed', paddingVertical: 14, borderRadius: 28, width: '100%' },
  doubleTxt: { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#fff', letterSpacing: 0.4 },

  claimBtn: { backgroundColor: Colors.gold, paddingVertical: 14, borderRadius: 28, width: '100%', alignItems: 'center' },
  claimTxt: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 0.5 },

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
  adHint:  { fontFamily: 'Inter_400Regular', fontSize: 11, color: 'rgba(255,255,255,0.18)', textAlign: 'center' },
});
