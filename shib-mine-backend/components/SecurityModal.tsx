import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  BackHandler,
  Platform,
  Alert,
  StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { useSecurity, SecurityBlockType } from '@/context/SecurityContext';

// ── Block configuration ───────────────────────────────────────────────────────
type BlockConfig = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  message: string;
  canRetry: boolean;
};

const BLOCK_CONFIG: Record<NonNullable<SecurityBlockType>, BlockConfig> = {
  root: {
    icon: 'skull',
    title: 'Security Alert',
    subtitle: 'Rooted Device / Hacking Tool Detected',
    message:
      'Your device environment is unsafe. The app cannot open.\n\n' +
      'Please ensure your device is unrooted and remove any cheat tools ' +
      'to continue.',
    canRetry: false,
  },
  vpn: {
    icon: 'shield-half',
    title: 'VPN Detected',
    subtitle: 'Active VPN Connection Found',
    message:
      'For security and fair play, please disable any active VPN ' +
      'to access the Shiba Mining app.',
    canRetry: true,
  },
  adblock: {
    icon: 'ban',
    title: 'Network Error',
    subtitle: 'Active Ad-Blocker / DNS Filter Detected',
    message:
      'Ads support the Shiba mining network. Please disable your ' +
      'Ad-Blocker or DNS Filter to continue using the app.',
    canRetry: true,
  },
};

// ── Exit helper ───────────────────────────────────────────────────────────────
function exitApp() {
  if (Platform.OS === 'android') {
    BackHandler.exitApp();
  } else {
    Alert.alert(
      'Exit App',
      'Please close the app from the App Switcher to exit.',
      [{ text: 'OK', style: 'cancel' }],
    );
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export function SecurityModal() {
  const { blockType, isChecking, retryCheck } = useSecurity();
  const insets = useSafeAreaInsets();

  if (!blockType) return null;

  const cfg = BLOCK_CONFIG[blockType];

  const topPad  = Platform.OS === 'web' ? 67 : insets.top + 16;
  const botPad  = Platform.OS === 'web' ? 34 : insets.bottom + 16;

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      hardwareAccelerated
    >
      <StatusBar backgroundColor="#0A0A0F" barStyle="light-content" />

      <View style={[styles.container, { paddingTop: topPad, paddingBottom: botPad }]}>

        {/* Brand header */}
        <Text style={styles.brand}>SHIBA HIT</Text>

        {/* Alert card */}
        <View style={styles.card}>
          {/* Icon */}
          <View style={styles.iconRing}>
            <Ionicons name={cfg.icon} size={52} color={Colors.error} />
          </View>

          {/* Title */}
          <Text style={styles.cardTitle}>⚠  {cfg.title}</Text>

          {/* Divider */}
          <View style={styles.divider} />

          {/* Subtitle */}
          <Text style={styles.cardSubtitle}>{cfg.subtitle}</Text>

          {/* Message */}
          <Text style={styles.cardMessage}>{cfg.message}</Text>
        </View>

        {/* Buttons */}
        <View style={[styles.btnRow, !cfg.canRetry && styles.btnRowSingle]}>
          <TouchableOpacity
            style={styles.exitBtn}
            onPress={exitApp}
            activeOpacity={0.82}
          >
            <Ionicons name="close-circle" size={18} color="#fff" />
            <Text style={styles.exitBtnText}>Exit App</Text>
          </TouchableOpacity>

          {cfg.canRetry && (
            <TouchableOpacity
              style={[styles.retryBtn, isChecking && styles.retryBtnDisabled]}
              onPress={retryCheck}
              disabled={isChecking}
              activeOpacity={0.82}
            >
              <Ionicons name="refresh-circle" size={18} color="#0A0A0F" />
              <Text style={styles.retryBtnText}>
                {isChecking ? 'Checking…' : "I've Fixed It"}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <Text style={styles.footer}>
          This security check protects our users and platform integrity.
        </Text>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },

  brand: {
    fontSize: 12,
    fontWeight: '800' as const,
    letterSpacing: 7,
    color: Colors.gold,
    marginBottom: 28,
    opacity: 0.75,
  },

  // ── Card ──
  card: {
    width: '100%',
    backgroundColor: '#12121A',
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: Colors.error,
    paddingHorizontal: 24,
    paddingVertical: 28,
    alignItems: 'center',
    // Red glow
    shadowColor: Colors.error,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 14,
  },

  iconRing: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: 'rgba(255,61,87,0.10)',
    borderWidth: 2,
    borderColor: 'rgba(255,61,87,0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },

  cardTitle: {
    fontSize: 21,
    fontWeight: '800' as const,
    color: Colors.error,
    textAlign: 'center',
    letterSpacing: 0.4,
    marginBottom: 14,
  },

  divider: {
    width: '72%',
    height: 1,
    backgroundColor: 'rgba(255,61,87,0.28)',
    marginBottom: 14,
  },

  cardSubtitle: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: '#fff',
    textAlign: 'center',
    marginBottom: 12,
  },

  cardMessage: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },

  // ── Buttons ──
  btnRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 26,
    width: '100%',
  },
  btnRowSingle: {
    justifyContent: 'center',
  },

  exitBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: Colors.error,
    borderRadius: 14,
    paddingVertical: 14,
  },
  exitBtnText: {
    color: '#fff',
    fontWeight: '700' as const,
    fontSize: 15,
  },

  retryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: Colors.gold,
    borderRadius: 14,
    paddingVertical: 14,
  },
  retryBtnDisabled: {
    opacity: 0.6,
  },
  retryBtnText: {
    color: '#0A0A0F',
    fontWeight: '700' as const,
    fontSize: 15,
  },

  footer: {
    marginTop: 20,
    fontSize: 11,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
});
