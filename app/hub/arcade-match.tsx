/* ────────────────────────────────────────────────────────────────────────────
 * Flappy Bounce arcade match screen — async score-matching PvP.
 *
 * This screen is the RN "host" that owns the authenticated arcade WebSocket and
 * bridges a plain HTML5 game (hosted at webcod.in) running inside a WebView:
 *
 *   game  → RN : ARCADE_READY / ARCADE_SCORE / ARCADE_OUT   (postMessage)
 *   RN    → game: ARCADE_MATCH_START{lives} / ARCADE_FREEZE / ARCADE_END
 *   RN    ↔ server: JOIN_QUEUE / RESUME / SCORE / PLAYER_OUT ↔ MATCH_START /
 *                   OPPONENT_SCORE / OPPONENT_OUT / FREEZE_INPUT / MATCH_RESULT
 *
 * Money is 100% server-authoritative: both stakes are debited on match start and
 * the winner is credited Hit Tickets at settlement (10% platform fee) — NEVER
 * ad-gated. The interstitial before "Claim Tickets" is purely cosmetic.
 *
 * Offline PRACTICE (params.practice='1'): the socket is never opened, the game
 * is never sent ARCADE_MATCH_START, so it runs locally with 3 lives and emits no
 * score events — zero PT staked, zero tickets credited.
 * ──────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Platform, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import Colors from '@/constants/colors';
import { pb } from '@/lib/pocketbase';
import { useWallet } from '@/context/WalletContext';
import { useAds } from '@/context/AdContext';
import TicketIcon from '@/components/TicketIcon';
import { InlineBannerAd } from '@/components/StickyBannerAd';
import { ArcadeSocket } from '@/lib/arcadeClient';
import {
  ARCADE_TIERS, TIER_CONFIGS,
  type ArcadeServerMsg, type ArcadeOutcome, type ArcadeEndReason,
} from '@shared/arcade';

// Game is served from shared hosting (a different domain from the PB API), so the
// URL is hardcoded and NOT derived from getApiUrl().
const GAME_URL = 'https://webcod.in/flappy/index.html';

let WebView: any = null;
if (Platform.OS !== 'web') {
  WebView = require('react-native-webview').WebView;
}

type Mode = 'connecting' | 'queued' | 'playing' | 'practice' | 'gameover' | 'error';

const tierCfg = (tier: number) =>
  TIER_CONFIGS.find((t) => t.entryPT === tier) ?? TIER_CONFIGS[0];

export default function ArcadeMatchScreen() {
  const insets = useSafeAreaInsets();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;

  const params = useLocalSearchParams<{ gameId?: string; tier?: string; practice?: string }>();
  const gameId = params.gameId || 'flappy';
  const tier = Number(params.tier) || ARCADE_TIERS[0];
  const isPracticeParam = params.practice === '1';
  const cfg = tierCfg(tier);

  const [mode, setMode] = useState<Mode>(isPracticeParam ? 'practice' : 'connecting');
  const [statusMsg, setStatusMsg] = useState('Connecting to the arena…');
  const [errorMsg, setErrorMsg] = useState('');
  const [opponentName, setOpponentName] = useState('Opponent');
  const [myScore, setMyScore] = useState(0);
  const [oppScore, setOppScore] = useState(0);
  const [iAmOut, setIAmOut] = useState(false);
  const [oppOut, setOppOut] = useState(false);
  const [oppLeft, setOppLeft] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [wvKey, setWvKey] = useState(0);
  const [gameError, setGameError] = useState(false);
  const [result, setResult] = useState<{
    outcome: ArcadeOutcome; reason: ArcadeEndReason;
    yourScore: number; opponentScore: number; winnerTickets: number; refundPT: number;
  } | null>(null);

  const { refetch } = useWallet();
  const { showGameInterstitial } = useAds();

  const sockRef = useRef<ArcadeSocket | null>(null);
  const wvRef = useRef<any>(null);
  const matchIdRef = useRef('');
  const modeRef = useRef<Mode>(mode);
  const livesRef = useRef(1);
  const gameReadyRef = useRef(false);      // game (WebView) finished loading / posted ARCADE_READY
  const matchStartedRef = useRef(false);   // server MATCH_START received
  const injectedStartRef = useRef(false);  // ARCADE_MATCH_START inject sequence has begun
  const matchAckedRef = useRef(false);     // game acknowledged match mode (first score/out relayed)
  const startAttemptsRef = useRef(0);      // ARCADE_MATCH_START (re)send count
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iAmOutRef = useRef(false);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { iAmOutRef.current = iAmOut; }, [iAmOut]);

  /* ── RN → game bridge ─────────────────────────────────────────────────── */
  const sendToGame = useCallback((msg: object) => {
    const json = JSON.stringify(msg);
    if (Platform.OS !== 'web') {
      // Single, direct channel (__arcadeHostMessage) so a message is handled once.
      wvRef.current?.injectJavaScript(
        `window.__arcadeHostMessage && window.__arcadeHostMessage(${JSON.stringify(json)});true;`
      );
    } else {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="FlappyBounce"]');
      frame?.contentWindow?.postMessage(json, '*');
    }
  }, []);

  // Start the game when BOTH the server match and the game (WebView) are ready.
  // ARCADE_MATCH_START is idempotent on the game side (arcade-sdk.js only flips flags,
  // never resets the board), so we RE-SEND on a short timer until the game acknowledges
  // by relaying its first score/out. This closes the race where onLoadEnd fires before
  // window.__arcadeHostMessage exists and a single inject would silently no-op — which
  // would otherwise strand a STAKED player's game offline until it forfeited.
  const maybeStartGame = useCallback(() => {
    if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null; }
    if (matchAckedRef.current) return;                        // game already in match mode
    if (!gameReadyRef.current || !matchStartedRef.current) return;
    injectedStartRef.current = true;
    sendToGame({ type: 'ARCADE_MATCH_START', lives: livesRef.current });
    startAttemptsRef.current += 1;
    if (startAttemptsRef.current < 12) {                      // retry ~6s, then rely on server grace
      startTimerRef.current = setTimeout(() => maybeStartGame(), 500);
    }
  }, [sendToGame]);

  /* ── game → RN bridge ─────────────────────────────────────────────────── */
  const onGameMessage = useCallback((rawData: string) => {
    let msg: any;
    try { msg = JSON.parse(rawData); } catch { return; }
    if (!msg?.type) return;

    if (msg.type === 'ARCADE_READY') {
      gameReadyRef.current = true;
      maybeStartGame();
      return;
    }
    // Score / out relaying only matters for a live online match.
    if (modeRef.current !== 'playing' || !matchIdRef.current) return;

    // First gameplay signal proves ARCADE_MATCH_START landed — stop the start retries.
    if (msg.type === 'ARCADE_SCORE' || msg.type === 'ARCADE_OUT') {
      matchAckedRef.current = true;
      if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null; }
    }

    if (msg.type === 'ARCADE_SCORE') {
      const s = Math.max(0, Math.floor(Number(msg.score) || 0));
      setMyScore(s);
      if (!iAmOutRef.current) sockRef.current?.send({ type: 'SCORE', matchId: matchIdRef.current, score: s });
    } else if (msg.type === 'ARCADE_OUT') {
      const s = Math.max(0, Math.floor(Number(msg.score) || 0));
      setMyScore(s);
      if (!iAmOutRef.current) {
        setIAmOut(true);
        sockRef.current?.send({ type: 'PLAYER_OUT', matchId: matchIdRef.current, score: s });
      }
    }
  }, [maybeStartGame]);

  const onNativeMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    onGameMessage(e.nativeEvent.data);
  }, [onGameMessage]);

  // Web: listen for iframe → parent postMessage (no-op on native).
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const h = (e: MessageEvent) => {
      const d = typeof e.data === 'string' ? e.data : '';
      if (d) onGameMessage(d);
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [onGameMessage]);

  /* ── server → RN ──────────────────────────────────────────────────────── */
  const onServerMsg = useCallback((msg: ArcadeServerMsg) => {
    switch (msg.type) {
      case 'QUEUED':
        setMode('queued'); setStatusMsg('Finding an opponent…'); break;
      case 'MATCH_START':
        matchIdRef.current = msg.matchId;
        livesRef.current = msg.lives || 1;
        matchStartedRef.current = true;
        setOpponentName(msg.opponent?.name || 'Opponent');
        setIAmOut(false); iAmOutRef.current = false;
        setOppOut(false); setOppLeft(false); setReconnecting(false);
        setMode('playing');
        maybeStartGame();
        break;
      case 'OPPONENT_SCORE':
        setOppScore(Math.max(0, Math.floor(msg.score))); break;
      case 'OPPONENT_OUT':
        setOppScore(Math.max(0, Math.floor(msg.score))); setOppOut(true); break;
      case 'FREEZE_INPUT':
        // Opponent won early → freeze our run immediately (result follows).
        sendToGame({ type: 'ARCADE_FREEZE' }); break;
      case 'MATCH_RESULT':
        sendToGame({ type: 'ARCADE_END' });
        setResult({
          outcome: msg.outcome, reason: msg.reason,
          yourScore: msg.yourScore, opponentScore: msg.opponentScore,
          winnerTickets: msg.winnerTickets, refundPT: msg.refundPT,
        });
        setMode('gameover');
        refetch().catch(() => {}); // balances changed server-side
        break;
      case 'OPPONENT_LEFT': setOppLeft(true); break;
      case 'OPPONENT_BACK': setOppLeft(false); break;
      case 'REFUND':
        setErrorMsg(`Match refunded (${msg.reason}). ${msg.amountPT} PT returned.`);
        setMode('error');
        refetch().catch(() => {});
        break;
      case 'ERROR':
        if (modeRef.current === 'connecting' || modeRef.current === 'queued') {
          setErrorMsg(msg.message || 'Could not join a match'); setMode('error');
        } else {
          setErrorMsg(msg.message || 'Server error');
        }
        break;
      default: break;
    }
  }, [maybeStartGame, sendToGame, refetch]);

  /* ── connect on mount (online only) ───────────────────────────────────── */
  useEffect(() => {
    if (isPracticeParam) return; // practice never touches the network
    const token = pb.authStore.token;
    const pbId = pb.authStore.record?.id || (pb.authStore as any).model?.id;
    const sock = new ArcadeSocket({
      onOpen: (isReconnect) => {
        if (!token || !pbId) { setErrorMsg('Sign in required for online play'); setMode('error'); return; }
        if (isReconnect && matchIdRef.current) {
          setReconnecting(false);
          sock.send({ type: 'RESUME', token, pbId, matchId: matchIdRef.current });
        } else {
          setStatusMsg('Finding an opponent…');
          sock.send({ type: 'JOIN_QUEUE', token, pbId, gameId, tier });
        }
      },
      onMessage: onServerMsg,
      onError: () => { if (modeRef.current === 'connecting') setStatusMsg('Arena unavailable — you can still practice'); },
      onClose: () => { /* reconnect handled inside ArcadeSocket */ },
      onReconnecting: () => { if (matchIdRef.current && modeRef.current === 'playing') setReconnecting(true); },
      onReconnectGaveUp: () => {
        setReconnecting(false);
        if (modeRef.current === 'playing') { setErrorMsg('Lost connection to the match.'); setMode('error'); }
      },
    });
    sockRef.current = sock;
    sock.connect();
    return () => { sock.close(); if (startTimerRef.current) clearTimeout(startTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Practice: as soon as the game reports ready, flip it into 3-life offline play
  // by simply NOT injecting ARCADE_MATCH_START (the SDK stays offline by default).

  /* ── actions ──────────────────────────────────────────────────────────── */
  const leave = useCallback(() => {
    sockRef.current?.close();
    router.back();
  }, []);

  const goPractice = useCallback(() => {
    sockRef.current?.close();
    setErrorMsg(''); setResult(null);
    matchStartedRef.current = false;
    injectedStartRef.current = false;
    matchAckedRef.current = false;
    startAttemptsRef.current = 0;
    if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null; }
    setMode('practice');
  }, []);

  const playAgain = useCallback(() => {
    router.replace({ pathname: '/hub/arcade-match', params: { gameId, tier: String(tier), practice: '0' } } as any);
  }, [gameId, tier]);

  // Winner claim: tickets are ALREADY credited server-side. This button only shows
  // a cosmetic interstitial then returns to the lobby — never ad-gated.
  const claimTickets = useCallback(() => {
    if (claiming) return;
    setClaiming(true);
    showGameInterstitial(() => {
      refetch().catch(() => {});
      router.back();
    });
  }, [claiming, showGameInterstitial, refetch]);

  const retryGame = useCallback(() => {
    setGameError(false);
    gameReadyRef.current = false;
    injectedStartRef.current = false;
    matchAckedRef.current = false;
    startAttemptsRef.current = 0;
    if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null; }
    setWvKey((k) => k + 1);
  }, []);

  /* ── render helpers ───────────────────────────────────────────────────── */
  const renderGame = () => {
    if (Platform.OS === 'web') {
      return (
        <iframe
          src={GAME_URL}
          title="FlappyBounce"
          style={{ border: 'none', width: '100%', height: '100%' } as any}
          allow="autoplay"
        />
      );
    }
    return (
      <WebView
        key={wvKey}
        ref={wvRef}
        source={{ uri: GAME_URL }}
        style={{ flex: 1, backgroundColor: Colors.darkBg }}
        onMessage={onNativeMessage}
        onLoadEnd={() => { gameReadyRef.current = true; maybeStartGame(); }}
        onError={() => setGameError(true)}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        originWhitelist={['*']}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loader}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={styles.loaderTxt}>Loading game…</Text>
          </View>
        )}
        containerStyle={{ flex: 1 }}
      />
    );
  };

  const showQueue = mode === 'connecting' || mode === 'queued';
  const showGame = mode === 'playing' || mode === 'practice';

  return (
    <View style={[styles.root, { paddingTop: insets.top + webTop }]}>
      {/* Top HUD (during play / practice) */}
      {showGame && (
        <View style={styles.hud}>
          <Pressable onPress={leave} hitSlop={12} style={styles.iconBtn} testID="arcade-match-back">
            <Ionicons name="close" size={22} color={Colors.textSecondary} />
          </Pressable>

          {mode === 'playing' ? (
            <View style={styles.scoreRow}>
              <View style={[styles.scorePill, styles.mePill]}>
                <Text style={styles.scoreLabel}>YOU</Text>
                <Text style={styles.scoreVal}>{myScore}</Text>
                {iAmOut && <Ionicons name="skull" size={12} color={Colors.error} style={{ marginLeft: 4 }} />}
              </View>
              <Text style={styles.vs}>vs</Text>
              <View style={styles.scorePill}>
                <Text style={styles.scoreLabel} numberOfLines={1}>{opponentName.slice(0, 8).toUpperCase()}</Text>
                <Text style={styles.scoreVal}>{oppScore}</Text>
                {oppOut && <Ionicons name="skull" size={12} color={Colors.error} style={{ marginLeft: 4 }} />}
              </View>
            </View>
          ) : (
            <View style={styles.practicePill}>
              <Ionicons name="game-controller-outline" size={13} color={Colors.textSecondary} />
              <Text style={styles.practiceTxt}>Practice · 3 lives</Text>
            </View>
          )}

          <View style={styles.iconBtn} />
        </View>
      )}

      {/* Game surface */}
      {(showGame || (!isPracticeParam && !showQueue && mode !== 'error')) && (
        <View style={styles.gameArea}>{renderGame()}</View>
      )}
      {/* Keep the WebView mounted during queue so it's ready the instant a match starts */}
      {!isPracticeParam && showQueue && (
        <View style={styles.gameHidden} pointerEvents="none">{renderGame()}</View>
      )}

      {/* I'm out, waiting for opponent to finish */}
      {mode === 'playing' && iAmOut && !oppOut && (
        <View style={styles.waitBanner}>
          <ActivityIndicator color={Colors.gold} size="small" />
          <Text style={styles.waitTxt}>You're out — waiting for {opponentName}…</Text>
        </View>
      )}

      {/* Opponent disconnect / own reconnect banners */}
      {oppLeft && mode === 'playing' && (
        <View style={styles.waitBanner}>
          <ActivityIndicator color={Colors.gold} size="small" />
          <Text style={styles.waitTxt}>Opponent disconnected — waiting for reconnect…</Text>
        </View>
      )}
      {reconnecting && mode === 'playing' && (
        <View style={styles.waitBanner}>
          <ActivityIndicator color={Colors.gold} size="small" />
          <Text style={styles.waitTxt}>Reconnecting…</Text>
        </View>
      )}

      {/* Game failed to load */}
      {gameError && showGame && (
        <View style={styles.overlay}>
          <Ionicons name="game-controller-outline" size={44} color={Colors.neonOrange} />
          <Text style={styles.overlayTitle}>Game server unavailable</Text>
          <Text style={styles.overlaySub}>Check your connection and try again.</Text>
          <Pressable style={styles.primaryBtn} onPress={retryGame}>
            <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
              <Text style={styles.primaryBtnTxt}>Retry</Text>
            </LinearGradient>
          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={leave}><Text style={styles.ghostBtnTxt}>Back to Lobby</Text></Pressable>
        </View>
      )}

      {/* Matchmaking / connecting overlay */}
      {showQueue && (
        <View style={styles.overlay}>
          <ActivityIndicator color={Colors.gold} size="large" />
          <Text style={styles.overlayTitle}>{statusMsg}</Text>
          <Text style={styles.overlaySub}>Staking {tier.toLocaleString()} PT · winner takes {cfg.winnerTickets} tickets</Text>
          <Pressable style={styles.primaryBtn} onPress={goPractice} testID="arcade-play-practice">
            <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
              <Ionicons name="game-controller" size={18} color="#1a1200" />
              <Text style={styles.primaryBtnTxt}>Practice Offline</Text>
            </LinearGradient>
          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={leave}><Text style={styles.ghostBtnTxt}>Cancel</Text></Pressable>
          <View style={styles.bannerSlot}><InlineBannerAd /></View>
        </View>
      )}

      {/* Error / refund overlay */}
      {mode === 'error' && (
        <View style={styles.overlay}>
          <Ionicons name="alert-circle" size={40} color={Colors.error} />
          <Text style={styles.overlayTitle}>{errorMsg || 'Something went wrong'}</Text>
          <Pressable style={styles.primaryBtn} onPress={goPractice}>
            <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
              <Ionicons name="game-controller" size={18} color="#1a1200" />
              <Text style={styles.primaryBtnTxt}>Practice Offline</Text>
            </LinearGradient>
          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={leave}><Text style={styles.ghostBtnTxt}>Back to Lobby</Text></Pressable>
        </View>
      )}

      {/* Settlement overlay */}
      {mode === 'gameover' && result && (
        <View style={styles.overlay}>
          {(() => {
            if (result.outcome === 'win') {
              return (
                <>
                  <Ionicons name="trophy" size={52} color={Colors.gold} />
                  <Text style={styles.resultTitle}>You won!</Text>
                  <View style={styles.finalScores}>
                    <Text style={styles.finalScoreTxt}>You {result.yourScore}</Text>
                    <Text style={styles.finalScoreDivider}>·</Text>
                    <Text style={styles.finalScoreTxt}>{opponentName} {result.opponentScore}</Text>
                  </View>
                  <View style={styles.ticketWon}>
                    <TicketIcon size={22} color={Colors.gold} />
                    <Text style={styles.ticketWonTxt}>+{result.winnerTickets} Hit Tickets</Text>
                  </View>
                  <Text style={styles.creditedNote}>Tickets already credited to your wallet.</Text>
                  <Pressable style={styles.primaryBtn} onPress={claimTickets} disabled={claiming} testID="arcade-claim">
                    <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
                      {claiming ? <ActivityIndicator color="#1a1200" size="small" /> : (
                        <>
                          <Ionicons name="checkmark-circle" size={18} color="#1a1200" />
                          <Text style={styles.primaryBtnTxt}>Claim Tickets</Text>
                        </>
                      )}
                    </LinearGradient>
                  </Pressable>
                </>
              );
            }
            if (result.outcome === 'draw') {
              return (
                <>
                  <Ionicons name="git-compare" size={48} color={Colors.textSecondary} />
                  <Text style={styles.resultTitle}>Draw</Text>
                  <View style={styles.finalScores}>
                    <Text style={styles.finalScoreTxt}>You {result.yourScore}</Text>
                    <Text style={styles.finalScoreDivider}>·</Text>
                    <Text style={styles.finalScoreTxt}>{opponentName} {result.opponentScore}</Text>
                  </View>
                  <Text style={styles.creditedNote}>{result.refundPT} PT stake refunded.</Text>
                  <Pressable style={styles.primaryBtn} onPress={playAgain}>
                    <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
                      <Text style={styles.primaryBtnTxt}>Play Again</Text>
                    </LinearGradient>
                  </Pressable>
                  <Pressable style={styles.ghostBtn} onPress={leave}><Text style={styles.ghostBtnTxt}>Back to Lobby</Text></Pressable>
                </>
              );
            }
            return (
              <>
                <Ionicons name="close-circle" size={48} color={Colors.error} />
                <Text style={styles.resultTitle}>You lost</Text>
                <View style={styles.finalScores}>
                  <Text style={styles.finalScoreTxt}>You {result.yourScore}</Text>
                  <Text style={styles.finalScoreDivider}>·</Text>
                  <Text style={styles.finalScoreTxt}>{opponentName} {result.opponentScore}</Text>
                </View>
                <Pressable style={styles.primaryBtn} onPress={playAgain}>
                  <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
                    <Text style={styles.primaryBtnTxt}>Play Again</Text>
                  </LinearGradient>
                </Pressable>
                <Pressable style={styles.ghostBtn} onPress={leave}><Text style={styles.ghostBtnTxt}>Back to Lobby</Text></Pressable>
              </>
            );
          })()}
          <View style={styles.bannerSlot}><InlineBannerAd /></View>
        </View>
      )}

      {Platform.OS === 'web' && <View style={{ height: webBottom }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },
  hud: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 8, gap: 8 },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  scoreRow: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  scorePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.darkCard, borderColor: Colors.darkBorder, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, minWidth: 74, justifyContent: 'center' },
  mePill: { borderColor: 'rgba(244,196,48,0.5)' },
  scoreLabel: { color: Colors.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  scoreVal: { color: Colors.textPrimary, fontSize: 16, fontWeight: '800' },
  vs: { color: Colors.textMuted, fontSize: 11, fontWeight: '700' },
  practicePill: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  practiceTxt: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700' },
  gameArea: { flex: 1, overflow: 'hidden' },
  gameHidden: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -9999, top: -9999 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.darkBg },
  loaderTxt: { color: Colors.textSecondary, fontSize: 14, marginTop: 12 },
  waitBanner: { position: 'absolute', left: 16, right: 16, bottom: 24, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(10,10,15,0.92)', borderColor: Colors.darkBorder, borderWidth: 1, borderRadius: 14, padding: 12 },
  waitTxt: { flex: 1, color: Colors.textSecondary, fontSize: 13 },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,6,10,0.94)', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  overlayTitle: { color: Colors.textPrimary, fontSize: 18, fontWeight: '800', textAlign: 'center', marginTop: 6 },
  overlaySub: { color: Colors.textSecondary, fontSize: 13, textAlign: 'center' },
  resultTitle: { color: Colors.textPrimary, fontSize: 24, fontWeight: '900', marginTop: 8 },
  finalScores: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  finalScoreTxt: { color: Colors.textSecondary, fontSize: 14, fontWeight: '700' },
  finalScoreDivider: { color: Colors.textMuted, fontSize: 14 },
  ticketWon: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, backgroundColor: 'rgba(244,196,48,0.1)', borderColor: 'rgba(244,196,48,0.4)', borderWidth: 1, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14 },
  ticketWonTxt: { color: Colors.gold, fontSize: 18, fontWeight: '800' },
  creditedNote: { color: Colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: 2 },
  primaryBtn: { marginTop: 14, borderRadius: 14, overflow: 'hidden', width: '100%', maxWidth: 320 },
  primaryBtnBg: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 15 },
  primaryBtnTxt: { color: '#1a1200', fontSize: 16, fontWeight: '800' },
  ghostBtn: { marginTop: 10, paddingVertical: 10 },
  ghostBtnTxt: { color: Colors.textSecondary, fontSize: 14, fontWeight: '600' },
  bannerSlot: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' },
});
