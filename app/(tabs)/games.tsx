/* Game Arena tab — cyberpunk entry hub: Solo Play (Knife Hit) vs Multiplayer Hub. */

import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Platform, ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
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
const SOLO_BG = require('@/assets/images/solo_card_bg.png');
const MP_BG = require('@/assets/images/mp_card_bg.png');
const REDEEM_BG = require('@/assets/images/redeem_bg.png');

// Aspect ratios of the ready-made card artwork (width / height).
const SOLO_AR = 611 / 419;
const MP_AR = 648 / 385;
const REDEEM_AR = 654 / 162;

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

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens, hitTickets } = useWallet();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;
  const [soloW, setSoloW] = useState(0);
  const soloH = soloW > 0 ? soloW / SOLO_AR : 0;

  return (
    <View style={styles.root}>
      <NebulaBg />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + webTop + 12, paddingHorizontal: 16, paddingBottom: 32 + webBottom }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
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

        {/* Solo Play — ready-made orange card + crackling lightning + floating knife */}
        <Pressable onPress={() => router.push('/solo-play')} testID="mode-solo" style={({ pressed }) => [{ opacity: pressed ? 0.94 : 1 }]}>
          <View style={styles.soloWrap}>
            <Image
              source={SOLO_BG}
              style={{ width: '100%', aspectRatio: SOLO_AR }}
              contentFit="contain"
              onLayout={(e) => setSoloW(e.nativeEvent.layout.width)}
            />
            {soloW > 0 && (
              <LightningBorder
                width={soloW}
                height={soloH}
                radius={26}
                pad={16}
                color={Colors.neonOrange}
                glowColor="#FF3D00"
                core="#FFE7C2"
              />
            )}
            <FloatingImage source={KNIFE} width={200} height={150} amplitude={9} rotate={4} duration={2300} style={styles.knife} />
          </View>
        </Pressable>

        {/* Multiplayer Hub — ready-made golden card + floating trophy */}
        <Pressable onPress={() => router.push('/hub')} testID="mode-multiplayer" style={({ pressed }) => [{ opacity: pressed ? 0.94 : 1 }]}>
          <View style={styles.mpWrap}>
            <Image
              source={MP_BG}
              style={{ width: '100%', aspectRatio: MP_AR }}
              contentFit="contain"
            />
            <FloatingImage source={TROPHY} width={148} height={140} amplitude={7} rotate={3} duration={2600} style={styles.trophy} />
          </View>
        </Pressable>

        {/* Redemption Center — ready-made pill */}
        <Pressable onPress={() => router.push('/redeem')} testID="games-redeem" style={({ pressed }) => [styles.redeemWrap, { opacity: pressed ? 0.9 : 1 }]}>
          <Image
            source={REDEEM_BG}
            style={{ width: '100%', aspectRatio: REDEEM_AR }}
            contentFit="contain"
          />
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

  // Solo card
  soloWrap: { marginTop: 40, marginBottom: 26 },
  knife: { position: 'absolute', top: -18, right: -4, zIndex: 6 },

  // Multiplayer card
  mpWrap: { marginTop: 26, marginBottom: 22 },
  trophy: { position: 'absolute', top: -28, right: 12, zIndex: 6 },

  // Redemption
  redeemWrap: { marginTop: 2 },
});
