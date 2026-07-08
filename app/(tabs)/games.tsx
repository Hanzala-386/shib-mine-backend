/* Game Arena tab — cyberpunk entry hub: Solo Play (Knife Hit) vs Multiplayer Hub. */

import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Platform, ScrollView, DeviceEventEmitter,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';
import { useWallet } from '@/context/WalletContext';
import TicketIcon from '@/components/TicketIcon';
import LightningBorder from '@/components/LightningBorder';
import FloatingImage from '@/components/FloatingImage';

const KNIFE = require('@/assets/images/knife_cyber.png');
const TROPHY = require('@/assets/images/trophy_gold.png');

const SOLO_H = 200;
const MP_H = 132;

// ── Faint binary rain backdrop ───────────────────────────────────────────────
function binaryStr(n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += (Math.random() < 0.5 ? '0' : '1') + '\n';
  return s;
}

function NebulaBg() {
  const cols = useMemo(() => [binaryStr(46), binaryStr(46), binaryStr(46)], []);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={['#0B1026', '#0A0A14', '#070510']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.blob, { backgroundColor: 'rgba(37,213,255,0.10)', top: -50, left: -60, width: 260, height: 260 }]} />
      <View style={[styles.blob, { backgroundColor: 'rgba(160,90,255,0.13)', top: 150, right: -80, width: 300, height: 300 }]} />
      <View style={[styles.blob, { backgroundColor: 'rgba(255,107,0,0.07)', bottom: 20, left: -50, width: 240, height: 240 }]} />
      <Text style={[styles.binary, { left: 8, top: 90 }]}>{cols[0]}</Text>
      <Text style={[styles.binary, { right: 10, top: 40 }]}>{cols[1]}</Text>
      <Text style={[styles.binary, { right: 26, bottom: 10 }]}>{cols[2]}</Text>
    </View>
  );
}

// ── Circular header icon button ──────────────────────────────────────────────
function IconCircle({
  icon, ring, tint, onPress, testID,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  ring: string;
  tint: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.iconCircle, { borderColor: ring, shadowColor: ring, opacity: pressed ? 0.75 : 1 }]}
    >
      <LinearGradient
        colors={[ring + '2E', 'rgba(10,9,18,0.6)']}
        start={{ x: 0.3, y: 0 }}
        end={{ x: 0.7, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Ionicons name={icon} size={21} color={tint} />
    </Pressable>
  );
}

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens, hitTickets } = useWallet();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;
  const [soloW, setSoloW] = useState(0);

  return (
    <View style={styles.root}>
      <NebulaBg />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + webTop + 12, paddingHorizontal: 16, paddingBottom: 32 + webBottom }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header + icon column */}
        <View style={styles.topRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Game Arena</Text>
            <Text style={styles.subtitle}>Play solo or battle for real rewards</Text>

            <View style={styles.balanceRow}>
              <View style={styles.balancePill}>
                <Ionicons name="flash" size={15} color={Colors.gold} />
                <Text style={styles.balanceTxt}>{powerTokens.toLocaleString()} PT</Text>
              </View>
              <Pressable style={styles.balancePill} onPress={() => router.push('/redeem')} testID="games-tickets">
                <TicketIcon size={15} color={Colors.gold} />
                <Text style={styles.balanceTxt}>{hitTickets.toLocaleString()} Tickets</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.iconCol}>
            <IconCircle icon="gift" ring={Colors.gold} tint={Colors.gold} onPress={() => router.push('/invite')} testID="games-icon-gift" />
            <IconCircle icon="gift" ring={Colors.neonOrange} tint={Colors.neonOrangeLight} onPress={() => router.push('/notifications')} testID="games-icon-bonus" />
            <IconCircle icon="headset" ring="#A06BFF" tint="#C9A6FF" onPress={() => DeviceEventEmitter.emit('shiba:open-support')} testID="games-icon-support" />
          </View>
        </View>

        {/* Solo Play */}
        <Pressable onPress={() => router.push('/solo-play')} testID="mode-solo" style={({ pressed }) => [{ opacity: pressed ? 0.94 : 1 }]}>
          <View style={styles.soloWrap}>
            <LinearGradient
              colors={[Colors.steelLight, Colors.steel, Colors.steelDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.metalFrame}
              onLayout={(e) => setSoloW(e.nativeEvent.layout.width)}
            >
              {/* corner rivets */}
              <View style={[styles.rivet, { top: 8, left: 8 }]} />
              <View style={[styles.rivet, { top: 8, right: 8 }]} />
              <View style={[styles.rivet, { bottom: 8, left: 8 }]} />
              <View style={[styles.rivet, { bottom: 8, right: 8 }]} />

              <LinearGradient
                colors={['#FF9A2E', '#FF6B00', '#B84A05']}
                start={{ x: 0.2, y: 0 }}
                end={{ x: 0.9, y: 1 }}
                style={styles.innerFace}
              >
                <View style={styles.boltTile}>
                  <Ionicons name="flash" size={40} color="#FFD35A" style={styles.boltGlow} />
                </View>
                <View style={styles.cardTexts}>
                  <Text style={styles.cardTitle}>Solo Play</Text>
                  <Text style={styles.cardSub}>Knife Hit · earn Power Tokens</Text>
                </View>
              </LinearGradient>
            </LinearGradient>

            {soloW > 0 && (
              <LightningBorder
                width={soloW}
                height={SOLO_H}
                radius={22}
                pad={16}
                color={Colors.neonOrange}
                glowColor="#FF3D00"
                core="#FFE7C2"
              />
            )}

            <FloatingImage source={KNIFE} width={200} height={150} amplitude={9} rotate={4} duration={2300} style={styles.knife} />
          </View>
        </Pressable>

        {/* Multiplayer Hub */}
        <Pressable onPress={() => router.push('/hub')} testID="mode-multiplayer" style={({ pressed }) => [{ opacity: pressed ? 0.94 : 1 }]}>
          <View style={styles.mpWrap}>
            <LinearGradient
              colors={[Colors.goldLight, Colors.gold, Colors.bronze]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.metalFrameGold}
            >
              <View style={[styles.rivetGold, { top: 8, left: 8 }]} />
              <View style={[styles.rivetGold, { top: 8, right: 8 }]} />
              <View style={[styles.rivetGold, { bottom: 8, left: 8 }]} />
              <View style={[styles.rivetGold, { bottom: 8, right: 8 }]} />

              <LinearGradient
                colors={['#FCE38A', '#F4C430', '#D9A317']}
                start={{ x: 0.2, y: 0 }}
                end={{ x: 0.9, y: 1 }}
                style={styles.innerFaceGold}
              >
                <View style={styles.trophyTile}>
                  <Ionicons name="trophy" size={34} color="#8A5A00" />
                </View>
                <View style={styles.cardTexts}>
                  <Text style={[styles.cardTitle, { color: '#2A1B00' }]}>Multiplayer Hub</Text>
                  <Text style={[styles.cardSub, { color: 'rgba(42,27,0,0.72)' }]}>Flappy Bounce & Fruit Cut · win Hit Tickets</Text>
                </View>
              </LinearGradient>
            </LinearGradient>

            <FloatingImage source={TROPHY} width={148} height={140} amplitude={7} rotate={3} duration={2600} style={styles.trophy} />
          </View>
        </Pressable>

        {/* Redemption Center */}
        <Pressable onPress={() => router.push('/redeem')} testID="games-redeem" style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1 }]}>
          <LinearGradient
            colors={['#3A2E7A', '#241C52']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.redeemPill}
          >
            <Ionicons name="swap-horizontal" size={20} color={Colors.gold} />
            <Text style={styles.redeemTxt}>Redemption Center</Text>
            <View style={styles.chevrons}>
              <Ionicons name="chevron-forward" size={18} color={Colors.gold} />
              <Ionicons name="chevron-forward" size={18} color={Colors.gold} style={{ marginLeft: -10 }} />
            </View>
          </LinearGradient>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },
  blob: { position: 'absolute', borderRadius: 999 },
  binary: {
    position: 'absolute',
    color: 'rgba(120,200,255,0.06)',
    fontSize: 12,
    lineHeight: 16,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },

  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  title: {
    color: Colors.textPrimary,
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: 0.5,
    textShadowColor: 'rgba(244,196,48,0.35)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4 },

  balanceRow: { flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' },
  balancePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(18,18,26,0.72)',
    borderColor: 'rgba(244,196,48,0.55)',
    borderWidth: 1.5,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 22,
    ...Platform.select({
      ios: { shadowColor: Colors.gold, shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
  balanceTxt: { color: Colors.textPrimary, fontSize: 14, fontWeight: '800' },

  iconCol: { gap: 12, alignItems: 'center', paddingTop: 2 },
  iconCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowOpacity: 0.7, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
      android: { elevation: 6 },
      default: {},
    }),
  },

  // Solo card
  soloWrap: { height: SOLO_H, marginTop: 34, marginBottom: 22 },
  metalFrame: { height: SOLO_H, borderRadius: 22, padding: 6 },
  innerFace: { flex: 1, borderRadius: 16, overflow: 'hidden', padding: 18 },
  rivet: {
    position: 'absolute',
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: Colors.steelLight,
    borderWidth: 1,
    borderColor: 'rgba(20,20,30,0.55)',
    zIndex: 2,
  },
  boltTile: {
    position: 'absolute',
    top: 16,
    left: 16,
    width: 70,
    height: 70,
    borderRadius: 16,
    backgroundColor: 'rgba(120,45,0,0.5)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,190,80,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boltGlow: {
    ...Platform.select({
      ios: { shadowColor: '#FFB020', shadowOpacity: 0.9, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
  cardTexts: { position: 'absolute', left: 18, bottom: 16, right: 18 },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  cardSub: { color: 'rgba(255,242,228,0.92)', fontSize: 13, marginTop: 3, fontWeight: '700' },
  knife: { position: 'absolute', top: -24, right: -6, zIndex: 6 },

  // Multiplayer card
  mpWrap: { height: MP_H, marginTop: 30, marginBottom: 22 },
  metalFrameGold: { height: MP_H, borderRadius: 22, padding: 6 },
  innerFaceGold: { flex: 1, borderRadius: 16, overflow: 'hidden', padding: 16 },
  rivetGold: {
    position: 'absolute',
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: Colors.goldLight,
    borderWidth: 1,
    borderColor: 'rgba(90,60,0,0.5)',
    zIndex: 2,
  },
  trophyTile: {
    position: 'absolute',
    top: 14,
    left: 14,
    width: 60,
    height: 60,
    borderRadius: 15,
    backgroundColor: 'rgba(90,60,0,0.18)',
    borderWidth: 1.5,
    borderColor: 'rgba(90,60,0,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trophy: { position: 'absolute', top: -34, right: 18, zIndex: 6 },

  // Redemption
  redeemPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: 'rgba(244,196,48,0.55)',
    marginTop: 2,
  },
  redeemTxt: { color: Colors.textPrimary, fontSize: 16, fontWeight: '800' },
  chevrons: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto' },
});
