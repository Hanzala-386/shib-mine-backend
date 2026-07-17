/* ────────────────────────────────────────────────────────────────────────────
 * Arcade match screen (Flappy Bounce / Fruit Cut) — async score-matching PvP.
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
import { View, Text, StyleSheet, Pressable, Platform, ActivityIndicator, Animated, Easing, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import Colors from '@/constants/colors';
import { pb, POCKETBASE_URL } from '@/lib/pocketbase';
import { useWallet } from '@/context/WalletContext';
import { useAds } from '@/context/AdContext';
import { useAuth } from '@/context/AuthContext';
import TicketIcon from '@/components/TicketIcon';
import KycGateModal, { useKycGate } from '@/components/KycGate';
import { InlineBannerAd } from '@/components/StickyBannerAd';
import { ArcadeSocket } from '@/lib/arcadeClient';
import {
  ARCADE_TIERS, TIER_CONFIGS,
  type ArcadeServerMsg, type ArcadeOutcome, type ArcadeEndReason,
} from '@shared/arcade';

// Games are served from shared hosting (a different domain from the PB API), so
// the URLs are hardcoded and NOT derived from getApiUrl(). `v` busts the shared
// host's cache of index.html (its <script src> tags are versioned separately).
// `afkMs` is the client-side TAP-TO-START AFK forfeit (fast UX path); the server
// runs its own authoritative backstop (spec.readyAfkSeconds in @shared/arcade:
// flappy 45s, fruitcut 47s). The client value MUST sit well BELOW the server
// window: the server only clears its AFK timer on the first relayed SCORE, and
// a player who taps at the last moment still needs several seconds to land
// their first score (fruit spawn + slice + report throttle). 40s < 47s keeps
// the same safety ratio Flappy uses (30s < 45s).
const GAME_HOSTS: Record<string, { url: string; v: number; afkMs: number }> = {
  flappy:   { url: 'https://webcod.in/flappy/index.html',   v: 7, afkMs: 30000 },
  fruitcut: { url: 'https://webcod.in/fruitcut/index.html', v: 3, afkMs: 40000 },
  // Stack: TAP-TO-START = the first gameplay tap on the Game layout (adapter
  // signals ARCADE_STARTED there). Ordering invariant: adapter stage-1 forfeit
  // 45s < this 50s < the 60s server backstop (readyAfkSeconds).
  stack:    { url: 'https://webcod.in/stack/index.html',    v: 3, afkMs: 50000 },
  // 2048 / Ice Block / Color Rush — same invariant: adapter stage-1 forfeit 45s
  // < this 50s (RN AFK) < 60s server backstop (readyAfkSeconds in @shared/arcade).
  '2048':   { url: 'https://webcod.in/2048/index.html',     v: 1, afkMs: 50000 },
  iceblock: { url: 'https://webcod.in/iceblock/index.html', v: 1, afkMs: 50000 },
  color:    { url: 'https://webcod.in/color/index.html',    v: 2, afkMs: 50000 },
};

// One shared iframe title for the web host's postMessage channel (per-game lookup
// would silently break sendToGame if it ever diverged from the rendered title).
const IFRAME_TITLE = 'ArcadeGame';

let WebView: any = null;
if (Platform.OS !== 'web') {
  WebView = require('react-native-webview').WebView;
}

type Mode = 'connecting' | 'queued' | 'matchfound' | 'playing' | 'practice' | 'gameover' | 'error';

const tierCfg = (tier: number) =>
  TIER_CONFIGS.find((t) => t.entryPT === tier) ?? TIER_CONFIGS[0];

/* ── Avatar helpers (mirrors the leaderboard's deterministic-neon style) ──── */
const AV_COLORS = [
  '#FF6B00', '#F4C430', '#00C853', '#2979FF',
  '#E040FB', '#FF3B30', '#00BCD4', '#FF8F00',
  '#76FF03', '#FFEA00',
];
function avatarColor(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

function PlayerAvatar({ name, seed, uri, size = 84, ring, dim }: {
  name: string; seed: string; uri?: string; size?: number; ring?: string; dim?: boolean;
}) {
  const color = ring || avatarColor(seed);
  const box = {
    width: size, height: size, borderRadius: size / 2,
    borderWidth: 2.5, borderColor: color,
    backgroundColor: color + '1F',
    alignItems: 'center' as const, justifyContent: 'center' as const,
    overflow: 'hidden' as const,
    opacity: dim ? 0.85 : 1,
  };
  if (uri) {
    return (
      <View style={box}>
        <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" />
      </View>
    );
  }
  return (
    <View style={box}>
      <Text style={{ fontFamily: 'Inter_700Bold', fontSize: Math.round(size * 0.32), color, fontWeight: '800' }}>
        {(name || '??').slice(0, 2).toUpperCase()}
      </Text>
    </View>
  );
}

// Flickering "searching…" opponent pool — purely cosmetic while matchmaking.
const FAKE_OPPONENTS = [
  'CryptoNinja', 'ShibaLord', 'MoonRider', 'PixelHawk', 'NeonBlaze', 'GoldRush',
  'TokenKing', 'FlapMaster', 'ByteRunner', 'StormWolf', 'AceViper', 'LuckySeven',
  'TurboFox', 'MegaBounce', 'ZenArcher', 'RocketPaws', 'VoltStrike', 'JadeFalcon',
];

export default function ArcadeMatchScreen() {
  const insets = useSafeAreaInsets();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;

  const params = useLocalSearchParams<{ gameId?: string; tier?: string; practice?: string }>();
  const gameId = typeof params.gameId === 'string' && GAME_HOSTS[params.gameId] ? params.gameId : 'flappy';
  const gameHost = GAME_HOSTS[gameId];
  const tier = Number(params.tier) || ARCADE_TIERS[0];
  const isPracticeParam = params.practice === '1';
  const cfg = tierCfg(tier);

  const { user } = useAuth();
  const myId = pb.authStore.record?.id || (pb.authStore as any).model?.id || 'me';
  const myName = user?.displayName || pb.authStore.record?.display_name || 'You';
  const [myAvatarUri, setMyAvatarUri] = useState<string | undefined>(undefined);

  const [mode, setMode] = useState<Mode>(isPracticeParam ? 'practice' : 'connecting');

  // Online matches load the game with ?arcade=1 so the embedded game detects the
  // live match at PAGE LOAD — the 1-life HUD, no-local-replay guard, and live
  // score posting no longer depend on the ARCADE_MATCH_START postMessage landing
  // through the cross-origin iframe. Practice (including switching to practice
  // mid-flow via goPractice, which bumps wvKey to remount) drops the flag so the
  // game reloads with 3 lives + local replay. `?v=` busts shared-hosting caches of
  // index.html (its <script src> tags are versioned to bust the JS too).
  const practiceActive = isPracticeParam || mode === 'practice';
  const gameSrc = `${gameHost.url}?v=${gameHost.v}${practiceActive ? '' : '&arcade=1'}`;

  const [statusMsg, setStatusMsg] = useState('Connecting to the arena…');
  const [errorMsg, setErrorMsg] = useState('');
  const [opponentName, setOpponentName] = useState('Opponent');
  const [flicker, setFlicker] = useState<string>(FAKE_OPPONENTS[0]);
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
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // match-found reveal
  const iAmOutRef = useRef(false);
  const afkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 30s TAP-TO-START AFK forfeit
  const afkFiredRef = useRef(false);

  // Cosmetic animations (native driver where supported; web falls back to JS driver).
  const useNative = Platform.OS !== 'web';
  const vsGlow = useRef(new Animated.Value(0)).current;   // pulsing VS glow
  const flyProgress = useRef(new Animated.Value(0)).current; // stakes → pot on match found

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { iAmOutRef.current = iAmOut; }, [iAmOut]);

  /* ── current user's real avatar (avatar2), falls back to initials ─────────── */
  useEffect(() => {
    const id = pb.authStore.record?.id;
    if (!id) return;
    (async () => {
      try {
        const u = await pb.collection('users').getOne(id, { fields: 'id,avatar2' });
        const fn = Array.isArray(u.avatar2) ? u.avatar2[0] : (u as any).avatar2;
        if (fn) setMyAvatarUri(`${POCKETBASE_URL}/api/files/users/${u.id}/${fn}`);
      } catch { /* initials fallback */ }
    })();
  }, []);

  /* ── flickering fake opponent while searching ─────────────────────────────── */
  useEffect(() => {
    if (mode !== 'queued' && mode !== 'connecting') return;
    const t = setInterval(() => {
      setFlicker(FAKE_OPPONENTS[Math.floor(Math.random() * FAKE_OPPONENTS.length)]);
    }, 130);
    return () => clearInterval(t);
  }, [mode]);

  /* ── pulsing VS glow while searching / match found ────────────────────────── */
  useEffect(() => {
    if (mode !== 'queued' && mode !== 'connecting' && mode !== 'matchfound') return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(vsGlow, { toValue: 1, duration: 850, easing: Easing.inOut(Easing.ease), useNativeDriver: useNative }),
      Animated.timing(vsGlow, { toValue: 0, duration: 850, easing: Easing.inOut(Easing.ease), useNativeDriver: useNative }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [mode, vsGlow, useNative]);

  /* ── stakes fly into the shared pot the moment a match is found ────────────── */
  useEffect(() => {
    if (mode === 'matchfound') {
      flyProgress.setValue(0);
      Animated.timing(flyProgress, { toValue: 1, duration: 1200, delay: 450, easing: Easing.out(Easing.cubic), useNativeDriver: useNative }).start();
    } else if (mode === 'queued' || mode === 'connecting') {
      flyProgress.setValue(0);
    }
  }, [mode, flyProgress, useNative]);

  /* ── RN → game bridge ─────────────────────────────────────────────────── */
  const sendToGame = useCallback((msg: object) => {
    const json = JSON.stringify(msg);
    if (Platform.OS !== 'web') {
      // Single, direct channel (__arcadeHostMessage) so a message is handled once.
      wvRef.current?.injectJavaScript(
        `window.__arcadeHostMessage && window.__arcadeHostMessage(${JSON.stringify(json)});true;`
      );
    } else {
      const frame = document.querySelector<HTMLIFrameElement>(`iframe[title="${IFRAME_TITLE}"]`);
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

  /* ── Per-game AFK auto-forfeit on the TAP-TO-START ready screen ────────────
   * (Flappy 30s, Fruit Cut 40s — see GAME_HOSTS.afkMs; server backstops at 45s/47s.)
   * The SERVER (arcadehub) is the real authority via its own AFK backstop; this
   * client timer is the fast UX path AND the only enforcement while the hosted
   * game is still served from a pre-countdown cached build. On fire we send
   * PLAYER_OUT(0): the server locks the idle seat at 0 and settles fairly — an
   * engaged opponent wins, both-idle → draw refund. Cancelled the instant the
   * player engages (ARCADE_STARTED tap / first score / out). */
  const clearAfk = useCallback(() => {
    if (afkTimerRef.current) { clearTimeout(afkTimerRef.current); afkTimerRef.current = null; }
  }, []);

  const armAfk = useCallback(() => {
    clearAfk();
    afkFiredRef.current = false;
    afkTimerRef.current = setTimeout(() => {
      afkTimerRef.current = null;
      if (afkFiredRef.current || iAmOutRef.current || !matchIdRef.current) return;
      afkFiredRef.current = true;
      setIAmOut(true); iAmOutRef.current = true;
      sockRef.current?.send({ type: 'PLAYER_OUT', matchId: matchIdRef.current, score: 0 });
      sendToGame({ type: 'ARCADE_FREEZE' }); // stop the local run so there's no zombie play
    }, gameHost.afkMs);
  }, [clearAfk, sendToGame, gameHost.afkMs]);

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
    if (msg.type === 'ARCADE_SCORE' || msg.type === 'ARCADE_OUT' || msg.type === 'ARCADE_STARTED') {
      matchAckedRef.current = true;
      if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null; }
      clearAfk(); // player engaged (tapped / scored / finished) → cancel AFK forfeit
    }

    // Engagement-only signal (tap to start) — nothing to relay to the server.
    if (msg.type === 'ARCADE_STARTED') return;

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
  }, [maybeStartGame, clearAfk]);

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
        if (matchAckedRef.current) {
          // Mid-match RESUME — the game is already live; skip the reveal, keep playing.
          setMode('playing');
          maybeStartGame();
        } else {
          // Fresh match — show the VS reveal + stake-fly, THEN launch the game.
          // 2.1s < ARCADE_GRACE_SECONDS(30s), so the delayed start is never penalized.
          setMode('matchfound');
          if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
          revealTimerRef.current = setTimeout(() => {
            revealTimerRef.current = null;
            // Never clobber a result/error that landed during the reveal window.
            if (modeRef.current !== 'matchfound') return;
            setMode('playing');
            maybeStartGame();
            armAfk(); // begin the 30s TAP-TO-START AFK countdown for this fresh match
          }, 2100);
        }
        break;
      case 'OPPONENT_SCORE':
        setOppScore(Math.max(0, Math.floor(msg.score))); break;
      case 'OPPONENT_OUT':
        setOppScore(Math.max(0, Math.floor(msg.score))); setOppOut(true); break;
      case 'FREEZE_INPUT':
        // Opponent won early → freeze our run immediately (result follows).
        clearAfk();
        sendToGame({ type: 'ARCADE_FREEZE' }); break;
      case 'MATCH_RESULT':
        clearAfk();
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
        clearAfk();
        setErrorMsg(`Match refunded (${msg.reason}). ${msg.amountPT} PT returned.`);
        setMode('error');
        refetch().catch(() => {});
        break;
      case 'ERROR':
        clearAfk();
        if (modeRef.current === 'connecting' || modeRef.current === 'queued') {
          setErrorMsg(msg.message || 'Could not join a match'); setMode('error');
        } else {
          setErrorMsg(msg.message || 'Server error');
        }
        break;
      default: break;
    }
  }, [maybeStartGame, sendToGame, refetch, armAfk, clearAfk]);

  /* ── KYC gate (online only) — match is deep-linkable, so the socket must
   * not open (and PT must not be staked) until the user is verified. kycOk
   * LATCHES true so a transient pbUser re-hydration can never close a live
   * match socket mid-game. Practice stays ungated (offline, no stakes). */
  const { isKycVerified } = useKycGate();
  const [kycOk, setKycOk] = useState(isKycVerified);
  useEffect(() => {
    if (isKycVerified) setKycOk(true);
  }, [isKycVerified]);
  const showKycGate = !isPracticeParam && !kycOk;

  /* ── connect once KYC-cleared (online only) ───────────────────────────── */
  useEffect(() => {
    if (isPracticeParam) return; // practice never touches the network
    if (!kycOk) return; // gate: wait for KYC before joining the paid queue
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
    return () => {
      sock.close();
      if (startTimerRef.current) clearTimeout(startTimerRef.current);
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
      if (afkTimerRef.current) clearTimeout(afkTimerRef.current);
    };
    // kycOk latches false→true exactly once, so this runs at most one connect;
    // the pre-latch run returns before creating a socket (no cleanup to fire).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kycOk]);

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
    gameReadyRef.current = false;
    if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null; }
    if (revealTimerRef.current) { clearTimeout(revealTimerRef.current); revealTimerRef.current = null; }
    // Remount the game so it reloads WITHOUT ?arcade=1 → 3-life offline practice
    // (gameSrc is derived from mode='practice' below), never a stranded 1-life run.
    setWvKey((k) => k + 1);
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
          key={wvKey}
          src={gameSrc}
          title={IFRAME_TITLE}
          style={{ border: 'none', width: '100%', height: '100%' } as any}
          allow="autoplay"
        />
      );
    }
    return (
      <WebView
        key={wvKey}
        ref={wvRef}
        source={{ uri: gameSrc }}
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
  const showVS = showQueue || mode === 'matchfound';
  const showGame = mode === 'playing' || mode === 'practice';
  const showBanners = showVS || showGame;
  const matchFound = mode === 'matchfound';

  // Keep ONE WebView mounted across queue → matchfound → playing → gameover so it
  // never remounts (reloads) at match start. It's just toggled visible vs offscreen.
  const gameVisible = showGame;
  const gameMounted = isPracticeParam ? showGame : (showVS || showGame || mode === 'gameover');

  // Stake-fly interpolations (left chip slides right into pot, right chip slides left).
  const leftChipX = flyProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 44] });
  const rightChipX = flyProgress.interpolate({ inputRange: [0, 1], outputRange: [0, -44] });
  const chipOpacity = flyProgress.interpolate({ inputRange: [0, 0.55, 1], outputRange: [1, 1, 0.15] });
  const potScale = flyProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.16] });
  const glowOpacity = vsGlow.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.85] });
  const glowScale = vsGlow.interpolate({ inputRange: [0, 1], outputRange: [1, 1.28] });

  const rightName = matchFound ? opponentName : flicker;
  const rightSeed = matchFound ? opponentName : flicker;

  const vsContent = (
    <View style={styles.vsBody}>
      <Text style={styles.vsHeader}>{matchFound ? 'MATCH FOUND!' : 'FINDING MATCH'}</Text>
      <Text style={styles.vsSub}>
        Staking {tier.toLocaleString()} PT · winner takes {cfg.winnerTickets} tickets
      </Text>

      <View style={styles.vsRow}>
        {/* Left — you */}
        <View style={styles.playerCol}>
          <PlayerAvatar name={myName} seed={myId} uri={myAvatarUri} ring={Colors.gold} />
          <Text style={styles.playerName} numberOfLines={1}>{myName}</Text>
          <Text style={styles.playerTag}>YOU</Text>
        </View>

        {/* Center — glowing VS */}
        <View style={styles.vsCenter}>
          <Animated.View style={[styles.vsGlow, { opacity: glowOpacity, transform: [{ scale: glowScale }] }]} />
          <LinearGradient
            colors={[Colors.gold, Colors.neonOrange]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.vsBadge}
          >
            <Text style={styles.vsBadgeTxt}>VS</Text>
          </LinearGradient>
        </View>

        {/* Right — searching flicker → locked opponent */}
        <View style={styles.playerCol}>
          <PlayerAvatar name={rightName} seed={rightSeed} ring={Colors.neonOrange} dim={!matchFound} />
          <Text style={styles.playerName} numberOfLines={1}>{rightName}</Text>
          {matchFound ? (
            <Text style={[styles.playerTag, { color: Colors.neonOrange }]}>OPPONENT</Text>
          ) : (
            <View style={styles.searchTag}>
              <ActivityIndicator size="small" color={Colors.neonOrange} />
              <Text style={styles.searchTagTxt}>Searching…</Text>
            </View>
          )}
        </View>
      </View>

      {/* Stake pool — both stakes fly into the shared pot on match found */}
      <View style={styles.stakeArea}>
        <Animated.View style={[styles.stakeChip, { transform: [{ translateX: leftChipX }], opacity: chipOpacity }]}>
          <Text style={styles.stakeChipTxt}>{tier.toLocaleString()} PT</Text>
        </Animated.View>
        <Animated.View style={[styles.potBox, { transform: [{ scale: potScale }] }]}>
          <Ionicons name="lock-closed" size={11} color={Colors.gold} />
          <Text style={styles.potTxt}>{(tier * 2).toLocaleString()} PT</Text>
          <Text style={styles.potLabel}>PRIZE POOL</Text>
        </Animated.View>
        <Animated.View style={[styles.stakeChip, { transform: [{ translateX: rightChipX }], opacity: chipOpacity }]}>
          <Text style={styles.stakeChipTxt}>{tier.toLocaleString()} PT</Text>
        </Animated.View>
      </View>

      {/* Actions — only while searching; match-found auto-launches into the game */}
      {matchFound ? (
        <View style={styles.launchRow}>
          <ActivityIndicator size="small" color={Colors.gold} />
          <Text style={styles.launchTxt}>Get ready…</Text>
        </View>
      ) : (
        <View style={styles.vsActions}>
          <Pressable style={styles.primaryBtn} onPress={goPractice} testID="arcade-play-practice">
            <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
              <Ionicons name="game-controller" size={18} color="#1a1200" />
              <Text style={styles.primaryBtnTxt}>Practice Offline</Text>
            </LinearGradient>
          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={leave}><Text style={styles.ghostBtnTxt}>Cancel</Text></Pressable>
        </View>
      )}
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + webTop }]}>
      {/* TOP banner — matchmaking + gameplay */}
      {showBanners && <View style={styles.bannerTop}><InlineBannerAd /></View>}

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

      {/* Body — the game surface, the VS screen, and the warm (hidden) WebView */}
      <View style={styles.body}>
        {showVS && vsContent}
        {gameMounted && (
          <View
            style={gameVisible ? styles.gameArea : styles.gameHidden}
            pointerEvents={gameVisible ? 'auto' : 'none'}
          >
            {renderGame()}
          </View>
        )}
      </View>

      {/* BOTTOM banner — matchmaking + gameplay */}
      {showBanners && <View style={styles.bannerBottom}><InlineBannerAd /></View>}

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

      {/* KYC gate — online match is deep-linkable; block until verified */}
      <KycGateModal
        visible={showKycGate}
        feature="multiplayer"
        onClose={() => {
          if (router.canGoBack()) router.back();
          else router.replace('/(tabs)' as any);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },
  body: { flex: 1 },
  bannerTop: { alignItems: 'center' },
  bannerBottom: { alignItems: 'center' },
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

  /* VS matchmaking screen */
  vsBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, gap: 6 },
  vsHeader: { color: Colors.textPrimary, fontSize: 22, fontWeight: '900', letterSpacing: 1, textAlign: 'center' },
  vsSub: { color: Colors.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: 18 },
  vsRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%', maxWidth: 420 },
  playerCol: { flex: 1, alignItems: 'center', gap: 8 },
  playerName: { color: Colors.textPrimary, fontSize: 15, fontWeight: '800', maxWidth: 120, textAlign: 'center' },
  playerTag: { color: Colors.gold, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  searchTag: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  searchTagTxt: { color: Colors.neonOrange, fontSize: 11, fontWeight: '700' },
  vsCenter: { width: 78, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  vsGlow: { position: 'absolute', width: 66, height: 66, borderRadius: 33, backgroundColor: 'rgba(255,107,0,0.45)' },
  vsBadge: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'rgba(255,255,255,0.25)' },
  vsBadgeTxt: { color: '#1a1200', fontSize: 20, fontWeight: '900', letterSpacing: 0.5 },

  /* Stake pool */
  stakeArea: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 30, minHeight: 66 },
  stakeChip: { backgroundColor: Colors.darkCard, borderColor: 'rgba(244,196,48,0.4)', borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  stakeChipTxt: { color: Colors.gold, fontSize: 14, fontWeight: '800' },
  potBox: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(244,196,48,0.12)', borderColor: 'rgba(244,196,48,0.55)', borderWidth: 1.5, borderRadius: 16, paddingHorizontal: 18, paddingVertical: 8, minWidth: 96 },
  potTxt: { color: Colors.gold, fontSize: 18, fontWeight: '900' },
  potLabel: { color: Colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginTop: 1 },

  vsActions: { width: '100%', maxWidth: 320, alignItems: 'center', marginTop: 26 },
  launchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 26 },
  launchTxt: { color: Colors.textSecondary, fontSize: 14, fontWeight: '700' },

  waitBanner: { position: 'absolute', left: 16, right: 16, bottom: 96, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(10,10,15,0.92)', borderColor: Colors.darkBorder, borderWidth: 1, borderRadius: 14, padding: 12 },
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
