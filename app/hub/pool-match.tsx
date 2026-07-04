/* ────────────────────────────────────────────────────────────────────────────
 * 8-Ball Pool match screen.
 *
 * - Server-authoritative online play over the Game Hub WebSocket (matchmaking,
 *   turns, shot results, settlement). The pure physics module re-derives the
 *   animation frames locally from the shot the server echoes, so the replay is
 *   identical to the server's authoritative finalState.
 * - Offline PRACTICE fallback (single player vs a full rack) so the slice is
 *   fully demoable without a second player / live backend. No PT is staked and
 *   no tickets are credited in practice.
 *
 * Aiming: slingshot — drag back from the cue ball; angle points from the touch
 * toward the cue ball, power scales with pull distance. Release to shoot.
 * ──────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, PanResponder, Platform, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import Colors from '@/constants/colors';
import { pb } from '@/lib/pocketbase';
import { HubSocket } from '@/lib/hubClient';
import TicketIcon from '@/components/TicketIcon';
import PoolTable, { makeProjection, RenderBall } from '@/components/pool/PoolTable';
import {
  createRackState, simulateShot, previewCuePath, TABLE,
  type TableState, type ShotInput, type FrameSample, type SimEvent,
} from '@shared/pool/physics';
import { initPoolAudio, unloadPoolAudio, playPoolSfx, poolHaptic, type SfxKey } from '@/lib/poolSfx';
import {
  POOL_TIERS, tierConfig, type Seat, type HubServerMsg,
} from '@shared/gamehub';
import {
  applyShotRules, groupCleared, isBreakState, type Group, type RuleState,
} from '@shared/pool/rules';

type Mode = 'connecting' | 'queued' | 'playing' | 'practice' | 'gameover' | 'error';

const MAX_PULL = 300; // TABLE units of drag = full power

const toRender = (b: TableState['balls'][number]): RenderBall => ({ id: b.id, x: b.x, y: b.y, active: b.active });
const rackBalls = (s: TableState) => s.balls.map(toRender);

export default function PoolMatchScreen() {
  const insets = useSafeAreaInsets();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const params = useLocalSearchParams<{ tier?: string }>();
  const tier = Number(params.tier) || POOL_TIERS[0];
  const cfg = tierConfig(tier);

  const [mode, setMode] = useState<Mode>('connecting');
  const [statusMsg, setStatusMsg] = useState('Connecting to the arena…');
  const [errorMsg, setErrorMsg] = useState('');
  const [opponentName, setOpponentName] = useState('Opponent');
  const [youAre, setYouAre] = useState<Seat>('A');
  const [turn, setTurn] = useState<Seat>('A');
  const [ballInHand, setBallInHand] = useState(false);
  const [winner, setWinner] = useState<Seat | null>(null);
  const [wonTickets, setWonTickets] = useState(0);
  const [oppLeft, setOppLeft] = useState(false);
  const [clock, setClock] = useState<number | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [foulBanner, setFoulBanner] = useState<string | null>(null);
  const [myGroup, setMyGroup] = useState<Group | null>(null); // practice: shooter's assigned group

  const [canvas, setCanvas] = useState<{ w: number; h: number } | null>(null);
  const proj = useMemo(() => (canvas ? makeProjection(canvas.w, canvas.h) : null), [canvas]);

  const stateRef = useRef<TableState>(createRackState());
  const [displayBalls, setDisplayBalls] = useState<RenderBall[]>(() => rackBalls(stateRef.current));
  const [aim, setAim] = useState<{ angle: number; power: number } | null>(null);

  // Refs the PanResponder / async callbacks read (avoid stale closures).
  const modeRef = useRef(mode);
  const projRef = useRef(proj);
  const animatingRef = useRef(false);
  const aimRef = useRef<{ angle: number; power: number } | null>(null);
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
  const sockRef = useRef<HubSocket | null>(null);
  const matchIdRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const clockTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Practice-only local rule state (single player keeps shooting; fouls give ball-in-hand).
  const practiceRuleRef = useRef<{ openTable: boolean; shooterGroup: Group | null }>({ openTable: true, shooterGroup: null });
  const foulTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPractice = mode === 'practice';
  const myTurn = isPractice || (mode === 'playing' && turn === youAre);
  const myTurnRef = useRef(myTurn);
  const ballInHandRef = useRef(ballInHand);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { projRef.current = proj; }, [proj]);
  useEffect(() => { myTurnRef.current = myTurn; }, [myTurn]);
  useEffect(() => { ballInHandRef.current = ballInHand; }, [ballInHand]);

  // Pool is played in LANDSCAPE. Lock on mount; on unmount (incl. Android back)
  // re-lock PORTRAIT_UP — never unlockAsync, which would free the whole app.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, []);

  // Preload table SFX on mount; release on unmount.
  useEffect(() => {
    initPoolAudio();
    return () => { unloadPoolAudio(); };
  }, []);

  const syncDisplay = useCallback(() => setDisplayBalls(rackBalls(stateRef.current)), []);

  const aimPath = useMemo(
    () => (aim ? previewCuePath(stateRef.current, aim) : null),
    [aim],
  );

  /* ── shot animation (frame replay) ────────────────────────────────────── */
  const animateFrames = useCallback((frames: FrameSample[], events: SimEvent[], onDone: () => void) => {
    animatingRef.current = true;
    setAim(null);
    aimRef.current = null;
    const start = Date.now();
    const last = frames[frames.length - 1].t;
    // Fire SFX + haptics as the replay clock passes each physics event.
    const maxSpeed = Math.max(1, ...events.map((e) => e.speed || 0));
    let evi = 0;
    const fireEvent = (e: SimEvent) => {
      const key: SfxKey = e.type === 'cue_strike' ? 'strike'
        : e.type === 'ball_ball' ? 'click'
        : e.type === 'cushion' ? 'cushion' : 'pocket';
      const norm = (e.speed || 0) / maxSpeed;
      const vol = key === 'pocket' ? 0.85 : Math.max(0.25, Math.min(1, 0.3 + 0.7 * norm));
      playPoolSfx(key, vol);
      poolHaptic(key, norm > 0.5);
    };
    const loop = () => {
      const el = Date.now() - start;
      if (el >= last) {
        while (evi < events.length) { fireEvent(events[evi]); evi++; }
        const f = frames[frames.length - 1];
        setDisplayBalls(f.balls.map((b) => ({ id: b.id, x: b.x, y: b.y, active: b.a })));
        animatingRef.current = false;
        rafRef.current = null;
        onDone();
        return;
      }
      while (evi < events.length && events[evi].t <= el) { fireEvent(events[evi]); evi++; }
      let i = 0;
      while (i < frames.length - 1 && frames[i + 1].t <= el) i++;
      const f0 = frames[i];
      const f1 = frames[Math.min(i + 1, frames.length - 1)];
      const span = Math.max(1, f1.t - f0.t);
      const k = Math.max(0, Math.min(1, (el - f0.t) / span));
      const balls = f0.balls.map((b0) => {
        const b1 = f1.balls.find((x) => x.id === b0.id) ?? b0;
        return { id: b0.id, x: b0.x + (b1.x - b0.x) * k, y: b0.y + (b1.y - b0.y) * k, active: b0.a };
      });
      setDisplayBalls(balls);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  /* ── clock ────────────────────────────────────────────────────────────── */
  const stopClock = useCallback(() => {
    if (clockTimerRef.current) { clearInterval(clockTimerRef.current); clockTimerRef.current = null; }
    setClock(null);
  }, []);
  const startClock = useCallback((endsAt: number) => {
    stopClock();
    const tick = () => setClock(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    tick();
    clockTimerRef.current = setInterval(tick, 500);
  }, [stopClock]);

  const showFoul = useCallback((reason: string) => {
    setFoulBanner(reason);
    if (foulTimerRef.current) clearTimeout(foulTimerRef.current);
    foulTimerRef.current = setTimeout(() => setFoulBanner(null), 2600);
  }, []);

  /* ── practice resolution (SHARED authoritative rules) ─────────────────── */
  const resolvePractice = useCallback((res: ReturnType<typeof simulateShot>) => {
    // Compute the transition from the state BEFORE the balls settled.
    const preState = stateRef.current;
    const rule = practiceRuleRef.current;
    const rs: RuleState = {
      openTable: rule.openTable,
      shooterGroup: rule.shooterGroup,
      shooterOnEight: rule.shooterGroup !== null && groupCleared(preState, rule.shooterGroup),
      isBreak: isBreakState(preState),
    };
    const tr = applyShotRules(rs, res);
    stateRef.current = res.finalState;

    // Open-table group assignment.
    if (tr.assignedGroup) {
      rule.shooterGroup = tr.assignedGroup;
      rule.openTable = false;
      setMyGroup(tr.assignedGroup);
    }

    // 8-ball resolution ends the game.
    if (tr.gameOver) {
      setWinner(tr.gameOver.shooterWins ? 'A' : 'B');
      setWonTickets(tr.gameOver.shooterWins ? cfg.winnerTickets : 0);
      syncDisplay();
      setMode('gameover');
      stopClock();
      return;
    }

    // On a foul the single player keeps shooting but with ball-in-hand + a toast.
    if (tr.foul) {
      if (res.cuePocketed) {
        const cue = stateRef.current.balls.find((b) => b.id === 0);
        if (cue) { cue.active = true; cue.x = TABLE.PLAY_W * 0.25; cue.y = TABLE.PLAY_H / 2; cue.vx = 0; cue.vy = 0; }
      }
      setBallInHand(true);
      showFoul(tr.foulReason ?? 'Foul');
    } else {
      setBallInHand(false);
    }
    syncDisplay();
  }, [cfg.winnerTickets, stopClock, syncDisplay, showFoul]);

  /* ── shooting ─────────────────────────────────────────────────────────── */
  const shoot = useCallback((angle: number, power: number) => {
    if (animatingRef.current) return;
    const shot: ShotInput = { angle, power: Math.max(0, Math.min(1, power)) };
    if (modeRef.current === 'practice') {
      const res = simulateShot(stateRef.current, shot);
      animateFrames(res.frames, res.events, () => resolvePractice(res));
    } else if (modeRef.current === 'playing') {
      sockRef.current?.send({ type: 'SHOT', matchId: matchIdRef.current, shot });
    }
  }, [animateFrames, resolvePractice]);

  const placeCue = useCallback((sx: number, sy: number) => {
    const p = projRef.current;
    if (!p) return;
    const t = p.toTable(sx, sy);
    const R = TABLE.BALL_R;
    const x = Math.max(R, Math.min(TABLE.PLAY_W - R, t.x));
    const y = Math.max(R, Math.min(TABLE.PLAY_H - R, t.y));
    const cue = stateRef.current.balls.find((b) => b.id === 0);
    if (cue) { cue.active = true; cue.x = x; cue.y = y; }
    syncDisplay();
    setBallInHand(false);
    if (modeRef.current === 'playing') {
      sockRef.current?.send({ type: 'PLACE_CUE', matchId: matchIdRef.current, x, y });
    }
  }, [syncDisplay]);

  /* ── server messages ──────────────────────────────────────────────────── */
  const onServerMsg = useCallback((msg: HubServerMsg) => {
    switch (msg.type) {
      case 'QUEUED':
        setMode('queued'); setStatusMsg('Finding an opponent…'); break;
      case 'MATCH_FOUND':
        matchIdRef.current = msg.matchId;
        setYouAre(msg.youAre);
        setTurn(msg.turn);
        setBallInHand(msg.ballInHand ?? false); // resume after an opponent scratch inherits ball-in-hand
        setOpponentName(msg.opponent?.name || 'Opponent');
        stateRef.current = msg.state;
        syncDisplay();
        setMode('playing');
        break;
      case 'TURN':
        setTurn(msg.turn);
        startClock(msg.turnEndsAt);
        break;
      case 'SHOT_RESULT': {
        const res = simulateShot(stateRef.current, msg.shot);
        animateFrames(res.frames, res.events, () => {
          stateRef.current = msg.finalState;
          syncDisplay();
          setTurn(msg.nextTurn);
          setBallInHand(msg.ballInHand);
        });
        break;
      }
      case 'GAME_OVER':
        setWinner(msg.winner);
        setWonTickets(msg.winnerTickets);
        setMode('gameover');
        stopClock();
        break;
      case 'OPPONENT_LEFT': setOppLeft(true); break;
      case 'OPPONENT_BACK': setOppLeft(false); break;
      case 'REFUND': setErrorMsg(`Match refunded (${msg.reason}). ${msg.amountPT} PT returned.`); setMode('error'); break;
      case 'ERROR': setErrorMsg(msg.message || 'Server error'); break;
      default: break;
    }
  }, [animateFrames, startClock, stopClock, syncDisplay]);

  /* ── connect on mount ─────────────────────────────────────────────────── */
  useEffect(() => {
    const token = pb.authStore.token;
    const pbId = pb.authStore.record?.id || pb.authStore.model?.id;
    const sock = new HubSocket({
      onOpen: (isReconnect) => {
        if (!token || !pbId) { setStatusMsg('Sign in required for online play'); return; }
        if (isReconnect && matchIdRef.current) {
          // Re-attach to the live match instead of re-queuing — preserves the staked PT.
          setReconnecting(false);
          sock.send({ type: 'RESUME', token, pbId, matchId: matchIdRef.current });
        } else {
          setStatusMsg('Finding an opponent…');
          sock.send({ type: 'JOIN_QUEUE', token, pbId, game: 'pool8', tier });
        }
      },
      onMessage: onServerMsg,
      onError: () => { if (modeRef.current === 'connecting') setStatusMsg('Arena unavailable — you can still practice'); },
      onClose: () => { /* reconnect is handled inside HubSocket; keep current UI */ },
      onReconnecting: () => { if (matchIdRef.current && modeRef.current === 'playing') setReconnecting(true); },
      onReconnectGaveUp: () => {
        setReconnecting(false);
        if (modeRef.current === 'playing') { setErrorMsg('Lost connection to the match.'); setMode('error'); }
      },
    });
    sockRef.current = sock;
    sock.connect();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (clockTimerRef.current) clearInterval(clockTimerRef.current);
      if (foulTimerRef.current) clearTimeout(foulTimerRef.current);
      sock.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── gestures ─────────────────────────────────────────────────────────── */
  const fnRef = useRef({ shoot, placeCue });
  useEffect(() => { fnRef.current = { shoot, placeCue }; }, [shoot, placeCue]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => myTurnRef.current && !animatingRef.current,
      onMoveShouldSetPanResponder: () => myTurnRef.current && !animatingRef.current,
      onPanResponderMove: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        lastTouchRef.current = { x: locationX, y: locationY };
        const p = projRef.current;
        if (!p) return;
        if (ballInHandRef.current) return; // placing, no aim preview
        const t = p.toTable(locationX, locationY);
        const cue = stateRef.current.balls.find((b) => b.id === 0);
        if (!cue || !cue.active) return;
        const angle = Math.atan2(cue.y - t.y, cue.x - t.x);
        const dist = Math.hypot(cue.x - t.x, cue.y - t.y);
        const power = Math.max(0, Math.min(1, dist / MAX_PULL));
        const a = { angle, power };
        aimRef.current = a;
        setAim(a);
      },
      onPanResponderRelease: () => {
        const lt = lastTouchRef.current;
        if (ballInHandRef.current && lt) { fnRef.current.placeCue(lt.x, lt.y); return; }
        const a = aimRef.current;
        setAim(null);
        aimRef.current = null;
        if (a && a.power > 0.06) fnRef.current.shoot(a.angle, a.power);
      },
      onPanResponderTerminate: () => { setAim(null); aimRef.current = null; },
    }),
  ).current;

  /* ── actions ──────────────────────────────────────────────────────────── */
  const startPractice = useCallback(() => {
    sockRef.current?.close();
    stateRef.current = createRackState();
    practiceRuleRef.current = { openTable: true, shooterGroup: null };
    syncDisplay();
    setWinner(null);
    setWonTickets(0);
    setBallInHand(false);
    setMyGroup(null);
    setFoulBanner(null);
    setMode('practice');
  }, [syncDisplay]);

  const leave = useCallback(() => {
    sockRef.current?.close();
    router.back();
  }, []);

  const playAgain = useCallback(() => {
    router.replace({ pathname: '/hub/pool-match', params: { tier: String(tier) } } as any);
  }, [tier]);

  /* ── render ───────────────────────────────────────────────────────────── */
  const showQueue = mode === 'connecting' || mode === 'queued';
  const groupLabel = myGroup ? (myGroup === 'solids' ? 'Solids' : 'Stripes') : 'Open table';
  const turnLabel = isPractice ? `Practice · ${groupLabel}` : myTurn ? 'Your shot' : `${opponentName}'s shot`;

  return (
    <View style={[styles.root, { paddingTop: insets.top + webTop }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={leave} hitSlop={12} style={styles.iconBtn} testID="match-back">
          <Ionicons name="close" size={22} color={Colors.textSecondary} />
        </Pressable>
        <View style={styles.headCenter}>
          <Text style={styles.headTitle}>8-Ball · {cfg.label}</Text>
          <View style={styles.headReward}>
            <TicketIcon size={12} color={Colors.gold} />
            <Text style={styles.headRewardTxt}>{cfg.winnerTickets} to win</Text>
          </View>
        </View>
        <View style={styles.iconBtn} />
      </View>

      {/* Turn bar */}
      <View style={styles.turnBar}>
        <View style={[styles.turnDot, { backgroundColor: myTurn ? Colors.success : Colors.textMuted }]} />
        <Text style={[styles.turnTxt, { color: myTurn ? Colors.success : Colors.textSecondary }]}>{turnLabel}</Text>
        {clock !== null && mode === 'playing' && (
          <Text style={styles.clockTxt}>{clock}s</Text>
        )}
      </View>

      {/* Table */}
      <View
        style={styles.tableArea}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setCanvas({ w: width, h: height });
        }}
      >
        {proj && <PoolTable proj={proj} balls={displayBalls} aimPath={aimPath} showGhost={!!aim} aim={aim} />}
        {proj && <View style={StyleSheet.absoluteFill} {...pan.panHandlers} />}

        {ballInHand && myTurn && (
          <View style={styles.hint} pointerEvents="none">
            <Text style={styles.hintTxt}>Tap to place the cue ball</Text>
          </View>
        )}

        {/* Power meter */}
        {aim && (
          <View style={styles.powerWrap} pointerEvents="none">
            <View style={[styles.powerFill, { height: `${Math.round(aim.power * 100)}%` }]} />
          </View>
        )}
      </View>

      {/* Footer hint */}
      {(mode === 'playing' || mode === 'practice') && !ballInHand && (
        <Text style={styles.footHint}>
          {myTurn ? 'Drag back from the cue ball, release to shoot' : 'Waiting for your opponent…'}
        </Text>
      )}

      {/* Opponent-left banner */}
      {oppLeft && mode === 'playing' && !reconnecting && (
        <View style={styles.oppBanner}>
          <ActivityIndicator color={Colors.gold} size="small" />
          <Text style={styles.oppBannerTxt}>Opponent disconnected — waiting for reconnect…</Text>
        </View>
      )}

      {/* Own-reconnect banner */}
      {reconnecting && mode === 'playing' && (
        <View style={styles.oppBanner}>
          <ActivityIndicator color={Colors.gold} size="small" />
          <Text style={styles.oppBannerTxt}>Reconnecting…</Text>
        </View>
      )}

      {/* Foul toast */}
      {foulBanner && (
        <View style={styles.foulBanner} pointerEvents="none">
          <Ionicons name="warning" size={14} color="#1a1200" />
          <Text style={styles.foulBannerTxt}>{foulBanner} — ball in hand</Text>
        </View>
      )}

      {/* Queue / connecting overlay */}
      {showQueue && (
        <View style={styles.overlay}>
          <ActivityIndicator color={Colors.gold} size="large" />
          <Text style={styles.overlayTitle}>{statusMsg}</Text>
          <Text style={styles.overlaySub}>Staking {tier.toLocaleString()} PT · winner takes {cfg.winnerTickets} tickets</Text>
          <Pressable style={styles.primaryBtn} onPress={startPractice} testID="play-practice">
            <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
              <Ionicons name="game-controller" size={18} color="#1a1200" />
              <Text style={styles.primaryBtnTxt}>Practice Offline</Text>
            </LinearGradient>
          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={leave}><Text style={styles.ghostBtnTxt}>Cancel</Text></Pressable>
        </View>
      )}

      {/* Error overlay */}
      {mode === 'error' && (
        <View style={styles.overlay}>
          <Ionicons name="alert-circle" size={40} color={Colors.error} />
          <Text style={styles.overlayTitle}>{errorMsg || 'Something went wrong'}</Text>
          <Pressable style={styles.primaryBtn} onPress={startPractice}>
            <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
              <Text style={styles.primaryBtnTxt}>Practice Offline</Text>
            </LinearGradient>
          </Pressable>
          <Pressable style={styles.ghostBtn} onPress={leave}><Text style={styles.ghostBtnTxt}>Back to Lobby</Text></Pressable>
        </View>
      )}

      {/* Game over overlay */}
      {mode === 'gameover' && (
        <View style={styles.overlay}>
          {(() => {
            const iWon = isPractice ? winner === 'A' : winner === youAre;
            return (
              <>
                <Ionicons name={iWon ? 'trophy' : 'sad-outline'} size={48} color={iWon ? Colors.gold : Colors.textMuted} />
                <Text style={styles.overlayTitle}>{iWon ? 'You win!' : 'You lost'}</Text>
                {iWon && (wonTickets > 0 || isPractice) ? (
                  <View style={styles.wonRow}>
                    <TicketIcon size={20} color={Colors.gold} />
                    <Text style={styles.wonTxt}>+{isPractice ? cfg.winnerTickets : wonTickets} Hit Tickets</Text>
                  </View>
                ) : null}
                {isPractice && <Text style={styles.overlaySub}>Practice — no tickets were credited</Text>}
                <Pressable style={styles.primaryBtn} onPress={playAgain}>
                  <LinearGradient colors={[Colors.gold, Colors.neonOrange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
                    <Ionicons name="refresh" size={18} color="#1a1200" />
                    <Text style={styles.primaryBtnTxt}>Play Again</Text>
                  </LinearGradient>
                </Pressable>
                <Pressable style={styles.ghostBtn} onPress={leave}><Text style={styles.ghostBtnTxt}>Back to Lobby</Text></Pressable>
              </>
            );
          })()}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 8 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headCenter: { flex: 1, alignItems: 'center' },
  headTitle: { color: Colors.textPrimary, fontSize: 16, fontWeight: '700' },
  headReward: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  headRewardTxt: { color: Colors.gold, fontSize: 12, fontWeight: '600' },
  turnBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 6 },
  turnDot: { width: 8, height: 8, borderRadius: 4 },
  turnTxt: { fontSize: 13, fontWeight: '700' },
  clockTxt: { color: Colors.textSecondary, fontSize: 13, fontWeight: '600', marginLeft: 4 },
  tableArea: { flex: 1, marginHorizontal: 8, position: 'relative' },
  hint: { position: 'absolute', top: 12, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  hintTxt: { color: Colors.textPrimary, fontSize: 12, fontWeight: '600' },
  powerWrap: { position: 'absolute', right: 6, top: '25%', height: '50%', width: 10, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 5, justifyContent: 'flex-end', overflow: 'hidden' },
  powerFill: { width: '100%', backgroundColor: Colors.neonOrange, borderRadius: 5 },
  footHint: { color: Colors.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 10 },
  oppBanner: { position: 'absolute', top: 100, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.darkCard, borderColor: Colors.darkBorder, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
  oppBannerTxt: { color: Colors.textSecondary, fontSize: 12 },
  foulBanner: { position: 'absolute', top: 62, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.neonOrange, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, shadowColor: Colors.neonOrange, shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  foulBannerTxt: { color: '#1a1200', fontSize: 13, fontWeight: '800' },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,10,15,0.92)', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  overlayTitle: { color: Colors.textPrimary, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  overlaySub: { color: Colors.textSecondary, fontSize: 13, textAlign: 'center' },
  wonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wonTxt: { color: Colors.gold, fontSize: 18, fontWeight: '800' },
  primaryBtn: { width: '80%', maxWidth: 320, marginTop: 6 },
  primaryBtnBg: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 14 },
  primaryBtnTxt: { color: '#1a1200', fontSize: 15, fontWeight: '800' },
  ghostBtn: { paddingVertical: 10, paddingHorizontal: 20 },
  ghostBtnTxt: { color: Colors.textSecondary, fontSize: 14, fontWeight: '600' },
});
