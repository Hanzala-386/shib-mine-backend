import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * Shared dark space / cyberpunk starry backdrop used across the Game Arena
 * dashboard and the Multiplayer Hub so both screens read as one environment.
 * Purely decorative — absolute-filled and non-interactive.
 */

function binaryStr(n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += (Math.random() < 0.5 ? '0' : '1') + '\n';
  return s;
}

export default function NebulaBg() {
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

const styles = StyleSheet.create({
  blob: { position: 'absolute', borderRadius: 999 },
  binary: {
    position: 'absolute',
    color: 'rgba(120,200,255,0.06)',
    fontSize: 12,
    lineHeight: 16,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
});
