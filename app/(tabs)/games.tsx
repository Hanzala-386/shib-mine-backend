import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, Dimensions, Modal, Pressable,
  ActivityIndicator, Platform, BackHandler, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useWallet } from '@/context/WalletContext';
import { useAuth } from '@/context/AuthContext';
import { pb } from '@/lib/pocketbase';
import Colors from '@/constants/colors';
import { useAds } from '@/context/AdContext';

let WebView: any = null;
if (Platform.OS !== 'web') {
  WebView = require('react-native-webview').WebView;
}

const { width: SW, height: SH } = Dimensions.get('window');
// Game is hosted on shared hosting (different domain from the PocketBase API)
const GAME_URL = 'https://webcod.in/arcade/index.html';

const SESSION_SECONDS = 180; // 3-minute session
const SCORE_LIMIT     = 2000;
const SCORE_WARNING   = 1900;

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

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { addPowerTokens, powerTokens } = useWallet();
  const { pbUser, refreshBalance } = useAuth();
  const { showGameInterstitial, showRewarded } = useAds();

  const wvRef           = useRef<any>(null);
  const scoreRef        = useRef(0);           // final score at game-over
  const liveScoreRef    = useRef(0);           // live score during play (from SCORE_UPDATE)
  const pbIdRef         = useRef<string>('');
  const gameDataRef     = useRef<GameData | null>(null);
  const sessionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameOverFiredRef = useRef(false);      // guard against double GAME_OVER
  const warningPulse    = useRef(new Animated.Value(1)).current;

  const [phase,         setPhase]         = useState<Phase>('game');
  const [score,         setScore]         = useState(0);
  const [liveScore,     setLiveScore]     = useState(0);
  const [earned,        setEarned]        = useState(0);
  const [gameStats,     setGameStats]     = useState<GameData | null>(null);
  const [sessionTime,   setSessionTime]   = useState(SESSION_SECONDS);
  const [sessionActive, setSessionActive] = useState(false);
  const [overReason,    setOverReason]    = useState<GameOverReason>('death');
  const [gameError,     setGameError]     = useState(false);

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
  }, []);

  /* ── Session countdown (2 minutes) ───────────────────────────────────────
   *  Starts when BRIDGE_READY fires. On reaching 0, forces game over.
   * ─────────────────────────────────────────────────────────────────────── */
  const stopSessionTimer = useCallback(() => {
    if (sessionTimerRef.current) { clearInterval(sessionTimerRef.current); sessionTimerRef.current = null; }
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

  /* ── Reload / reset game ── */
  const reloadGame = useCallback(() => {
    stopSessionTimer();
    gameOverFiredRef.current = false;
    liveScoreRef.current = 0;
    scoreRef.current = 0;
    setScore(0);
    setLiveScore(0);
    setEarned(0);
    setSessionTime(SESSION_SECONDS);
    setSessionActive(false);
    setPhase('game');
    warningPulse.stopAnimation();
    warningPulse.setValue(1);
    if (Platform.OS !== 'web') {
      wvRef.current?.reload();
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
    setSessionActive(false);

    const s = Math.min(Math.max(0, Math.round(Number(rawScore) || 0)), SCORE_LIMIT);
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
    stopSessionTimer();
    gameOverFiredRef.current = false;
    liveScoreRef.current = 0;
    setLiveScore(0);
    setSessionTime(SESSION_SECONDS);
    setSessionActive(true);
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
    liveScoreRef.current = s;
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
    const buildInject = (data: GameData) => ({
      type:              'INJECT_VARS',
      pbId,
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
    // Start the 2-minute session timer
    startSessionTimer();
  }, [sendToGame, fetchGameData, startSessionTimer]);

  /* ── DOUBLE (2×) → rewarded ad (AdMob mediation picks network) → add score × 2 PT ── */
  const handleDouble = useCallback(async () => {
    setPhase('double_ad');
    showRewarded(async (watched) => {
      if (!watched) { setPhase('summary'); return; }
      setPhase('saving');
      const pts = Math.min(scoreRef.current * 2, SCORE_LIMIT * 2);
      try {
        await addPowerTokens(pts, 'knife_hit');
        await refreshBalance();
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (pbIdRef.current) fetchGameData(pbIdRef.current);
      } catch {
        await refreshBalance().catch(() => {});
        setEarned(pts); setPhase('reward');
      }
    });
  }, [addPowerTokens, fetchGameData, refreshBalance, showRewarded]);

  /* ── CLAIM → interstitial ad (AdMob → Unity → AppLovin) then add score PT ── */
  const handleClaim = useCallback(async () => {
    // Show interstitial before processing the claim
    await new Promise<void>((resolve) => {
      showGameInterstitial(() => resolve());
    });
    setPhase('saving');
    const pts = scoreRef.current;
    try {
      await addPowerTokens(pts, 'knife_hit');
      await refreshBalance();
      setEarned(pts);
      setPhase('reward');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (pbIdRef.current) fetchGameData(pbIdRef.current);
    } catch {
      await refreshBalance().catch(() => {});
      setEarned(pts); setPhase('reward');
    }
  }, [addPowerTokens, fetchGameData, refreshBalance, showGameInterstitial]);

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
      if (msg.type === 'INJECT_DONE') { /* no-op */ }
    } catch { /* ignore non-JSON */ }
  }, [handleBridgeReady, handleScoreUpdate, handleGameOver]);

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
      } catch { /* ignore non-JSON */ }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [handleBridgeReady, handleScoreUpdate, handleGameOver]);

  /* ── Android back button ── */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase !== 'game') { setPhase('game'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [phase]);

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
        renderError={() => (
          <View style={S.loader}>
            <Ionicons name="game-controller-outline" size={56} color={Colors.neonOrange} />
            <Text style={[S.loaderTxt, { marginTop: 12 }]}>Game server unavailable</Text>
            <Text style={[S.loaderTxt, { fontSize: 13, color: Colors.textMuted, marginTop: 4 }]}>
              Please check your connection and try again.
            </Text>
          </View>
        )}
        onHttpError={(e: any) => {
          console.warn('[Games] WebView HTTP error:', e.nativeEvent?.statusCode, GAME_URL);
          setGameError(true);
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
      {renderGame()}

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
            {score > 0 && (
              <Pressable style={S.doubleBtn} onPress={handleDouble}>
                <Ionicons name="play-circle" size={18} color="#fff" />
                <Text style={S.doubleTxt}>Watch Ad  →  {score * 2} PT  (2×)</Text>
              </Pressable>
            )}

            {/* Claim Tokens — direct, no ad */}
            <Pressable style={[S.claimBtn, score === 0 && S.claimBtnDim]} onPress={handleClaim} disabled={score === 0}>
              <Text style={S.claimTxt}>
                {score > 0 ? `Claim  ${score} PT` : 'No tokens earned — Play Again'}
              </Text>
            </Pressable>

            {score === 0 && (
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
  claimBtnDim: { opacity: 0.55 },
  claimTxt:    { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 0.5 },

  retryLink:    { paddingVertical: 4 },
  retryLinkTxt: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textMuted, textDecorationLine: 'underline' },

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
