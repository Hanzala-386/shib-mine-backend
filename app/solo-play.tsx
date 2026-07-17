import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, Dimensions, Modal, Pressable,
  ActivityIndicator, Platform, BackHandler, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useWallet } from '@/context/WalletContext';
import { useAuth } from '@/context/AuthContext';
import { pb } from '@/lib/pocketbase';
import { api } from '@/lib/api';
import { getApiUrl } from '@/lib/query-client';
import Constants from 'expo-constants';
import Colors from '@/constants/colors';
import { useAds } from '@/context/AdContext';
import { useSecurity } from '@/context/SecurityContext';
import { AdMobBanner, BANNERS_AVAILABLE, BANNER_HEIGHT } from '@/components/StickyBannerAd';
import { TapMonitor } from '@/lib/tapMonitor';

let WebView: any = null;
if (Platform.OS !== 'web') {
  WebView = require('react-native-webview').WebView;
}

const { width: SW, height: SH } = Dimensions.get('window');

// Game assets are served from stable shared hosting (webcod.in).
// The WebSocket scoring bridge connects to Railway separately via INJECT_VARS.
const GAME_URL = 'https://webcod.in/arcade/index.html';

const SESSION_SECONDS     = 180; // 3-minute session
const SCORE_LIMIT         = 2000;
const SCORE_WARNING       = 1900;
const WEBVIEW_MAX_RETRIES = 3;   // auto-retries before showing permanent error
// Retry delays (ms) — exponential backoff for mobile data connection establishment
const RETRY_DELAYS = [1500, 2500, 4000];

interface GameData {
  power_tokens: number;
  collected_tomatoes: number;
  last_session_score: number;
  total_accumulated_score: number;
}

type Phase = 'game' | 'summary' | 'double_ad' | 'saving' | 'reward';
type GameOverReason = 'time' | 'score' | 'death';

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

export default function SoloPlayScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens } = useWallet();
  const { pbUser, refreshBalance } = useAuth();
  const { showGameInterstitial, showRewarded } = useAds();
  const { triggerAutoClicker } = useSecurity();

  const wvRef           = useRef<any>(null);
  const scoreRef           = useRef(0);        // final score at game-over
  const liveScoreRef       = useRef(0);        // live score during play (from SCORE_UPDATE)
  const sessionPeakScoreRef = useRef(0);       // highest score seen this session (never drops)
  const pbIdRef         = useRef<string>('');
  const gameDataRef     = useRef<GameData | null>(null);
  const sessionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef   = useRef(0);           // how many auto-retries have fired so far
  const gameOverFiredRef  = useRef(false);     // guard against double GAME_OVER
  const sessionActiveRef  = useRef(false);     // ref mirror of sessionActive — safe in callbacks
  const warningPulse      = useRef(new Animated.Value(1)).current;
  // Anti-replay: matchId from COMMITTED message — passed to /api/app/game/reward
  const matchIdRef        = useRef<string>('');
  // Anti-double-tap: set true the moment Claim is tapped, never cleared until phase changes
  const claimInFlightRef  = useRef(false);
  // Auto-clicker detection: tracks inter-hit intervals for CV analysis
  const tapMonitor        = useRef(new TapMonitor()).current;

  // wvKey: incrementing this forces the WebView to fully remount (= fresh network attempt)
  const [wvKey,         setWvKey]         = useState(0);
  const [phase,         setPhase]         = useState<Phase>('game');
  const [score,         setScore]         = useState(0);
  const [liveScore,     setLiveScore]     = useState(0);
  const [earned,        setEarned]        = useState(0);
  const [gameStats,     setGameStats]     = useState<GameData | null>(null);
  const [sessionTime,   setSessionTime]   = useState(SESSION_SECONDS);
  const [sessionActive, setSessionActive] = useState(false);
  const [overReason,    setOverReason]    = useState<GameOverReason>('death');
  const [gameError,     setGameError]     = useState(false);
  const [isAutoRetrying, setIsAutoRetrying] = useState(false);
  const [claimLoading,  setClaimLoading]  = useState(false);
  // Double-click lock: the FIRST tap on Claim OR 2× disables BOTH buttons
  const [actionsLocked, setActionsLocked] = useState(false);
  // Honest failure: server rejected the claim — shown on summary, no fake reward
  const [claimError,    setClaimError]    = useState<string | null>(null);

  const TOP    = Platform.OS === 'web' ? 10 : insets.top;
  const HUDTOP = TOP + 4;

  /* ── Update pbId when auth resolves ── */
  useEffect(() => {
    if (pbUser?.pbId) {
      pbIdRef.current = pbUser.pbId;
    }
  }, [pbUser]);

  /* ── Fetch game data — reads directly from PocketBase users collection ── */
  const fetchGameData = useCallback(async (pbId: string) => {
    if (!pbId) return;
    try {
      const record = await pb.collection('users').getOne(pbId, {
        fields: 'power_tokens,collected_tomatoes,last_session_score,total_accumulated_score',
      });
      const data: GameData = {
        power_tokens:            record.power_tokens ?? 0,
        collected_tomatoes:      record.collected_tomatoes ?? 0,
        last_session_score:      record.last_session_score ?? 0,
        total_accumulated_score: record.total_accumulated_score ?? 0,
      };
      gameDataRef.current = data;
      setGameStats(data);
      return data;
    } catch { return null; }
  }, []);

  useEffect(() => {
    const pbId = pbUser?.pbId;
    if (pbId) fetchGameData(pbId);
  }, [pbUser, fetchGameData]);

  useEffect(() => () => {
    if (sessionTimerRef.current) clearInterval(sessionTimerRef.current);
    if (retryTimerRef.current)   clearTimeout(retryTimerRef.current);
  }, []);

  /* ── Session countdown (2 minutes) ───────────────────────────────────────
   *  Starts when BRIDGE_READY fires. On reaching 0, forces game over.
   * ─────────────────────────────────────────────────────────────────────── */
  const stopSessionTimer = useCallback(() => {
    if (sessionTimerRef.current) { clearInterval(sessionTimerRef.current); sessionTimerRef.current = null; }
    sessionActiveRef.current = false;
  }, []);

  /* ── Warning pulse animation ── */
  const startWarningPulse = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(warningPulse, { toValue: 0.4, duration: 400, useNativeDriver: true }),
        Animated.timing(warningPulse, { toValue: 1,   duration: 400, useNativeDriver: true }),
      ])
    ).start();
  }, [warningPulse]);

  /* ── Send message into WebView / iframe ── */
  const sendToGame = useCallback((msg: object) => {
    const json = JSON.stringify(msg);
    if (Platform.OS !== 'web') {
      wvRef.current?.injectJavaScript(
        `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(json)}}));true;`
      );
    } else {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="WeaponMaster"]');
      frame?.contentWindow?.postMessage(json, '*');
    }
  }, []);

  /* ── WebView load-error handler — auto-retry with exponential backoff ────────
   *  Mobile data (4G/LTE) often fails the first connection attempt due to higher
   *  RTT and TLS handshake latency.  Instead of showing a permanent error screen,
   *  we silently retry up to WEBVIEW_MAX_RETRIES times with increasing delays.
   *  Incrementing wvKey forces a full WebView remount (= fresh network attempt).
   * ─────────────────────────────────────────────────────────────────────────── */
  const handleLoadError = useCallback(() => {
    if (retryCountRef.current < WEBVIEW_MAX_RETRIES) {
      const attempt = retryCountRef.current;
      retryCountRef.current += 1;
      setIsAutoRetrying(true);
      setGameError(false);
      const delay = RETRY_DELAYS[attempt] ?? 4000;
      console.log(`[Games] WebView load failed — retry ${retryCountRef.current}/${WEBVIEW_MAX_RETRIES} in ${delay}ms`);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        setWvKey(k => k + 1); // remount WebView with fresh connection
        setIsAutoRetrying(false);
      }, delay);
    } else {
      // All retries exhausted — show permanent error screen
      console.warn('[Games] WebView load failed after all retries');
      setIsAutoRetrying(false);
      setGameError(true);
    }
  }, []);

  /* ── Reload / reset game ── */
  const reloadGame = useCallback(() => {
    stopSessionTimer();
    // Reset retry state so the next load gets a fresh set of retries
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    retryCountRef.current = 0;
    setIsAutoRetrying(false);
    setGameError(false);
    gameOverFiredRef.current = false;
    scoreRef.current = 0;
    liveScoreRef.current = 0;
    sessionPeakScoreRef.current = 0;
    sessionActiveRef.current = false;
    claimInFlightRef.current = false;
    setActionsLocked(false);
    setClaimError(null);
    setScore(0);
    setLiveScore(0);
    setEarned(0);
    setSessionTime(SESSION_SECONDS);
    setSessionActive(false);
    setPhase('game');
    warningPulse.stopAnimation();
    warningPulse.setValue(1);
    if (Platform.OS !== 'web') {
      // Remount WebView via key so it makes a fresh network request
      setWvKey(k => k + 1);
    } else {
      const f = document.querySelector<HTMLIFrameElement>('iframe[title="WeaponMaster"]');
      if (f) { const s = f.src; f.src = ''; f.src = s; }
    }
  }, [stopSessionTimer, warningPulse]);

  /* ── GAME OVER — unified handler ─────────────────────────────────────────
   *  Called from: timer expiry, score limit (bridge), player death (bridge)
   * ─────────────────────────────────────────────────────────────────────── */
  const handleGameOver = useCallback((rawScore: number, rawTomatoes?: number, reason: GameOverReason = 'death') => {
    if (gameOverFiredRef.current) return;
    gameOverFiredRef.current = true;

    stopSessionTimer();
    sessionActiveRef.current = false;
    setSessionActive(false);

    const raw = Math.min(Math.max(0, Math.round(Number(rawScore) || 0)), SCORE_LIMIT);
    // Retain the session's highest ever score — protects against a late score=0
    // arriving from the bridge after the player had already accumulated points.
    const s = Math.max(raw, sessionPeakScoreRef.current);
    const t = rawTomatoes !== undefined ? Math.max(0, Math.round(Number(rawTomatoes) || 0)) : undefined;

    scoreRef.current = s;
    setScore(s);
    setOverReason(reason);
    setPhase('summary');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Sync score directly to PocketBase users collection in background
    const pbId = pbIdRef.current;
    if (pbId) {
      const prev = gameDataRef.current;
      const newTotalScore   = (prev?.total_accumulated_score ?? 0) + s;
      const newTomatoes     = (prev?.collected_tomatoes ?? 0) + (t ?? 0);
      const updatePayload: Record<string, number> = {
        last_session_score:      s,
        total_accumulated_score: newTotalScore,
      };
      if (t !== undefined) updatePayload.collected_tomatoes = newTomatoes;

      pb.collection('users').update(pbId, updatePayload)
        .then(() => {
          setGameStats(prev2 => prev2 ? {
            ...prev2,
            last_session_score:      s,
            total_accumulated_score: newTotalScore,
            ...(t !== undefined ? { collected_tomatoes: newTomatoes } : {}),
          } : prev2);
        })
        .catch(() => {});
    }
  }, [stopSessionTimer]);

  /* ── Start 2-minute session countdown ─────────────────────────────────── */
  const startSessionTimer = useCallback(() => {
    // Guard: do not restart if a session is already running (prevents mid-game reset)
    if (sessionActiveRef.current) {
      console.log('[Games] startSessionTimer called while already active — ignored');
      return;
    }
    stopSessionTimer();
    gameOverFiredRef.current  = false;
    liveScoreRef.current      = 0;
    sessionPeakScoreRef.current = 0;
    sessionActiveRef.current  = true;
    // Reset anti-replay state for new session
    matchIdRef.current        = '';
    claimInFlightRef.current  = false;
    setActionsLocked(false);
    setClaimError(null);
    // Reset auto-clicker monitor for fresh session
    tapMonitor.reset();
    setLiveScore(0);
    setSessionTime(SESSION_SECONDS);
    setSessionActive(true);
    setClaimLoading(false);
    warningPulse.setValue(1);
    warningPulse.stopAnimation();

    let remaining = SESSION_SECONDS;
    sessionTimerRef.current = setInterval(() => {
      remaining -= 1;
      setSessionTime(remaining);
      if (remaining <= 0) {
        clearInterval(sessionTimerRef.current!);
        sessionTimerRef.current = null;
        // Notify bridge that time is up (bridge may freeze the C3 game)
        sendToGame({ type: 'TIME_UP' });
        // Force game over on RN side with last known live score
        handleGameOver(liveScoreRef.current, undefined, 'time');
      }
    }, 1000);
  }, [stopSessionTimer, sendToGame, handleGameOver, warningPulse]);

  /* ── Live score update from bridge ── */
  const handleScoreUpdate = useCallback((rawScore: number) => {
    const s = Math.min(Math.max(0, Math.round(Number(rawScore) || 0)), SCORE_LIMIT);
    // Never allow the live score to drop during an active session
    // (bridge sends score=0 at the start of each new round; ignore if session running)
    if (sessionActiveRef.current && s < liveScoreRef.current) return;
    liveScoreRef.current = s;
    if (s > sessionPeakScoreRef.current) sessionPeakScoreRef.current = s;
    setLiveScore(s);

    // Start pulsing warning near limit
    if (s >= SCORE_WARNING) {
      startWarningPulse();
    }

    // Force game over if score cap reached in RN (bridge also does this, but belt-and-suspenders)
    if (s >= SCORE_LIMIT && !gameOverFiredRef.current) {
      sendToGame({ type: 'TIME_UP' }); // tell bridge to freeze
      handleGameOver(s, undefined, 'score');
    }
  }, [startWarningPulse, sendToGame, handleGameOver]);

  /* ── Bridge ready → inject server data + start session timer ── */
  const handleBridgeReady = useCallback(() => {
    const pbId = pbIdRef.current;
    let apiUrl = '';
    try { apiUrl = getApiUrl(); } catch {}

    const buildInject = (data: GameData) => ({
      type:              'INJECT_VARS',
      pbId,
      apiUrl,                              // game uses this for WebSocket URL
      // appVersion drives version-aware routing: bridge arms the match gate
      // and server enforces the hard gate ONLY for >= 1.0.3. Old 1.0.2 APKs
      // never send this field → full legacy behavior everywhere.
      appVersion:        Constants.expoConfig?.version ?? '1.0.3',
      powerTokens:       data.power_tokens,
      collectedTomatoes: data.collected_tomatoes,
      lastSessionScore:  data.last_session_score,
      totalScore:        data.total_accumulated_score,
    });
    const data = gameDataRef.current;
    if (data) {
      sendToGame(buildInject(data));
    } else if (pbId) {
      fetchGameData(pbId).then(d => { if (d) sendToGame(buildInject(d)); });
    }
    // Start the 3-minute client-side session timer (server also enforces its own)
    startSessionTimer();
  }, [sendToGame, fetchGameData, startSessionTimer]);

  /* ── DOUBLE (2×) → rewarded ad → server-validated one-time token → add PT ── */
  const handleDouble = useCallback(async () => {
    // Shared double-click lock: first tap on EITHER button freezes both
    if (claimInFlightRef.current) return;
    claimInFlightRef.current = true;
    setActionsLocked(true);
    setClaimError(null);
    setPhase('double_ad');

    // Request a one-time server token BEFORE showing the ad.
    // The server locks in reward = game_logs.raw_score × 2 (by matchId) at
    // this moment, so the client cannot manipulate the amount after the ad.
    // matchId binds the token to this game session (server closes the match).
    let adToken: string | null = null;
    const pbId = pbIdRef.current;
    const matchId = matchIdRef.current || undefined;
    if (pbId) {
      try {
        const tokenRes = await api.requestAdToken(pbId, matchId);
        adToken = tokenRes.token;
      } catch { /* fall through — use regular reward path as backup */ }
    }

    showRewarded(async (watched) => {
      if (!watched) {
        // Ad not watched — unlock both buttons so the player can still claim 1×
        claimInFlightRef.current = false;
        setActionsLocked(false);
        setPhase('summary');
        return;
      }
      setPhase('saving');
      try {
        let pts: number;
        if (adToken && pbId) {
          // Secure path: claim the server-issued token (single-use, amount locked server-side)
          const claimRes = await api.claimAdToken(pbId, adToken, matchId);
          pts = claimRes.reward;
        } else {
          // Fallback path (no token): regular reward endpoint with matchId so the
          // server can still validate and close the match (server-side caps apply)
          pts = Math.min(scoreRef.current * 2, SCORE_LIMIT * 2);
          await api.gameReward(pbId, pts, 'weapon_master', matchId);
        }
        await refreshBalance();
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (pbIdRef.current) fetchGameData(pbIdRef.current);
      } catch {
        // Honest failure: the server rejected the claim — nothing was credited.
        // Do NOT show a fake reward screen; surface the error on the summary.
        await refreshBalance().catch(() => {});
        claimInFlightRef.current = false;
        setActionsLocked(false);
        setClaimError('Reward could not be verified by the server. Nothing was credited.');
        setPhase('summary');
      }
    });
  }, [fetchGameData, refreshBalance, showRewarded]);

  /* ── CLAIM → AdMob interstitial (shown only AFTER the click) then add score PT ── */
  const handleClaim = useCallback(async () => {
    // Shared double-click lock: first tap on EITHER button freezes both
    if (claimInFlightRef.current) return;
    claimInFlightRef.current = true;
    setActionsLocked(true);
    setClaimError(null);
    setClaimLoading(true);

    // Show interstitial before processing the claim
    await new Promise<void>((resolve) => {
      showGameInterstitial(() => resolve());
    });
    setPhase('saving');
    const pts     = scoreRef.current;
    const pbId    = pbIdRef.current;
    const matchId = matchIdRef.current || undefined;
    try {
      // Call api.gameReward directly so we can pass matchId for server-side replay check
      await api.gameReward(pbId, pts, 'weapon_master', matchId);
      await refreshBalance();
      setEarned(pts);
      setPhase('reward');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (pbId) fetchGameData(pbId);
    } catch {
      // Honest failure: the server rejected the claim — nothing was credited.
      // Do NOT show a fake reward screen; surface the error on the summary.
      await refreshBalance().catch(() => {});
      claimInFlightRef.current = false;
      setActionsLocked(false);
      setClaimError('Claim could not be verified by the server. Nothing was credited.');
      setPhase('summary');
    } finally {
      setClaimLoading(false);
    }
  }, [fetchGameData, refreshBalance, showGameInterstitial]);

  /* ── Native WebView message handler ── */
  const onNativeMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'BRIDGE_READY') {
        handleBridgeReady();
      }
      if (msg.type === 'SCORE_UPDATE') {
        handleScoreUpdate(Number(msg.score) || 0);
      }
      if (msg.type === 'GAME_OVER' || msg.type === 'DOUBLE_REWARD') {
        const s = Number(msg.score) || 0;
        const t = Number(msg.collected_tomatoes) || 0;
        const reason: GameOverReason = msg.reason === 'score_limit' ? 'score'
                                     : msg.reason === 'time_limit'  ? 'time' : 'death';
        handleGameOver(s, t, reason);
      }
      // Capture matchId from server-committed session for replay-attack prevention
      if (msg.type === 'COMMITTED' && msg.matchId) {
        matchIdRef.current = String(msg.matchId);
      }
      // Auto-clicker detection: record every server-validated hit; fire block if pattern detected
      if (msg.type === 'HIT_ACK') {
        tapMonitor.record();
        if (tapMonitor.isAutoClicking()) {
          triggerAutoClicker();
        }
      }
      if (msg.type === 'INJECT_DONE') { /* no-op */ }
    } catch { /* ignore non-JSON */ }
  }, [handleBridgeReady, handleScoreUpdate, handleGameOver, tapMonitor, triggerAutoClicker]);

  /* ── Web iframe message handler ── */
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const h = (e: MessageEvent) => {
      try {
        const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (!msg?.type) return;
        if (msg.type === 'BRIDGE_READY') handleBridgeReady();
        if (msg.type === 'SCORE_UPDATE') handleScoreUpdate(Number(msg.score) || 0);
        if (msg.type === 'GAME_OVER' || msg.type === 'DOUBLE_REWARD') {
          const s = Number(msg.score) || 0;
          const t = Number(msg.collected_tomatoes) || 0;
          const reason: GameOverReason = msg.reason === 'score_limit' ? 'score'
                                       : msg.reason === 'time_limit'  ? 'time' : 'death';
          handleGameOver(s, t, reason);
        }
        // Capture matchId from server-committed session for replay-attack prevention
        if (msg.type === 'COMMITTED' && msg.matchId) {
          matchIdRef.current = String(msg.matchId);
        }
        // Auto-clicker detection: record every server-validated hit; fire block if pattern detected
        if (msg.type === 'HIT_ACK') {
          tapMonitor.record();
          if (tapMonitor.isAutoClicking()) {
            triggerAutoClicker();
          }
        }
      } catch { /* ignore non-JSON */ }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [handleBridgeReady, handleScoreUpdate, handleGameOver, tapMonitor, triggerAutoClicker]);

  /* ── Android back button ─────────────────────────────────────────────────
   *  Back navigation is BLOCKED during an active game, on the summary and
   *  while saving/watching ads. It is allowed ONLY when it is safe to leave:
   *  the reward ("Play Again") screen, a load error, or the idle game screen
   *  before a session starts. This prevents exit-and-replay reward abuse.  */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const canLeave = phase === 'reward' || gameError ||
                       (phase === 'game' && !sessionActive);
      return !canLeave; // true = swallow the back press (block navigation)
    });
    return () => sub.remove();
  }, [phase, gameError, sessionActive]);

  /* ── Render game WebView / iframe ── */
  const renderGame = () => {
    if (Platform.OS === 'web') {
      return (
        <iframe src={GAME_URL} title="WeaponMaster"
          style={{ flex: 1, border: 'none', width: '100%', height: '100%' } as any}
          allow="autoplay" />
      );
    }
    return (
      <WebView
        key={wvKey}
        ref={wvRef}
        source={{ uri: GAME_URL }}
        style={{ flex: 1 }}
        onMessage={onNativeMessage}
        javaScriptEnabled domStorageEnabled allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false} mixedContentMode="always"
        androidLayerType="hardware" overScrollMode="never"
        originWhitelist={['*']} startInLoadingState
        renderLoading={() => (
          <View style={S.loader}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.loaderTxt}>Loading game…</Text>
          </View>
        )}
        renderError={() => (
          // During auto-retry show a subtle "Reconnecting…" indicator instead of
          // the permanent error screen — the user sees a brief spinner, not an error.
          isAutoRetrying ? (
            <View style={S.loader}>
              <ActivityIndicator size="large" color={Colors.neonOrange} />
              <Text style={[S.loaderTxt, { marginTop: 12 }]}>
                Reconnecting… ({retryCountRef.current}/{WEBVIEW_MAX_RETRIES})
              </Text>
              <Text style={[S.loaderTxt, { fontSize: 12, color: Colors.textMuted, marginTop: 4 }]}>
                Slow connection detected — retrying
              </Text>
            </View>
          ) : (
            <View style={S.loader}>
              <Ionicons name="game-controller-outline" size={56} color={Colors.neonOrange} />
              <Text style={[S.loaderTxt, { marginTop: 12 }]}>Game server unavailable</Text>
              <Text style={[S.loaderTxt, { fontSize: 13, color: Colors.textMuted, marginTop: 4 }]}>
                Please check your connection and try again.
              </Text>
            </View>
          )
        )}
        onError={() => handleLoadError()}
        onHttpError={(e: any) => {
          const status = e.nativeEvent?.statusCode;
          console.warn('[Games] WebView HTTP error:', status, GAME_URL);
          // Only trigger retry/error for non-2xx responses that indicate server issues
          if (status && status >= 500) handleLoadError();
          else setGameError(true);
        }}
        containerStyle={{ flex: 1 }} />
    );
  };

  const adPlaying = phase === 'double_ad';
  const isWarning = liveScore >= SCORE_WARNING && sessionActive;
  const timeIsLow = sessionTime <= 30 && sessionActive;

  /* ── Summary screen reason helpers ── */
  const reasonTitle = overReason === 'time' ? "Time's Up!" : overReason === 'score' ? '2000 Points!' : 'Game Over';
  const reasonSub   = overReason === 'time' ? '2-minute session ended'
                    : overReason === 'score' ? 'You hit the session score limit'
                    : 'Keep playing to earn more tokens';

  return (
    <View style={S.root}>
      {/* ── Game area: WebView + all gameplay overlays. flex:1 so the banner
           bar below NEVER overlaps game UI — the WebView shrinks to fit. ── */}
      <View style={S.gameArea}>
      {renderGame()}

      {/* ── Back to Game Arena — shown ONLY when it is safe to leave:
           reward screen, load error, or idle game screen before a session.
           Hidden during active play / summary / saving to block exit-replay. ── */}
      {(phase === 'reward' || gameError || (phase === 'game' && !sessionActive)) && (
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={[S.ptBadge, { top: HUDTOP, left: 14, right: undefined }]}
          testID="solo-back"
        >
          <Ionicons name="chevron-back" size={16} color={Colors.gold} />
        </Pressable>
      )}

      {/* ── Game unavailable overlay (HTTP error / 404) ── */}
      {gameError && (
        <View style={S.errorOverlay}>
          <Ionicons name="game-controller-outline" size={64} color={Colors.neonOrange} />
          <Text style={S.errorTitle}>Game Unavailable</Text>
          <Text style={S.errorSub}>The game server is temporarily offline.{'\n'}Try again soon!</Text>
          <Pressable
            style={S.errorBtn}
            onPress={() => { setGameError(false); wvRef.current?.reload?.(); }}
          >
            <Text style={S.errorBtnTxt}>Retry</Text>
          </Pressable>
        </View>
      )}

      {/* ── PT badge (top-right, always visible) ── */}
      <View style={[S.ptBadge, { top: HUDTOP }]} pointerEvents="none">
        <Ionicons name="flash" size={13} color={Colors.gold} />
        <Text style={S.badgeTxt}>{powerTokens} PT</Text>
      </View>

      {/* ── Session HUD: timer + live score (only during active session) ── */}
      {sessionActive && phase === 'game' && (
        <View style={[S.hud, { top: HUDTOP }]} pointerEvents="none">
          {/* Timer pill */}
          <View style={[S.hudPill, timeIsLow && S.hudPillRed]}>
            <Ionicons name="timer-outline" size={12} color={timeIsLow ? '#ff5252' : Colors.textSecondary} />
            <Text style={[S.hudText, timeIsLow && S.hudTextRed]}>{formatTime(sessionTime)}</Text>
          </View>

          {/* Score pill */}
          <View style={[S.hudPill, isWarning && S.hudPillOrange]}>
            <Ionicons name="star" size={11} color={isWarning ? Colors.neonOrange : Colors.textSecondary} />
            <Text style={[S.hudText, isWarning && S.hudTextOrange]}>
              {liveScore}<Text style={S.hudTextMuted}>/2000</Text>
            </Text>
          </View>
        </View>
      )}

      {/* ── Warning strip at 1900+ points ── */}
      {isWarning && phase === 'game' && (
        <Animated.View style={[S.warningStrip, { opacity: warningPulse }]} pointerEvents="none">
          <Ionicons name="warning" size={13} color="#ff9800" />
          <Text style={S.warningTxt}>
            {SCORE_LIMIT - liveScore} pts to limit — finish strong!
          </Text>
        </Animated.View>
      )}

      </View>

      {/* ── Persistent AdMob banner bar (native only). The bar always reserves
           its height so the game layout never shifts mid-session; the ad itself
           mounts only during active gameplay — it unmounts while summary/reward
           modals cover the screen (AdMob viewability policy). The 60s hard
           refresh lives inside AdMobBanner. ── */}
      {BANNERS_AVAILABLE && (
        <View style={[S.bannerBar, { paddingBottom: insets.bottom }]}>
          {phase === 'game' && !gameError && <AdMobBanner />}
        </View>
      )}

      {/* ══ SUMMARY / GAME OVER SCREEN ══════════════════════════════════ */}
      <Modal visible={phase === 'summary'} transparent animationType="slide">
        <View style={S.overlay}>
          <View style={S.card}>

            {/* Header row: reason icon + title */}
            <View style={S.summaryHeader}>
              <Text style={S.summaryIcon}>
                {overReason === 'time' ? '⏰' : overReason === 'score' ? '🏆' : '💀'}
              </Text>
              <View>
                <Text style={S.title}>{reasonTitle}</Text>
                <Text style={S.reasonSub}>{reasonSub}</Text>
              </View>
            </View>

            {/* Score display */}
            <View style={S.scoreBanner}>
              <Text style={S.scoreBannerLabel}>SCORE</Text>
              <Text style={S.scoreBannerNum}>{score}</Text>
              <Text style={S.scoreBannerSub}>= {score} Power Tokens</Text>
            </View>

            {/* All-time stats */}
            {gameStats && (
              <View style={S.statsBox}>
                <StatRow label="All-time High Score" value={gameStats.total_accumulated_score} gold />
                <StatRow label="Total Tomatoes"       value={gameStats.collected_tomatoes} />
                <StatRow label="Your PT Wallet"       value={powerTokens} />
              </View>
            )}

            <View style={S.sep} />

            {/* Double Tokens — rewarded ad (primary action when score > 0) */}
            {/* Double-click lock: first tap on EITHER button disables BOTH */}
            {score > 0 && (
              <Pressable
                style={[S.doubleBtn, actionsLocked && S.claimBtnDim]}
                onPress={handleDouble}
                disabled={actionsLocked}
              >
                <Ionicons name="play-circle" size={18} color="#fff" />
                <Text style={S.doubleTxt}>Watch Ad  →  {score * 2} PT  (2×)</Text>
              </Pressable>
            )}

            {/* Claim Tokens — direct, no ad */}
            {/* Disabled + spinner after first tap until server responds — prevents replay attacks */}
            <Pressable
              style={[S.claimBtn, (score === 0 || actionsLocked) && S.claimBtnDim]}
              onPress={handleClaim}
              disabled={score === 0 || actionsLocked}
            >
              {claimLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
              <Text style={S.claimTxt}>
                {score > 0 ? `Claim  ${score} PT` : 'No tokens earned — Play Again'}
              </Text>
              )}
            </Pressable>

            {/* Honest failure message — server rejected the claim, nothing credited */}
            {claimError && (
              <Text style={S.claimErrTxt}>{claimError}</Text>
            )}

            {(score === 0 || !!claimError) && (
              <Pressable style={S.retryLink} onPress={reloadGame}>
                <Text style={S.retryLinkTxt}>Restart game</Text>
              </Pressable>
            )}

          </View>
        </View>
      </Modal>

      {/* ══ AD OVERLAY (rewarded — double tokens) ═══════════════════════ */}
      <Modal visible={adPlaying} transparent animationType="fade">
        <View style={S.adFull}>
          <View style={S.adCard}>
            <View style={S.adBar}>
              <Text style={S.adNetTxt}>Rewarded Video</Text>
            </View>
            <View style={S.adBody}>
              <Ionicons name="gift-outline" size={56} color={Colors.gold} />
              <ActivityIndicator size="large" color={Colors.gold} style={{ marginTop: 4 }} />
              <Text style={[S.adLabel, { color: Colors.gold }]}>Loading Ad…</Text>
              <Text style={S.adSub}>Watch to earn {score * 2} PT (2×)</Text>
              <Text style={S.adHint}>Ad provided by AdMob</Text>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══ SAVING ══════════════════════════════════════════════════════ */}
      <Modal visible={phase === 'saving'} transparent animationType="fade">
        <View style={S.overlay}>
          <View style={S.card}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.muted}>Saving tokens…</Text>
          </View>
        </View>
      </Modal>

      {/* ══ REWARD ══════════════════════════════════════════════════════ */}
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
              <Text style={S.backTxt}>Back</Text>
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
  root:      { flex: 1, backgroundColor: '#000' },
  gameArea:  { flex: 1 },
  bannerBar: { minHeight: BANNER_HEIGHT, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  loader:    { ...StyleSheet.absoluteFillObject, backgroundColor: '#0a1f1c', alignItems: 'center', justifyContent: 'center', gap: 12 },
  loaderTxt: { color: Colors.textMuted, fontFamily: 'Inter_500Medium', fontSize: 14 },

  /* Game error overlay */
  errorOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0a1f1c', alignItems: 'center', justifyContent: 'center', gap: 14, zIndex: 200, paddingHorizontal: 32 },
  errorTitle:   { fontFamily: 'Inter_700Bold', fontSize: 22, color: '#fff' },
  errorSub:     { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textMuted, textAlign: 'center', lineHeight: 22 },
  errorBtn:     { marginTop: 8, paddingHorizontal: 40, paddingVertical: 12, backgroundColor: Colors.neonOrange, borderRadius: 24 },
  errorBtnTxt:  { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#fff' },

  /* PT badge — top-right */
  ptBadge: { position: 'absolute', right: 14, flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, zIndex: 99 },
  badgeTxt: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.gold },

  /* Session HUD — timer + score — centered at top */
  hud: { position: 'absolute', left: 0, right: 0, zIndex: 98,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  hudPill: { flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.62)', paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  hudPillRed:    { borderColor: '#ff5252', backgroundColor: 'rgba(255,82,82,0.15)' },
  hudPillOrange: { borderColor: Colors.neonOrange, backgroundColor: 'rgba(255,152,0,0.15)' },
  hudText:       { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#fff' },
  hudTextRed:    { color: '#ff5252' },
  hudTextOrange: { color: Colors.neonOrange },
  hudTextMuted:  { fontFamily: 'Inter_400Regular', fontSize: 11, color: 'rgba(255,255,255,0.4)' },

  /* Warning strip */
  warningStrip: { position: 'absolute', bottom: 90, left: 20, right: 20, zIndex: 97,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: 'rgba(255,152,0,0.18)', borderWidth: 1, borderColor: 'rgba(255,152,0,0.5)',
    paddingVertical: 8, paddingHorizontal: 16, borderRadius: 20 },
  warningTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: '#ff9800' },

  /* Modals */
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center', justifyContent: 'center' },
  card:    { backgroundColor: '#0d1a17', borderRadius: 24, padding: 24, width: SW * 0.88,
    alignItems: 'center', gap: 14, borderWidth: 1, borderColor: 'rgba(244,196,48,0.18)' },

  /* Summary header */
  summaryHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, width: '100%' },
  summaryIcon:   { fontSize: 36 },
  title:  { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary, letterSpacing: 0.5 },
  reasonSub: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, marginTop: 2 },

  /* Score banner */
  scoreBanner: { width: '100%', backgroundColor: 'rgba(244,196,48,0.07)', borderRadius: 16,
    padding: 16, alignItems: 'center', gap: 2, borderWidth: 1, borderColor: 'rgba(244,196,48,0.2)' },
  scoreBannerLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 1.5 },
  scoreBannerNum:   { fontFamily: 'Inter_700Bold', fontSize: 52, color: Colors.gold, lineHeight: 60 },
  scoreBannerSub:   { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary },

  statsBox:  { width: '100%', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 12, gap: 6 },
  statRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statLabel: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
  statVal:   { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textPrimary },

  sep: { width: '100%', height: 1, backgroundColor: 'rgba(255,255,255,0.07)' },
  muted: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },

  /* Buttons */
  doubleBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
    backgroundColor: '#7c3aed', paddingVertical: 14, borderRadius: 28, width: '100%' },
  doubleTxt: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#fff', letterSpacing: 0.4 },

  claimBtn:    { backgroundColor: Colors.gold, paddingVertical: 14, borderRadius: 28, width: '100%', alignItems: 'center' },
  backBtn:     { marginTop: 10, paddingVertical: 12, borderRadius: 28, width: '100%', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  backTxt:     { fontFamily: 'Inter_700Bold', fontSize: 15, color: 'rgba(255,255,255,0.85)', letterSpacing: 0.5 },
  claimBtnDim: { opacity: 0.55 },
  claimTxt:    { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 0.5 },

  retryLink:    { paddingVertical: 4 },
  retryLinkTxt: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textMuted, textDecorationLine: 'underline' },
  claimErrTxt:  { fontFamily: 'Inter_500Medium', fontSize: 12, color: '#ff5252', textAlign: 'center', marginTop: 10, lineHeight: 17 },

  /* Ad overlay */
  adFull: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  adCard: { width: SW * 0.92, backgroundColor: '#111', borderRadius: 16, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  adBar:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10, backgroundColor: 'rgba(255,255,255,0.04)' },
  adNetTxt: { fontFamily: 'Inter_500Medium', fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: 1 },
  timerPill: { backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  timerTxt:  { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#fff' },
  adBody:   { height: SH * 0.42, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 24 },
  adLabel:  { fontFamily: 'Inter_700Bold', fontSize: 18, color: 'rgba(255,255,255,0.5)', letterSpacing: 1 },
  adSub:    { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.32)', textAlign: 'center' },
  adHint:   { fontFamily: 'Inter_400Regular', fontSize: 11, color: 'rgba(255,255,255,0.18)', textAlign: 'center' },
});
