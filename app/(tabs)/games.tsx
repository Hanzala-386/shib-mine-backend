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
const GAME_URL     = `${getApiUrl()}/arcade/index.html`;
const SETTINGS_URL = `${getApiUrl()}/api/app/settings`;

// ─── Ad network types ─────────────────────────────────────────────────────────
type AdNetwork = 'admob' | 'unity' | 'applovin';
const ALL_NETWORKS: AdNetwork[] = ['admob', 'unity', 'applovin'];

interface AdSettings {
  showAds:            boolean;
  activeAdNetwork:    string;
  admobUnitId:        string;
  applovinRewardedId: string;
  applovinSdkKey:     string;
  unityGameId:        string;
  unityRewardedId:    string;
}

const DEFAULT_AD_SETTINGS: AdSettings = {
  showAds: false, activeAdNetwork: '',
  admobUnitId: '', applovinRewardedId: '', applovinSdkKey: '',
  unityGameId: '', unityRewardedId: '',
};

// Returns networks in priority order based on active_ad_network setting
function networkOrder(active: string): AdNetwork[] {
  const key = active.toLowerCase();
  const prio: AdNetwork | null =
    key.includes('admob') ? 'admob' :
    key.includes('unity') ? 'unity' :
    key.includes('applovin') || key.includes('max') ? 'applovin' : null;

  if (!prio) return ALL_NETWORKS;
  return [prio, ...ALL_NETWORKS.filter(n => n !== prio)];
}

// Simulated ad (web/Expo Go stub — replace with real SDK in custom build)
function showSimulatedAd(
  type: 'interstitial' | 'rewarded',
  network: AdNetwork,
  settings: AdSettings,
  onComplete: (watched: boolean) => void,
  onFailed: () => void,
) {
  // ── Real SDK hooks (uncomment when adding native SDKs in custom build) ──
  //
  // AdMob (react-native-google-mobile-ads):
  // if (network === 'admob' && settings.admobUnitId) {
  //   const ad = type === 'interstitial'
  //     ? InterstitialAd.createForAdRequest(settings.admobUnitId)
  //     : RewardedAd.createForAdRequest(settings.admobUnitId);
  //   ad.addAdEventListener(AdEventType.CLOSED, () => onComplete(true));
  //   ad.load(); ad.show();
  //   return;
  // }
  //
  // Unity Ads (unity-ads-react-native):
  // if (network === 'unity' && settings.unityGameId) {
  //   UnityAds.initialize(settings.unityGameId);
  //   const placement = type === 'rewarded' ? settings.unityRewardedId : 'Interstitial_Android';
  //   UnityAds.show(placement, { onFinish: () => onComplete(true) });
  //   return;
  // }
  //
  // AppLovin MAX (react-native-applovin-max):
  // if (network === 'applovin' && settings.applovinSdkKey) {
  //   AppLovinMAX.initialize(settings.applovinSdkKey);
  //   const unit = type === 'rewarded' ? settings.applovinRewardedId : '';
  //   // Show ad with callbacks…
  // }

  // ── Simulation fallback (Expo Go + web preview) ──
  const ms = type === 'rewarded' ? 5000 : 3000;
  setTimeout(() => onComplete(true), ms);
}

// ─── Component ────────────────────────────────────────────────────────────────
type Phase = 'game' | 'retry_ad' | 'exit_modal' | 'claim_ad' | 'double_ad' | 'awarding' | 'reward';

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { addPowerTokens, powerTokens } = useWallet();
  const { user } = useAuth();

  const wvRef        = useRef<WebView>(null);
  const pendingScore = useRef(0);
  const adSettings   = useRef<AdSettings>(DEFAULT_AD_SETTINGS);
  const networkQueue = useRef<AdNetwork[]>(ALL_NETWORKS);
  const netIndex     = useRef(0);

  const [phase,     setPhase]     = useState<Phase>('game');
  const [score,     setScore]     = useState(0);
  const [earned,    setEarned]    = useState(0);
  const [adNetwork, setAdNetwork] = useState<AdNetwork>('admob');
  const [adTimer,   setAdTimer]   = useState(0);
  const [adType,    setAdType]    = useState<'interstitial' | 'rewarded'>('interstitial');
  const adIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const TOP = Platform.OS === 'web' ? 67 : insets.top;

  // ── Load ad settings from PocketBase ─────────────────────────────────────
  useEffect(() => {
    fetch(SETTINGS_URL)
      .then(r => r.json())
      .then((s) => {
        adSettings.current = {
          showAds:            !!s.showAds,
          activeAdNetwork:    s.activeAdNetwork || '',
          admobUnitId:        s.admobUnitId || '',
          applovinRewardedId: s.applovinRewardedId || '',
          applovinSdkKey:     s.applovinSdkKey || '',
          unityGameId:        s.unityGameId || '',
          unityRewardedId:    s.unityRewardedId || '',
        };
        networkQueue.current = networkOrder(s.activeAdNetwork || '');
        console.log('[Games] Ad settings loaded, network order:', networkQueue.current);
      })
      .catch(() => { /* keep defaults */ });
  }, []);

  // ── Pick next network in waterfall ───────────────────────────────────────
  const pickNetwork = useCallback((): AdNetwork => {
    const idx = netIndex.current % networkQueue.current.length;
    netIndex.current += 1;
    return networkQueue.current[idx];
  }, []);

  // ── Ad countdown helper ──────────────────────────────────────────────────
  const startCountdown = useCallback((secs: number) => {
    setAdTimer(secs);
    const iv = setInterval(() => {
      setAdTimer(t => { if (t <= 1) { clearInterval(iv); return 0; } return t - 1; });
    }, 1000);
    adIntervalRef.current = iv;
  }, []);

  const clearCountdown = useCallback(() => {
    if (adIntervalRef.current) { clearInterval(adIntervalRef.current); adIntervalRef.current = null; }
    setAdTimer(0);
  }, []);

  // ── Send a message into the WebView / iframe ─────────────────────────────
  const sendToGame = useCallback((msg: object) => {
    const json = JSON.stringify(msg);
    if (Platform.OS === 'web') {
      // postMessage into the iframe
      const frame = document.querySelector('iframe[title="Weapon Master"]') as HTMLIFrameElement | null;
      frame?.contentWindow?.postMessage(json, '*');
    } else {
      wvRef.current?.injectJavaScript(
        `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(json)}}));true;`
      );
    }
  }, []);

  // ── Tell the C3 game to resume its blocked navigation ────────────────────
  const resumeGameNavigation = useCallback(() => {
    sendToGame({ type: 'RESUME_NAVIGATION' });
  }, [sendToGame]);

  // ── RETRY: interstitial → resume game (no tokens) ────────────────────────
  const handleRetry = useCallback(() => {
    const net = pickNetwork();
    setAdNetwork(net);
    setAdType('interstitial');
    setPhase('retry_ad');
    startCountdown(3);
    showSimulatedAd('interstitial', net, adSettings.current,
      () => { clearCountdown(); resumeGameNavigation(); setPhase('game'); },
      () => { clearCountdown(); resumeGameNavigation(); setPhase('game'); }
    );
  }, [pickNetwork, startCountdown, clearCountdown, resumeGameNavigation]);

  // ── CLAIM: interstitial → add score tokens ────────────────────────────────
  const handleClaim = useCallback(() => {
    const net = pickNetwork();
    setAdNetwork(net);
    setAdType('interstitial');
    setPhase('claim_ad');
    startCountdown(3);
    showSimulatedAd('interstitial', net, adSettings.current,
      async () => {
        clearCountdown();
        setPhase('awarding');
        const pts = pendingScore.current;
        try { await addPowerTokens(pts, 'knife_hit'); } catch { /* silent */ }
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      },
      async () => {
        clearCountdown();
        setPhase('awarding');
        const pts = pendingScore.current;
        try { await addPowerTokens(pts, 'knife_hit'); } catch { /* silent */ }
        setEarned(pts);
        setPhase('reward');
      }
    );
  }, [pickNetwork, startCountdown, clearCountdown, addPowerTokens]);

  // ── DOUBLE: rewarded ad → add score × 2 tokens ───────────────────────────
  const handleDouble = useCallback(() => {
    const net = pickNetwork();
    setAdNetwork(net);
    setAdType('rewarded');
    setPhase('double_ad');
    startCountdown(5);
    showSimulatedAd('rewarded', net, adSettings.current,
      async (watched) => {
        clearCountdown();
        if (!watched) { setPhase('exit_modal'); return; }
        setPhase('awarding');
        const pts = pendingScore.current * 2;
        try { await addPowerTokens(pts, 'knife_hit'); } catch { /* silent */ }
        setEarned(pts);
        setPhase('reward');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      },
      () => { clearCountdown(); setPhase('exit_modal'); }
    );
  }, [pickNetwork, startCountdown, clearCountdown, addPowerTokens]);

  // ── PLAY AGAIN after reward ────────────────────────────────────────────────
  const playAgain = useCallback(() => {
    pendingScore.current = 0;
    setScore(0);
    setEarned(0);
    setPhase('game');
    if (Platform.OS !== 'web') wvRef.current?.reload();
    else {
      const frame = document.querySelector('iframe[title="Weapon Master"]') as HTMLIFrameElement | null;
      if (frame) frame.src = GAME_URL;
    }
  }, []);

  // ── Handle messages FROM bridge.js ────────────────────────────────────────
  const onMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'BRIDGE_READY') {
        sendToGame({ type: 'SET_MUTE', muted: false });
      }
      if (msg.type === 'EXIT_GAME') {
        // User tapped Arrow (Back) button in game → show collect modal
        const s = Math.max(0, Math.round(Number(msg.score) || 0));
        pendingScore.current = s;
        setScore(s);
        setPhase('exit_modal');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
      if (msg.type === 'RETRY_GAME') {
        // User tapped Circle (Retry) button in game → interstitial, then resume
        handleRetry();
      }
    } catch { /* ignore */ }
  }, [handleRetry, sendToGame]);

  // ── Web platform: listen for postMessage from iframe ─────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e: MessageEvent) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (!data || !data.type) return;
        if (data.type === 'BRIDGE_READY') sendToGame({ type: 'SET_MUTE', muted: false });
        if (data.type === 'EXIT_GAME') {
          const s = Math.max(0, Math.round(Number(data.score) || 0));
          pendingScore.current = s;
          setScore(s);
          setPhase('exit_modal');
        }
        if (data.type === 'RETRY_GAME') handleRetry();
      } catch { /* ignore */ }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [handleRetry, sendToGame]);

  // ── Android back button ───────────────────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase !== 'game') { setPhase('game'); return true; }
      wvRef.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, [phase]);

  // ── Clean up countdown on unmount ────────────────────────────────────────
  useEffect(() => () => { clearCountdown(); }, [clearCountdown]);

  // ── Render game (WebView native / iframe web) ─────────────────────────────
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
        style={S.webview}
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
          <View style={S.loadingOverlay}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.loadingText}>Loading Game…</Text>
          </View>
        )}
        containerStyle={{ flex: 1 }}
      />
    );
  };

  // ── Network display labels ────────────────────────────────────────────────
  const netLabel: Record<AdNetwork, string> = { admob: 'AdMob', unity: 'Unity Ads', applovin: 'AppLovin MAX' };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <View style={S.root}>

      {/* ── Game ── */}
      {renderGame()}

      {/* ── PT badge (floats over game, tap-through) ── */}
      <View style={[S.ptBadge, { top: TOP + 8 }]} pointerEvents="none">
        <Ionicons name="flash" size={13} color={Colors.gold} />
        <Text style={S.ptText}>{powerTokens} PT</Text>
      </View>

      {/* ══ EXIT MODAL (Back/Arrow button pressed) ══════════════════════════ */}
      <Modal visible={phase === 'exit_modal'} transparent animationType="slide">
        <View style={S.overlay}>
          <View style={S.card}>
            <Text style={S.cardTitle}>GAME OVER</Text>

            <View style={S.row}>
              <Text style={S.muted}>Score</Text>
              <Text style={S.bigNum}>{score}</Text>
            </View>

            <View style={S.divider} />

            <View style={S.row}>
              <Ionicons name="flash" size={20} color={Colors.gold} />
              <Text style={S.ptEarned}>{score} PT</Text>
              <Text style={S.muted}>1 point = 1 token</Text>
            </View>

            {/* Double tokens via rewarded ad */}
            {score > 0 && (
              <Pressable style={S.doubleBtn} onPress={handleDouble}>
                <Ionicons name="play-circle" size={20} color="#fff" />
                <Text style={S.doubleBtnTxt}>Watch Ad  →  Get {score * 2} PT (2×)</Text>
              </Pressable>
            )}

            {/* Standard claim */}
            <Pressable style={S.claimBtn} onPress={handleClaim}>
              <Text style={S.claimBtnTxt}>Claim {score} PT</Text>
            </Pressable>

            {/* Play again without collecting */}
            <Pressable style={S.ghost} onPress={playAgain}>
              <Text style={S.ghostTxt}>Skip & Play Again</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ══ AD MODAL (interstitial — retry or claim) ════════════════════════ */}
      <Modal visible={phase === 'retry_ad' || phase === 'claim_ad'} transparent animationType="fade">
        <View style={S.adOverlay}>
          <View style={S.adCard}>
            <View style={S.adTopBar}>
              <Text style={S.adNetLabel}>{netLabel[adNetwork]}</Text>
              {adTimer > 0 && (
                <View style={S.adTimerPill}>
                  <Text style={S.adTimerTxt}>{adTimer}s</Text>
                </View>
              )}
            </View>
            <View style={S.adBody}>
              <Ionicons name="megaphone-outline" size={52} color="rgba(255,255,255,0.2)" />
              <Text style={S.adLabel}>Advertisement</Text>
              <Text style={S.adSub}>
                {phase === 'retry_ad' ? 'Resuming game…' : 'Adding your tokens…'}
              </Text>
              <Text style={S.adHint}>
                Replace with real {netLabel[adNetwork]} SDK in custom build
              </Text>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══ REWARDED AD MODAL (double tokens) ═══════════════════════════════ */}
      <Modal visible={phase === 'double_ad'} transparent animationType="fade">
        <View style={S.adOverlay}>
          <View style={S.adCard}>
            <View style={S.adTopBar}>
              <Text style={S.adNetLabel}>{netLabel[adNetwork]}  ·  Rewarded</Text>
              {adTimer > 0 && (
                <View style={S.adTimerPill}>
                  <Text style={S.adTimerTxt}>{adTimer}s</Text>
                </View>
              )}
            </View>
            <View style={S.adBody}>
              <Ionicons name="gift-outline" size={52} color={Colors.gold} />
              <Text style={[S.adLabel, { color: Colors.gold }]}>Rewarded Video</Text>
              <Text style={S.adSub}>Watch to earn {score * 2} PT (2×)</Text>
              <Text style={S.adHint}>
                Replace with real {netLabel[adNetwork]} SDK in custom build
              </Text>
            </View>
          </View>
        </View>
      </Modal>

      {/* ══ AWARDING MODAL ══════════════════════════════════════════════════ */}
      <Modal visible={phase === 'awarding'} transparent animationType="fade">
        <View style={S.overlay}>
          <View style={S.card}>
            <ActivityIndicator size="large" color={Colors.gold} />
            <Text style={S.muted}>Saving tokens…</Text>
          </View>
        </View>
      </Modal>

      {/* ══ REWARD MODAL ════════════════════════════════════════════════════ */}
      <Modal visible={phase === 'reward'} transparent animationType="fade">
        <View style={S.overlay}>
          <View style={S.card}>
            <Text style={{ fontSize: 46 }}>🎉</Text>
            <Text style={S.cardTitle}>+{earned} PT</Text>
            <Text style={S.muted}>{powerTokens} PT total balance</Text>
            <Pressable style={S.claimBtn} onPress={playAgain}>
              <Text style={S.claimBtnTxt}>Play Again</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#000' },
  webview: { flex: 1 },

  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0a1f1c', alignItems: 'center', justifyContent: 'center', gap: 14,
  },
  loadingText: { color: Colors.textMuted, fontFamily: 'Inter_500Medium', fontSize: 14 },

  ptBadge: {
    position: 'absolute', right: 14, flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 20, zIndex: 50,
  },
  ptText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.gold },

  // Modals
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.82)', alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: '#0d1a17', borderRadius: 24, padding: 32, width: SW * 0.84,
    alignItems: 'center', gap: 16, borderWidth: 1, borderColor: 'rgba(244,196,48,0.18)',
  },
  cardTitle: { fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.text, letterSpacing: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%', justifyContent: 'space-between' },
  bigNum: { fontFamily: 'Inter_700Bold', fontSize: 36, color: Colors.text },
  ptEarned: { fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.gold },
  muted: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
  divider: { width: '100%', height: 1, backgroundColor: 'rgba(255,255,255,0.07)' },

  doubleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
    backgroundColor: '#7c3aed', paddingVertical: 14, borderRadius: 28, width: '100%',
  },
  doubleBtnTxt: { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#fff', letterSpacing: 0.5 },

  claimBtn: {
    backgroundColor: Colors.gold, paddingVertical: 14, borderRadius: 28,
    width: '100%', alignItems: 'center',
  },
  claimBtnTxt: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000', letterSpacing: 0.5 },

  ghost:    { paddingVertical: 6 },
  ghostTxt: { fontFamily: 'Inter_500Medium', fontSize: 13, color: 'rgba(255,255,255,0.30)' },

  // Ad overlay
  adOverlay: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  adCard: {
    width: SW * 0.92, backgroundColor: '#111', borderRadius: 16, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
  },
  adTopBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10, backgroundColor: 'rgba(255,255,255,0.05)',
  },
  adNetLabel: { fontFamily: 'Inter_500Medium', fontSize: 11, color: 'rgba(255,255,255,0.38)', letterSpacing: 1 },
  adTimerPill: {
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3,
  },
  adTimerTxt: { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#fff' },
  adBody: { height: SH * 0.44, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24 },
  adLabel: { fontFamily: 'Inter_700Bold', fontSize: 18, color: 'rgba(255,255,255,0.55)', letterSpacing: 1 },
  adSub:   { fontFamily: 'Inter_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.38)', textAlign: 'center' },
  adHint:  {
    fontFamily: 'Inter_400Regular', fontSize: 10, color: 'rgba(255,255,255,0.15)',
    textAlign: 'center', lineHeight: 16,
  },
});
