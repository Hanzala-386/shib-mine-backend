/* Multiplayer Tournament Hub — game grid (Flappy Bounce + Fruit Cut arcade PvP). */

import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Platform, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';

const FLAPPY_ICON = require('@/assets/images/flappy_icon.png');
const FRUITCUT_ICON = require('@/assets/images/fruitcut_icon.jpg');
const STACK_ICON = require('@/assets/images/stack_icon.png');
const G2048_ICON = require('@/assets/images/2048_icon.png');
const ICEBLOCK_ICON = require('@/assets/images/iceblock_icon.png');
const COLOR_ICON = require('@/assets/images/color_icon.png');

type HubGame = {
  id: string;
  name: string;
  icon: keyof typeof Ionicons.glyphMap;
  image?: any;
  active: boolean;
};

const GAMES: HubGame[] = [
  { id: 'flappy', name: 'Flappy Bounce', icon: 'airplane', image: FLAPPY_ICON, active: true },
  { id: 'fruitcut', name: 'Fruit Cut', icon: 'nutrition', image: FRUITCUT_ICON, active: true },
  { id: 'stack', name: 'Tower Stack', icon: 'business', image: STACK_ICON, active: true },
  { id: '2048', name: '2048', icon: 'grid', image: G2048_ICON, active: true },
  { id: 'iceblock', name: 'Ice Block', icon: 'snow', image: ICEBLOCK_ICON, active: true },
  { id: 'color', name: 'Color Rush', icon: 'color-palette', image: COLOR_ICON, active: true },
];

export default function HubScreen() {
  const insets = useSafeAreaInsets();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;

  const openGame = (g: HubGame) => {
    if (!g.active) return;
    // Both live games run on the shared arcade PvP engine — one lobby, per-game id.
    router.push({ pathname: '/hub/arcade-lobby', params: { gameId: g.id } } as any);
  };

  return (
    <View style={styles.root}>
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
              disabled={!g.active}
              onPress={() => openGame(g)}
              testID={`hub-game-${g.id}`}
              style={({ pressed }) => [styles.cell, { opacity: pressed && g.active ? 0.9 : 1 }]}
            >
              <LinearGradient
                colors={g.active ? ['#1E1508', '#12121A'] : ['#14141E', '#101018']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[styles.cellBg, g.active && styles.cellActive]}
              >
                <View style={[styles.iconWrap, { backgroundColor: g.active ? 'rgba(244,196,48,0.14)' : 'rgba(255,255,255,0.04)' }]}>
                  {g.image ? (
                    <Image source={g.image} style={styles.iconImg} resizeMode="cover" />
                  ) : (
                    <Ionicons name={g.icon} size={30} color={g.active ? Colors.gold : Colors.textMuted} />
                  )}
                </View>
                <Text style={[styles.cellName, { color: g.active ? Colors.textPrimary : Colors.textMuted }]}>{g.name}</Text>
                {g.active ? (
                  <View style={styles.liveBadge}>
                    <View style={styles.liveDot} />
                    <Text style={styles.liveTxt}>LIVE</Text>
                  </View>
                ) : (
                  <View style={styles.soonBadge}>
                    <Text style={styles.soonTxt}>SOON</Text>
                  </View>
                )}
              </LinearGradient>
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 },
  cell: { width: '47.5%' },
  cellBg: { aspectRatio: 1, borderRadius: 18, borderWidth: 1, borderColor: Colors.darkBorder, alignItems: 'center', justifyContent: 'center', padding: 12 },
  cellActive: { borderColor: 'rgba(244,196,48,0.45)' },
  iconWrap: { width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 12, overflow: 'hidden' },
  iconImg: { width: 64, height: 64, borderRadius: 20 },
  cellName: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8, backgroundColor: 'rgba(0,230,118,0.12)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.success },
  liveTxt: { color: Colors.success, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  soonBadge: { marginTop: 8, backgroundColor: 'rgba(255,255,255,0.05)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  soonTxt: { color: Colors.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
});
