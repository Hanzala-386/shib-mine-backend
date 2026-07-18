/* Game Arena tab — cyberpunk entry hub: Solo Play (Knife Hit) vs Multiplayer Hub. */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Platform, ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';
import { useWallet } from '@/context/WalletContext';
import KycGateModal, { useKycGate } from '@/components/KycGate';
import LightningBorder from '@/components/LightningBorder';
import FloatingImage from '@/components/FloatingImage';
import NebulaBg from '@/components/NebulaBg';
import { BANNER_HEIGHT } from '@/components/StickyBannerAd';

const KNIFE = require('@/assets/images/knife_cyber.png');
const TROPHY = require('@/assets/images/trophy_gold.png');
const SOLO_BG = require('@/assets/images/solo_card_bg.png');
const MP_BG = require('@/assets/images/mp_card_bg.png');
const REDEEM_BG = require('@/assets/images/redeem_bg.png');
const SHIBA_TICKET = require('@/assets/images/shiba_ticket_diamond.png');

// Aspect ratios of the ready-made card artwork (width / height).
const SOLO_AR = 611 / 419;
const MP_AR = 648 / 385;
const REDEEM_AR = 654 / 162;

export default function GamesScreen() {
  const insets = useSafeAreaInsets();
  const { powerTokens, hitTickets } = useWallet();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;
  // The custom tab bar is absolutely positioned (banner ~50px + buttons 56px +
  // bottom inset), so the scroll content must clear it or the redeem pill is
  // unreachable behind the bar. Same pattern as profile.tsx.
  const tabBarClearance =
    Platform.OS === 'web' ? 0 : insets.bottom + BANNER_HEIGHT + 90;
  const [soloW, setSoloW] = useState(0);
  const soloH = soloW > 0 ? soloW / SOLO_AR : 0;

  // KYC gate — Multiplayer Hub requires a verified account (Solo Play stays open)
  const { isKycVerified } = useKycGate();
  const [showKycGate, setShowKycGate] = useState(false);

  return (
    <View style={styles.root}>
      <NebulaBg />
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + webTop + 12,
          paddingHorizontal: 16,
          paddingBottom: 32 + webBottom + tabBarClearance,
        }}
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
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
            <Image source={SHIBA_TICKET} style={{ width: 21, height: 15 }} contentFit="contain" />
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
                radius={34}
                pad={16}
                color={Colors.neonOrange}
                glowColor="#FF3D00"
                core="#FFE7C2"
              />
            )}
            <FloatingImage source={KNIFE} width={264} height={198} amplitude={11} rotate={4} duration={2300} style={styles.knife} />
          </View>
        </Pressable>

        {/* Multiplayer Hub — ready-made golden card + floating trophy */}
        <Pressable
          onPress={() => {
            if (!isKycVerified) {
              setShowKycGate(true);
            } else {
              router.push('/hub');
            }
          }}
          testID="mode-multiplayer"
          style={({ pressed }) => [{ opacity: pressed ? 0.94 : 1 }]}
        >
          <View style={styles.mpWrap}>
            <Image
              source={MP_BG}
              style={{ width: '100%', aspectRatio: MP_AR }}
              contentFit="contain"
            />
            <FloatingImage source={TROPHY} width={202} height={192} amplitude={9} rotate={3} duration={2600} style={styles.trophy} />
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

        {/* Game History — read-only match & redemption log */}
        <Pressable
          onPress={() => router.push('/game-history')}
          testID="games-history"
          style={({ pressed }) => [styles.historyBtn, { opacity: pressed ? 0.85 : 1 }]}
        >
          <Ionicons name="time-outline" size={18} color={Colors.gold} />
          <Text style={styles.historyTxt}>Game History</Text>
          <Ionicons name="chevron-forward" size={16} color={Colors.textSecondary} />
        </Pressable>
      </ScrollView>

      {/* KYC gate — blocks non-verified users from the Multiplayer Hub */}
      <KycGateModal
        visible={showKycGate}
        feature="multiplayer"
        onClose={() => setShowKycGate(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },

  historyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
    paddingVertical: 13,
    borderRadius: 14,
    backgroundColor: 'rgba(244,196,48,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.30)',
  },
  historyTxt: {
    color: Colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.4,
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

  // Solo card — extra top room so the enlarged knife + lightning can overflow.
  soloWrap: { marginTop: 48, marginBottom: 30 },
  knife: { position: 'absolute', top: -22, right: -12, zIndex: 6 },

  // Multiplayer card
  mpWrap: { marginTop: 34, marginBottom: 22 },
  trophy: { position: 'absolute', top: -40, right: 0, zIndex: 6 },

  // Redemption
  redeemWrap: { marginTop: 2 },
});
