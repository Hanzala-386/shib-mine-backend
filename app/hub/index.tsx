/* Multiplayer Tournament Hub — 6-game arcade PvP grid on the shared cyberpunk backdrop. */

import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Platform } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';
import NebulaBg from '@/components/NebulaBg';

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

export default function HubScreen() {
  const insets = useSafeAreaInsets();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;

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

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 + webBottom }} showsVerticalScrollIndicator={false}>
        <View style={styles.grid}>
          {GAMES.map((g) => (
            <Pressable
              key={g.id}
              onPress={() => openGame(g)}
              testID={`hub-game-${g.id}`}
              style={({ pressed }) => [styles.cell, { opacity: pressed ? 0.9 : 1 }]}
            >
              <Image source={FRAME} style={StyleSheet.absoluteFill} contentFit="contain" />
              <View style={styles.cellContent}>
                <Image source={g.image} style={styles.iconImg} contentFit="cover" />
                <Text style={styles.cellName} numberOfLines={1}>{g.name}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
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

  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 14 },
  // Each cell = the ready-made frame image; content overlays the hollow area.
  cell: { width: '47.5%', aspectRatio: FRAME_AR, justifyContent: 'center' },
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
