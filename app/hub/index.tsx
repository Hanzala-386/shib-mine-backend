/* Multiplayer Tournament Hub — 6-game arcade PvP grid on the shared cyberpunk backdrop. */

import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Platform, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';
import NebulaBg from '@/components/NebulaBg';
import { InlineBannerAd, BANNER_HEIGHT, BANNERS_AVAILABLE } from '@/components/StickyBannerAd';

const FRAME = require('@/assets/images/game_frame.png');
const FRAME_AR = 1008 / 1053; // ready-made sci-fi frame (LIVE panel baked into the bottom)

const FLAPPY_ICON = require('@/assets/images/flappy_icon.png');
const FRUITCUT_ICON = require('@/assets/images/fruitcut_icon.jpg');
const STACK_ICON = require('@/assets/images/stack_icon.png');
const G2048_ICON = require('@/assets/images/2048_icon.png');
const ICEBLOCK_ICON = require('@/assets/images/iceblock_icon.png');
const COLOR_ICON = require('@/assets/images/color_icon.png');

type HubGame = { id: string; name: string; image: any };

const GAMES: HubGame[] = [
  { id: 'flappy', name: 'Flappy Bounce', image: FLAPPY_ICON },
  { id: 'fruitcut', name: 'Fruit Cut', image: FRUITCUT_ICON },
  { id: 'stack', name: 'Tower Stack', image: STACK_ICON },
  { id: '2048', name: '2048', image: G2048_ICON },
  { id: 'iceblock', name: 'Ice Block', image: ICEBLOCK_ICON },
  { id: 'color', name: 'Color Rush', image: COLOR_ICON },
];

const GRID_PAD = 16;   // ScrollView horizontal padding
const CELL_GAP = 14;   // spacing between the two columns / rows

export default function HubScreen() {
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;

  // Explicit pixel sizing — two columns that always fit, no percentage
  // rounding or flex-gap quirks. Cap the grid width on tablets/web so the
  // frames don't blow up.
  const gridW = Math.min(winW, 560) - GRID_PAD * 2;
  const cellW = Math.floor((gridW - CELL_GAP) / 2);
  const cellH = Math.round(cellW / FRAME_AR);

  const openGame = (g: HubGame) => {
    router.push({ pathname: '/hub/arcade-lobby', params: { gameId: g.id } } as any);
  };

  return (
    <View style={styles.root}>
      <NebulaBg />

      <View style={[styles.header, { paddingTop: insets.top + webTop + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back} testID="hub-back">
          <Ionicons name="chevron-back" size={24} color={Colors.gold} />
        </Pressable>
        <View style={styles.headTitle}>
          <Text style={styles.title}>Multiplayer Hub</Text>
          <Text style={styles.sub}>Power Match 1v1 Challenges</Text>
        </View>
        <View style={styles.back} />
      </View>

      {/* TOP banner — hub */}
      <InlineBannerAd />

      <ScrollView
        contentContainerStyle={{
          paddingVertical: GRID_PAD,
          paddingBottom: 24 + webBottom + insets.bottom + BANNER_HEIGHT,
          alignItems: 'center',
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.grid, { width: gridW }]}>
          {GAMES.map((g, i) => (
            <Pressable
              key={g.id}
              onPress={() => openGame(g)}
              testID={`hub-game-${g.id}`}
              style={({ pressed }) => [
                {
                  width: cellW,
                  height: cellH,
                  marginRight: i % 2 === 0 ? CELL_GAP : 0,
                  marginBottom: CELL_GAP,
                  opacity: pressed ? 0.9 : 1,
                },
              ]}
            >
              <Image source={FRAME} style={StyleSheet.absoluteFill} contentFit="contain" />
              <View style={styles.cellContent}>
                <Image source={g.image} style={styles.iconImg} contentFit="cover" />
                <Text
                  style={styles.cellName}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                  maxFontSizeMultiplier={1.1}
                >
                  {g.name}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {/* BOTTOM banner — hub (skipped entirely when banners can't render) */}
      {BANNERS_AVAILABLE && (
        <View style={[styles.bannerBar, { paddingBottom: webBottom + insets.bottom }]}>
          <InlineBannerAd />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 12 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headTitle: { flex: 1 },
  title: { color: Colors.textPrimary, fontSize: 20, fontWeight: '800' },
  sub: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  bannerBar: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', backgroundColor: Colors.darkBg, borderTopColor: Colors.darkBorder, borderTopWidth: 1 },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  // Content overlays the hollow area of the ready-made frame image.
  cellContent: {
    position: 'absolute',
    top: '9%',
    left: '13%',
    right: '13%',
    bottom: '8%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: '7%',
  },
  iconImg: { width: '52%', aspectRatio: 1, borderRadius: 16 },
  cellName: { color: Colors.textPrimary, fontSize: 14, fontWeight: '800', textAlign: 'center', marginTop: 8 },
});
