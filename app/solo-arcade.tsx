/* ─────────────────────────────────────────────────────────────────────────────
 * Solo Arcade — generic screen for Flappy Bounce, Fruit Cut, Color Rush.
 *
 * Architecture:
 *   game (arcade-sdk.js) → RN : ARCADE_READY / ARCADE_SCORE / ARCADE_OUT
 *   RN → game WebView      : ARCADE_MATCH_START{lives} / ARCADE_FREEZE / ARCADE_END
 *   RN ↔ server (ws/game)  : GAME_START{gameId} / SESSION_READY / GAME_OVER / COMMITTED
 *
 * The game is loaded WITHOUT ?arcade=1 so it starts in offline/practice mode
 * (arcade-sdk: inMatch=false → no score events). A "Connecting…" overlay blocks
 * interaction. Once the server confirms SESSION_READY, we inject ARCADE_MATCH_START
 * which flips inMatch=true inside the SDK and arms live scoring.
 *
 * Money is 100 % server-authoritative: the server converts raw game score → PT
 * using the per-game formula stored in SOLO_GAME_SPECS and validates against a
 * realistic PT/sec rate cap. The client only shows a local PT estimate for UX.
 * ───────────────────────────────────────────────────────────────────────────── */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, Dimensions, Modal, Pressable,
  ActivityIndicator, Platform, BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useWallet } from '@/context/WalletContext';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { getApiUrl } from '@/lib/query-client';
import Constants from 'expo-constants';
import Colors from '@/constants/colors';
import { useAds } from '@/context/AdContext';
import { AdMobBanner, BANNERS_AVAILABLE, BANNER_HEIGHT } from '@/components/StickyBannerAd';

let WebView: any = null;
if (Platform.OS !== 'web') {
  WebView = require('react-native-webview').WebView;
}

const { width: SW, height: SH } = Dimensions.get('window');

// ─── Per-game config (mirrors SOLO_GAME_SPECS on the server) ────────────────
const GAME_META: Record<string, {
  name: string;
  url: string;
  lives: number;
  maxRaw: number;
  ptMultiplier: number;
  maxPT: number;
  formulaLabel: string;
}> = {
  flappy: {
    name: 'Flappy Bounce',
    url:  'https://webcod.in/flappy/index.html',
    lives: 1,
    maxRaw: 120,
    ptMultiplier: 15,
    maxPT: 1800,
    formulaLabel: 'score × 15 PT',
  },
  fruitcut: {
    name: 'Fruit Cut',
    url:  'https://webcod.in/fruitcut/index.html',
    lives: 3,
    maxRaw: 4000,
    ptMultiplier: 0.5,
    maxPT: 2000,
    formulaLabel: 'score × 50% PT',
  },
  color: {
    name: 'Color Rush',
    url:  'https://webcod.in/color/index.html',
    lives: 1,
    maxRaw: 100,
    ptMultiplier: 20,
    maxPT: 2000,
    formulaLabel: 'score × 20 PT',
  },
};

const DEFAULT_GAME_ID = 'flappy';
const SESSION_SECONDS     = 180;
const WEBVIEW_MAX_RETRIES = 3;
// Per-game hard time limit (ms). When the player taps Play and the first
// ARCADE_SCORE arrives, this timer starts. When it fires the session ends
// exactly as if the session timer expired. Games without an entry are unbounded
// (only the 3-minute WS session cap applies).
const GAME_DURATION_MS: Partial<Record<string, number>> = { color: 90_000 };
const RETRY_DELAYS = [1500, 2500, 4000];

type Phase = 'game' | 'summary' | 'double_ad' | 'saving' | 'reward';
type GameOverReason = 'time' | 'death' | 'limit';

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// Client-side PT estimate (display only — server is authoritative)
function estimatePT(gameId: string, rawScore: number): number {
  const m = GAME_META[gameId];
  if (!m) return 0;
  return Math.min(Math.floor(rawScore * m.ptMultiplier), m.maxPT);
}

export default function SoloArcadeScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ gameId?: string }>();
  const gameId   = GAME_META[params.gameId ?? ''] ? (params.gameId ?? DEFAULT_GAME_ID) : DEFAULT_GAME_ID;
  const meta     = GAME_META[gameId];

  const { powerTokens } = useWallet();
  const { pbUser, refreshBalance } = useAuth();
  const { showGameInterstitial, showRewarded } = useAds();

  const wvRef            = useRef<any>(null);
  const wsRef            = useRef<WebSocket | null>(null);
  const pbIdRef          = useRef('');
  const matchIdRef       = useRef('');
  const serverPTRef      = useRef(0);
  const liveScoreRef     = useRef(0);
  const sessionStartRef  = useRef(0);
  const gameOverFiredRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const claimInFlightRef = useRef(false);
  const sessionTimerRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameTimerRef          = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameDurationStartedRef = useRef(false);
  // Dynamic spec refs — overwritten by server fetch on mount; fallback = hardcoded GAME_META
  const ptMultiplierRef = useRef(meta.ptMultiplier);
  const maxPTRef        = useRef(meta.maxPT);
  const retryTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef    = useRef(0);

  const [wvKey,         setWvKey]         = useState(0);
  const [phase,         setPhase]         = useState<Phase>('game');
  const [liveScore,     setLiveScore]     = useState(0);
  const [ptEstimate,    setPtEstimate]    = useState(0);
  const [dynMaxPT,      setDynMaxPT]      = useState(meta.maxPT);
  const [serverPT,      setServerPT]      = useState(0);
  const [earned,        setEarned]        = useState(0);
  const [sessionTime,   setSessionTime]   = useState(SESSION_SECONDS);
  const [sessionActive, setSessionActive] = useState(false);
  const [wsConnecting,  setWsConnecting]  = useState(false);
  const [overReason,    setOverReason]    = useState<GameOverReason>('death');
  const [gameError,     setGameError]     = useState(false);
  const [isAutoRetrying, setIsAutoRetrying] = useState(false);
  const [actionsLocked, setActionsLocked] = useState(false);
  const [claimLoading,  setClaimLoading]  = useState(false);
  const [claimError,    setClaimError]    = useState<string | null>(null);

  const TOP    = Platform.OS === 'web' ? 10 : insets.top;
  const HUDTOP = TOP + 4;

  useEffect(() => {
    if (pbUser?.pbId) pbIdRef.current = pbUser.pbId;
  }, [pbUser]);

  useEffect(() => () => {
    if (sessionTimerRef.current) clearInterval(sessionTimerRef.current);
    if (gameTimerRef.current)    clearTimeout(gameTimerRef.current);
    if (retryTimerRef.current)   clearTimeout(retryTimerRef.current);
    closeWs();
  }, []);

  // Fetch server-side spec so the live counter matches what the server will award
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = new URL('/api/app/solo-game-specs', getApiUrl()).href;
        const res = await globalThis.fetch(url);
        if (!res.ok || cancelled) return;
        const specs: Record<string, { ptMultiplier: number; maxPT: number }> = await res.json();
        const s = specs[gameId];
        if (s) {
          ptMultiplierRef.current = s.ptMultiplier;
          maxPTRef.current        = s.maxPT;
          setDynMaxPT(s.maxPT);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [gameId]);

  /* ── WS helpers ── */
  const closeWs = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
  }, []);

  const wsSend = useCallback((obj: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify(obj)); } catch {}
    }
  }, []);

  /* ── Send message INTO the WebView / iframe ── */
  const sendToGame = useCallback((msg: object) => {
    const json = JSON.stringify(msg);
    if (Platform.OS !== 'web') {
      wvRef.current?.injectJavaScript(
        `window.__arcadeHostMessage && window.__arcadeHostMessage(${JSON.stringify(json)});true;`
      );
    } else {
      const frame = document.querySelector<HTMLIFrameElement>(`iframe[title="SoloArcade"]`);
      frame?.contentWindow?.postMessage(json, '*');
    }
  }, []);

  /* ── Stop the session timer (also clears game-duration timer) ── */
  const stopSessionTimer = useCallback(() => {
    if (sessionTimerRef.current) { clearInterval(sessionTimerRef.current); sessionTimerRef.current = null; }
    if (gameTimerRef.current)    { clearTimeout(gameTimerRef.current);  gameTimerRef.current = null; }
    gameDurationStartedRef.current = false;
    sessionActiveRef.current = false;
  }, []);

  /* ── Game over — unified handler ── */
  const handleGameOver = useCallback((finalPT: number, reason: GameOverReason) => {
    if (gameOverFiredRef.current) return;
    gameOverFiredRef.current = true;
    stopSessionTimer();
    sessionActiveRef.current = false;
    setSessionActive(false);

    const pt = Math.max(0, Math.round(finalPT));
    serverPTRef.current = pt;
    setServerPT(pt);
    setOverReason(reason);
    setPhase('summary');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [stopSessionTimer]);

  /* ── Start 3-minute session countdown ── */
  const startSessionTimer = useCallback(() => {
    if (sessionActiveRef.current) return;
    stopSessionTimer();
    gameOverFiredRef.current = false;
    liveScoreRef.current     = 0;
    sessionActiveRef.current = true;
    sessionStartRef.current  = Date.now();
    matchIdRef.current       = '';
    claimInFlightRef.current = false;
    setActionsLocked(false);
    setClaimError(null);
    setLiveScore(0);
    setPtEstimate(0);
    setSessionTime(SESSION_SECONDS);
    setSessionActive(true);
    setClaimLoading(false);

    let remaining = SESSION_SECONDS;
    sessionTimerRef.current = setInterval(() => {
      remaining -= 1;
      setSessionTime(remaining);
      if (remaining <= 0) {
        clearInterval(sessionTimerRef.current!);
        sessionTimerRef.current = null;
        // Freeze the game and send GAME_OVER to WS (lands within the 15s server grace)
        sendToGame({ type: 'ARCADE_FREEZE' });
        const elapsed = Date.now() - sessionStartRef.current;
        wsSend({ type: 'GAME_OVER', score: liveScoreRef.current, elapsed_ms: elapsed });
        // Server will respond with COMMITTED; handleGameOver fires on that message.
        // Safety fallback: if no COMMITTED arrives in 5s, show summary with live estimate
        setTimeout(() => {
          if (!gameOverFiredRef.current) {
            handleGameOver(Math.min(Math.floor(liveScoreRef.current * ptMultiplierRef.current), maxPTRef.current), 'time');
          }
        }, 5000);
      }
    }, 1000);
  }, [stopSessionTimer, sendToGame, wsSend, gameId, handleGameOver]);

  /* ── Connect WebSocket and start match ── */
  const connectWs = useCallback(() => {
    const pbId = pbIdRef.current;
    if (!pbId) return;
    closeWs();
    setWsConnecting(true);

    let wsUrl: string;
    try {
      const apiUrl = getApiUrl();
      wsUrl = apiUrl.replace(/^http/, 'ws') + '/api/ws/game';
    } catch {
      setWsConnecting(false);
      return;
    }

    const ws = new (globalThis as any).WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type:       'GAME_START',
        pbId,
        gameId,
        appVersion: Constants.expoConfig?.version ?? '1.0.3',
      }));
    };

    ws.onmessage = (e: { data: string }) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'SESSION_READY') {
        setWsConnecting(false);
        // Arm the game: flip arcade-sdk to match mode with game-specific lives
        sendToGame({ type: 'ARCADE_MATCH_START', lives: meta.lives });
        startSessionTimer();
      }

      if (msg.type === 'COMMITTED') {
        matchIdRef.current = msg.matchId ?? '';
        const pt = Math.max(0, Number(msg.serverPT) || 0);
        if (!gameOverFiredRef.current) {
          handleGameOver(pt, sessionActiveRef.current ? 'time' : 'death');
        } else {
          // Already fired (client timer beat the WS); update PT with authoritative value
          serverPTRef.current = pt;
          setServerPT(pt);
        }
      }

      if (msg.type === 'GAME_OVER') {
        // Server auto-committed (3-min timer fired server-side)
        matchIdRef.current = msg.matchId ?? '';
        const pt = Math.max(0, Number(msg.serverPT) || 0);
        handleGameOver(pt, 'time');
      }

      if (msg.type === 'ERROR') {
        console.warn('[solo-arcade] WS error:', msg.reason);
        setWsConnecting(false);
      }
    };

    ws.onerror = () => setWsConnecting(false);
    ws.onclose = () => {};
  }, [closeWs, sendToGame, startSessionTimer, handleGameOver, gameId, meta.lives]);

  /* ── WebView load-error handler with auto-retry ── */
  const handleLoadError = useCallback(() => {
    if (retryCountRef.current < WEBVIEW_MAX_RETRIES) {
      const attempt = retryCountRef.current;
      retryCountRef.current += 1;
      setIsAutoRetrying(true);
      setGameError(false);
      const delay = RETRY_DELAYS[attempt] ?? 4000;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        setWvKey(k => k + 1);
        setIsAutoRetrying(false);
      }, delay);
    } else {
      setIsAutoRetrying(false);
      setGameError(true);
    }
  }, []);

  /* ── Reload / reset for Play Again ── */
  const reloadGame = useCallback(() => {
    stopSessionTimer();
    closeWs();
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    retryCountRef.current    = 0;
    gameOverFiredRef.current = false;
    liveScoreRef.current     = 0;
    sessionActiveRef.current = false;
    claimInFlightRef.current = false;
    matchIdRef.current       = '';
    serverPTRef.current      = 0;
    setIsAutoRetrying(false);
    setGameError(false);
    setActionsLocked(false);
    setClaimError(null);
    setLiveScore(0);
    setPtEstimate(0);
    setServerPT(0);
    setEarned(0);
    setSessionTime(SESSION_SECONDS);
    setSessionActive(false);
    setWsConnecting(false);
    setPhase('game');
    if (Platform.OS !== 'web') {
      setWvKey(k => k + 1);
    } else {
      const f = document.querySelector<HTMLIFrameElement>('iframe[title="SoloArcade"]');
      if (f) { const s = f.src; f.src = ''; f.src = s; }
    }
  }, [stopSessionTimer, closeWs]);

  /* ── CLAIM (1×) ── */
  const handleClaim = useCallback(async () => {
    if (claimInFlightRef.current) return;
    claimInFlightRef.current = true;
    setActionsLocked(true);
    setClaimError(null);
    setClaimLoading(true);

    await new Promise<void>((resolve) => { showGameInterstitial(() => resolve()); });
    setPhase('saving');

    const pts     = serverPTRef.current;
    const pbId    = pbIdRef.current;
    const matchId = matchIdRef.current || undefined;
    try {
      await api.gameReward(pbId, pts, gameId, matchId);
      await refreshBalance();
      setEarned(pts);
      setPhase('reward');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      await refreshBalance().catch(() => {});
      claimInFlightRef.current = false;
      setActionsLocked(false);
      setClaimError('Reward could not be verified by the server. Nothing was credited.');
      setPhase('summary');
    } finally {
      setClaimLoading(false);
    }
  }, [gameId, refreshBalance, showGameInterstitial]);

  /* ── DOUBLE (2×, rewarded ad) ── */
  const handleDouble = useCallback(async () => {
    if (claimInFlightRef.current) return;
    claimInFlightRef.current = true;
    setActionsLocked(true);
    setClaimError(null);
    setPhase('double_ad');

    let adToken: string | null = null;
    const pbId    = pbIdRef.current;
    const matchId = matchIdRef.current || undefined;
    if (pbId) {
      try {
        const tokenRes = await api.requestAdToken(pbId, matchId);
        adToken = tokenRes.token;
      } catch {}
    }

    showRewarded(async (watched) => {
      if (!watched) {
        claimInFlightRef.current = false;
        setActionsLocked(false);
        setPhase('summary');
        return;
      }
      setPhase('saving');
      try {
        let pts: number;
        if (adToken && pbId) {
          const claimRes = await api.claimAdToken(pbId, adToken, matchId);
          pts = claimRes.reward;
        } else {
          pts = Math.min(serverPTRef.current * 2, meta.maxPT * 2);
          await api.gameReward(pbId, pts, gameId, matchId);
        }
        await refreshBalance();
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        await refreshBalance().catch(() => {});
        claimInFlightRef.current = false;
        setActionsLocked(false);
        setClaimError('Reward could not be verified by the server. Nothing was credited.');
        setPhase('summary');
      }
    });
  }, [gameId, meta.maxPT, refreshBalance, showRewarded]);

  /* ── Unified WebView message handler ── */
  const handleWebViewMessage = useCallback((raw: string) => {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ARCADE_READY') {
      // Game page fully loaded and arcade-sdk is ready — open WS and start match
      connectWs();
    }
    if (msg.type === 'ARCADE_SCORE') {
      const s = Math.max(0, Number(msg.score) || 0);
      liveScoreRef.current = s;
      setLiveScore(s);
      setPtEstimate(Math.min(Math.floor(s * ptMultiplierRef.current), maxPTRef.current));
      // Start game-specific duration timer on the first score event (= player tapped Play).
      // Only applies to games that declare a hard time limit (currently: Color Rush 90s).
      const gameDurMs = GAME_DURATION_MS[gameId];
      if (gameDurMs && !gameDurationStartedRef.current && sessionActiveRef.current) {
        gameDurationStartedRef.current = true;
        gameTimerRef.current = setTimeout(() => {
          if (gameOverFiredRef.current) return;
          sendToGame({ type: 'ARCADE_FREEZE' });
          const elapsed = Date.now() - sessionStartRef.current;
          wsSend({ type: 'GAME_OVER', score: liveScoreRef.current, elapsed_ms: Math.max(elapsed, 1000) });
          setTimeout(() => {
            if (!gameOverFiredRef.current) {
              handleGameOver(Math.min(Math.floor(liveScoreRef.current * ptMultiplierRef.current), maxPTRef.current), 'time');
            }
          }, 5000);
        }, gameDurMs);
      }
    }
    if (msg.type === 'ARCADE_OUT') {
      if (gameOverFiredRef.current) return;
      const s = Math.max(0, Number(msg.score) || 0);
      liveScoreRef.current = s;
      // Freeze the game so its local "Play Again" screen never appears
      sendToGame({ type: 'ARCADE_END' });
      // Send final score to WS — server validates and replies with COMMITTED
      const elapsed = Date.now() - sessionStartRef.current;
      wsSend({ type: 'GAME_OVER', score: s, elapsed_ms: Math.max(elapsed, 1000) });
      // Safety fallback if no COMMITTED arrives
      setTimeout(() => {
        if (!gameOverFiredRef.current) {
          handleGameOver(Math.min(Math.floor(s * ptMultiplierRef.current), maxPTRef.current), 'death');
        }
      }, 6000);
    }
  }, [connectWs, sendToGame, wsSend, gameId, handleGameOver]);

  /* ── Native onMessage ── */
  const onNativeMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    handleWebViewMessage(e.nativeEvent.data);
  }, [handleWebViewMessage]);

  /* ── Web iframe message listener ── */
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const h = (e: MessageEvent) => {
      try {
        const raw = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
        handleWebViewMessage(raw);
      } catch {}
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [handleWebViewMessage]);

  /* ── Android back button ── */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const canLeave = phase === 'reward' || gameError || (phase === 'game' && !sessionActive);
      return !canLeave;
    });
    return () => sub.remove();
  }, [phase, gameError, sessionActive]);

  /* ── Render WebView / iframe ── */
  const renderGame = () => {
    if (Platform.OS === 'web') {
      return (
        <iframe
          src={meta.url}
          title="SoloArcade"
          style={{ flex: 1, border: 'none', width: '100%', height: '100%' } as any}
          allow="autoplay"
        />
      );
    }
    return (
      <WebView
        key={wvKey}
        ref={wvRef}
        source={{ uri: meta.url }}
        style={{ flex: 1 }}
        onMessage={onNativeMessage}
        javaScriptEnabled domStorageEnabled allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false} mixedContentMode="always"
        androidLayerType="hardware" overScrollMode="never"
        originWhitelist={['*']} startInLoadingState
        renderLoading={() => (
          <View style={S.loader}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.loaderTxt}>Loading {meta.name}…</Text>
          </View>
        )}
        renderError={() => (
          isAutoRetrying ? (
            <View style={S.loader}>
              <ActivityIndicator size="large" color={Colors.neonOrange} />
              <Text style={[S.loaderTxt, { marginTop: 12 }]}>
                Reconnecting… ({retryCountRef.current}/{WEBVIEW_MAX_RETRIES})
              </Text>
            </View>
          ) : (
            <View style={S.loader}>
              <Ionicons name="game-controller-outline" size={56} color={Colors.neonOrange} />
              <Text style={[S.loaderTxt, { marginTop: 12 }]}>Game server unavailable</Text>
            </View>
          )
        )}
        onError={() => handleLoadError()}
        onHttpError={(e: any) => {
          const status = e.nativeEvent?.statusCode;
          if (status && status >= 500) handleLoadError(); else setGameError(true);
        }}
        containerStyle={{ flex: 1 }}
      />
    );
  };

  const timeIsLow  = sessionTime <= 30 && sessionActive;
  const adPlaying  = phase === 'double_ad';
  const reasonTitle = overReason === 'time'  ? "Time's Up!"
                    : overReason === 'limit' ? '🏆 Max Score!'
                    : 'Game Over';
  const reasonSub   = overReason === 'time'  ? '3-minute session ended'
                    : overReason === 'limit' ? 'You hit the session score cap'
                    : 'Better luck next time!';

  return (
    <View style={S.root}>
      <View style={S.gameArea}>
        {renderGame()}

        {/* Back button — only when safe to leave */}
        {(phase === 'reward' || gameError || (phase === 'game' && !sessionActive && !wsConnecting)) && (
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={[S.topBadge, { top: HUDTOP, left: 14, right: undefined }]}
            testID="solo-arcade-back"
          >
            <Ionicons name="chevron-back" size={16} color={Colors.gold} />
          </Pressable>
        )}

        {/* PT badge (top-right) */}
        <View style={[S.topBadge, { top: HUDTOP }]} pointerEvents="none">
          <Ionicons name="flash" size={13} color={Colors.gold} />
          <Text style={S.badgeTxt}>{powerTokens} PT</Text>
        </View>

        {/* Connecting overlay — shown while WS handshake is in-flight */}
        {wsConnecting && !sessionActive && phase === 'game' && (
          <View style={S.connectOverlay} pointerEvents="box-none">
            <View style={S.connectCard}>
              <ActivityIndicator size="large" color={Colors.gold} />
              <Text style={S.connectTxt}>Connecting to server…</Text>
              <Text style={S.connectSub}>{meta.name}</Text>
            </View>
          </View>
        )}

        {/* Session HUD: timer + PT counter */}
        {sessionActive && phase === 'game' && (
          <View style={[S.hud, { top: HUDTOP }]} pointerEvents="none">
            <View style={[S.hudPill, timeIsLow && S.hudPillRed]}>
              <Ionicons name="timer-outline" size={12} color={timeIsLow ? '#ff5252' : Colors.textSecondary} />
              <Text style={[S.hudText, timeIsLow && S.hudTextRed]}>{formatTime(sessionTime)}</Text>
            </View>
            <View style={S.hudPill}>
              <Ionicons name="star" size={11} color={Colors.gold} />
              <Text style={S.hudText}>
                {ptEstimate}<Text style={S.hudTextMuted}>/{dynMaxPT} PT</Text>
              </Text>
            </View>
          </View>
        )}

        {/* Game error overlay */}
        {gameError && (
          <View style={S.errorOverlay}>
            <Ionicons name="game-controller-outline" size={64} color={Colors.neonOrange} />
            <Text style={S.errorTitle}>Game Unavailable</Text>
            <Text style={S.errorSub}>The game server is temporarily offline.{'\n'}Try again soon!</Text>
            <Pressable style={S.errorBtn} onPress={() => { setGameError(false); wvRef.current?.reload?.(); }}>
              <Text style={S.errorBtnTxt}>Retry</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Sticky banner ad (only during active gameplay) */}
      {BANNERS_AVAILABLE && (
        <View style={[S.bannerBar, { paddingBottom: insets.bottom }]}>
          {phase === 'game' && !gameError && <AdMobBanner />}
        </View>
      )}

      {/* ══ SUMMARY / GAME OVER ═══════════════════════════════════════════ */}
      <Modal visible={phase === 'summary'} transparent animationType="slide">
        <View style={S.overlay}>
          <View style={S.card}>
            <View style={S.summaryHeader}>
              <Text style={S.summaryIcon}>
                {overReason === 'time' ? '⏰' : overReason === 'limit' ? '🏆' : '💀'}
              </Text>
              <View>
                <Text style={S.title}>{reasonTitle}</Text>
                <Text style={S.reasonSub}>{reasonSub}</Text>
              </View>
            </View>

            <View style={S.scoreBanner}>
              <Text style={S.scoreBannerLabel}>{meta.name.toUpperCase()}</Text>
              <Text style={S.scoreBannerNum}>{serverPT} PT</Text>
            </View>

            <View style={S.statsBox}>
              <View style={S.statRow}>
                <Text style={S.statLabel}>Your PT Wallet</Text>
                <Text style={S.statVal}>{powerTokens}</Text>
              </View>
            </View>

            <View style={S.sep} />

            {serverPT > 0 && (
              <Pressable
                style={[S.doubleBtn, actionsLocked && S.dimmed]}
                onPress={handleDouble}
                disabled={actionsLocked}
              >
                <Ionicons name="play-circle" size={18} color="#fff" />
                <Text style={S.doubleTxt}>Watch Ad  →  {serverPT * 2} PT  (2×)</Text>
              </Pressable>
            )}

            <Pressable
              style={[S.claimBtn, (serverPT === 0 || actionsLocked) && S.dimmed]}
              onPress={handleClaim}
              disabled={serverPT === 0 || actionsLocked}
            >
              {claimLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={S.claimTxt}>
                  {serverPT > 0 ? `Claim  ${serverPT} PT` : 'No tokens earned'}
                </Text>
              )}
            </Pressable>

            {claimError && <Text style={S.claimErrTxt}>{claimError}</Text>}

            {(serverPT === 0 || !!claimError) && (
              <Pressable style={S.retryLink} onPress={() => router.back()}>
                <Text style={S.retryLinkTxt}>Back to Games</Text>
              </Pressable>
            )}
          </View>
        </View>
      </Modal>

      {/* ══ AD OVERLAY ════════════════════════════════════════════════════ */}
      <Modal visible={adPlaying} transparent animationType="fade">
        <View style={S.adFull}>
          <View style={S.adCard}>
            <View style={S.adBar}><Text style={S.adNetTxt}>Rewarded Video</Text></View>
            <View style={S.adBody}>
              <Ionicons name="gift-outline" size={56} color={Colors.gold} />
              <ActivityIndicator size="large" color={Colors.gold} style={{ marginTop: 4 }} />
              <Text style={[S.adLabel, { color: Colors.gold }]}>Loading Ad…</Text>
              <Text style={S.adSub}>Watch to earn {serverPT * 2} PT (2×)</Text>
              <Text style={S.adHint}>Ad provided by AdMob</Text>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══ SAVING ════════════════════════════════════════════════════════ */}
      <Modal visible={phase === 'saving'} transparent animationType="fade">
        <View style={S.overlay}>
          <View style={S.card}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.muted}>Saving tokens…</Text>
          </View>
        </View>
      </Modal>

      {/* ══ REWARD ════════════════════════════════════════════════════════ */}
      <Modal visible={phase === 'reward'} transparent animationType="fade">
        <View style={S.overlay}>
          <View style={S.card}>
            <Text style={{ fontSize: 48 }}>🎉</Text>
            <Text style={S.title}>+{earned} PT</Text>
            <Text style={S.muted}>Wallet: {powerTokens} PT</Text>
            <View style={S.sep} />
            <Pressable style={S.claimBtn} onPress={reloadGame}>
              <Text style={S.claimTxt}>Play Again</Text>
            </Pressable>
            <Pressable style={S.backBtn} onPress={() => router.back()} testID="reward-back-btn">
              <Text style={S.backTxt}>Back to Games</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const S = StyleSheet.create({
  root:      { flex: 1, backgroundColor: '#000' },
  gameArea:  { flex: 1, position: 'relative' },
  loader:    { position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  loaderTxt: { color: Colors.textSecondary, marginTop: 10, fontSize: 14 },

  topBadge: {
    position: 'absolute', right: 14, flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(10,10,15,0.75)', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 5,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.35)',
  },
  badgeTxt: { color: Colors.textPrimary, fontSize: 12, fontWeight: '700' },

  hud: {
    position: 'absolute', left: 14, right: 14,
    flexDirection: 'row', gap: 6, alignItems: 'center',
  },
  hudPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(10,10,15,0.75)', borderRadius: 12,
    paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  hudPillRed:  { borderColor: 'rgba(255,82,82,0.5)' },
  hudText:     { color: Colors.textPrimary, fontSize: 11, fontWeight: '700' },
  hudTextRed:  { color: '#ff5252' },
  hudTextMuted:{ color: Colors.textMuted },

  connectOverlay: {
    position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  connectCard: {
    alignItems: 'center', gap: 10, backgroundColor: 'rgba(18,18,26,0.95)',
    borderRadius: 20, paddingVertical: 28, paddingHorizontal: 36,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)',
  },
  connectTxt: { color: Colors.textPrimary, fontSize: 16, fontWeight: '700', marginTop: 4 },
  connectSub: { color: Colors.textSecondary, fontSize: 13 },

  errorOverlay: {
    position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.85)', gap: 12, paddingHorizontal: 32,
  },
  errorTitle: { color: Colors.textPrimary, fontSize: 22, fontWeight: '800' },
  errorSub:   { color: Colors.textSecondary, fontSize: 14, textAlign: 'center' },
  errorBtn:   { marginTop: 4, backgroundColor: Colors.neonOrange, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 14 },
  errorBtnTxt:{ color: '#fff', fontWeight: '800', fontSize: 15 },

  bannerBar: { backgroundColor: '#000', alignItems: 'center', minHeight: BANNER_HEIGHT },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.82)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: {
    width: '100%', maxWidth: 400, backgroundColor: 'rgba(18,18,26,0.98)',
    borderRadius: 24, padding: 24, alignItems: 'center', gap: 12,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.25)',
  },

  summaryHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, alignSelf: 'flex-start' },
  summaryIcon:   { fontSize: 36 },
  title:         { color: Colors.textPrimary, fontSize: 22, fontWeight: '900' },
  reasonSub:     { color: Colors.textSecondary, fontSize: 13, marginTop: 2 },

  scoreBanner:     { alignItems: 'center', paddingVertical: 12, gap: 2 },
  scoreBannerLabel:{ color: Colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  scoreBannerNum:  { color: Colors.gold, fontSize: 52, fontWeight: '900' },
  scoreBannerSub:  { color: Colors.neonOrange, fontSize: 15, fontWeight: '700' },

  statsBox:  { width: '100%', gap: 6 },
  statRow:   { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 },
  statLabel: { color: Colors.textSecondary, fontSize: 13 },
  statVal:   { color: Colors.textPrimary, fontSize: 13, fontWeight: '700' },

  sep: { width: '100%', height: 1, backgroundColor: 'rgba(255,255,255,0.08)' },

  doubleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, width: '100%',
    backgroundColor: Colors.neonOrange, borderRadius: 14, paddingVertical: 14,
    justifyContent: 'center',
  },
  doubleTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },

  claimBtn: {
    width: '100%', backgroundColor: Colors.gold, borderRadius: 14,
    paddingVertical: 14, alignItems: 'center',
  },
  claimTxt: { color: '#000', fontSize: 15, fontWeight: '800' },

  dimmed:    { opacity: 0.45 },
  claimErrTxt:{ color: '#ff5252', fontSize: 12, textAlign: 'center', marginTop: -4 },

  backBtn:   { width: '100%', paddingVertical: 10, alignItems: 'center' },
  backTxt:   { color: Colors.textSecondary, fontSize: 14, fontWeight: '600' },
  retryLink: { marginTop: -6 },
  retryLinkTxt:{ color: Colors.textMuted, fontSize: 13, textDecorationLine: 'underline' },
  muted:     { color: Colors.textSecondary, fontSize: 14, marginTop: 10 },

  adFull: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  adCard: {
    width: '100%', maxWidth: 360, backgroundColor: 'rgba(18,18,26,0.98)',
    borderRadius: 20, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(244,196,48,0.2)',
  },
  adBar:    { backgroundColor: 'rgba(244,196,48,0.12)', paddingVertical: 8, alignItems: 'center' },
  adNetTxt: { color: Colors.textMuted, fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  adBody:   { alignItems: 'center', padding: 28, gap: 8 },
  adLabel:  { fontSize: 16, fontWeight: '700' },
  adSub:    { color: Colors.textSecondary, fontSize: 14 },
  adHint:   { color: Colors.textMuted, fontSize: 11 },
});
