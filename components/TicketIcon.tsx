import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '@/constants/colors';

interface TicketIconProps {
  size?: number;
  color?: string;
}

/**
 * Compact, premium Hit Ticket glyph.
 * Layers a neon-orange glow behind a gold ticket face for a rich, minted look.
 * `color` overrides the face color; the glow stays neon for depth.
 */
export default function TicketIcon({ size = 24, color = Colors.gold }: TicketIconProps) {
  return (
    <View style={[styles.wrap, { width: size, height: size }]} testID="ticket-icon">
      <Ionicons
        name="ticket"
        size={size}
        color={Colors.neonOrange}
        style={[styles.glow, { opacity: 0.55 }]}
      />
      <Ionicons name="ticket" size={size * 0.86} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  glow: { position: 'absolute' },
});
