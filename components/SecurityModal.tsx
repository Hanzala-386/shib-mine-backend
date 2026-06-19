import React, { useEffect } from 'react';
import {
  Modal, View, Text, StyleSheet,
  TouchableOpacity, BackHandler, Platform, Alert, StatusBar, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { useSecurity, SecurityBlockType } from '@/context/SecurityContext';

// ── Block configuration ───────────────────────────────────────────────────────
type BlockConfig = {
  icon:         keyof typeof Ionicons.glyphMap;
  title:        string;
  subtitle:     string;
  message:      string;
  canRetry:     boolean;
  /** Show an "Open Settings" button that deep-links to Accessibility settings. */
  openSettings?: boolean;
};

const BLOCK_CONFIG: Record<NonNullable<SecurityBlockType>, BlockConfig> = {
  root: {
    icon:     'skull',
    title:    'Security Violation',
    subtitle: 'Rooted / Jailbroken Device Detected',
    message:
      'Your device environment is unsafe. Rooting or jailbreaking breaks the ' +
      'security model that protects all players.\n\n' +
      'Please restore your device to an unmodified state and remove any ' +
      'cheat tools, Magisk modules, or system-level tweaks to continue.',
    canRetry: false,
  },
  emulator: {
    icon:     'hardware-chip',
    title:    'Security Violation',
    subtitle: 'Unauthorized Device Detected',
    message:
      'Shiba Hit cannot run on emulators or virtual device environments.\n\n' +
      'Please use a physical Android or iOS device to play.',
    canRetry: false,
  },
  autoclicker: {
    icon:     'flash',
    title:    'Suspicious Activity',
    subtitle: 'Automation Tool / Auto-Clicker Detected',
    message:
      'Our anti-cheat system detected statistically non-human input patterns ' +
      'consistent with an auto-clicker or macro script.\n\n' +
      'Please disable any automation tools, accessibility scripts, or macro ' +
      'apps and play the game manually to continue.',
    canRetry: false,
  },
  accessibility: {
    icon:     'hand-left',
    title:    'Security Alert',
    subtitle: 'Auto-Clicker / Unauthorized Tapping Service Detected',
    message:
      'Security Alert: An active Auto-Clicker or unauthorized tapping service ' +
      'has been detected on your device. To continue playing, please completely ' +
      'turn off or Force Stop the auto-clicker application, otherwise our ' +
      'application will not open.',
    canRetry:     false,
    openSettings: true,
  },
  integrity: {
    icon:     'shield',
    title:    'Device Integrity Failure',
    subtitle: 'Uncertified or Modified OS Environment',
    message:
      'Google Play Integrity has determined that your device does not meet ' +
      'the required integrity standards.\n\n' +
      'This typically indicates a modified operating system, uncertified ' +
      'hardware, or a virtual device. Please use a certified device.',
    canRetry: false,
  },
  adblock: {
    icon:     'ban',
    title:    'Network Error',
    subtitle: 'Active Ad-Blocker / DNS Filter Detected',
    message:
      'Ads fund the Shiba mining network and keep rewards free. ' +
      'Please disable your ad-blocker or DNS filter to continue using the app.',
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

// ── Open Accessibility settings (Android) so the user can disable the service ──
function openAccessibilitySettings() {
  if (Platform.OS === 'android') {
    Linking.sendIntent('android.settings.ACCESSIBILITY_SETTINGS').catch(() => {
      Linking.openSettings().catch(() => {});
    });
  } else {
    Linking.openSettings().catch(() => {});
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export function SecurityModal() {
  const { blockType, isChecking, retryCheck } = useSecurity();
  const insets = useSafeAreaInsets();

  // Suppress the Android hardware back button while a security block is active,
  // so the user cannot dismiss / background the blocking modal.
  useEffect(() => {
    if (Platform.OS !== 'android' || !blockType) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [blockType]);

  if (!blockType) return null;

  const cfg          = BLOCK_CONFIG[blockType];
  const topPad       = Platform.OS === 'web' ? 67  : insets.top    + 16;
  const botPad       = Platform.OS === 'web' ? 34  : insets.bottom + 16;
  const hasSecondary = cfg.canRetry || !!cfg.openSettings;

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      hardwareAccelerated
      onRequestClose={() => { /* non-cancelable — back press is a no-op */ }}
    >
      <StatusBar backgroundColor="#0A0A0F" barStyle="light-content" />

      <View style={[styles.container, { paddingTop: topPad, paddingBottom: botPad }]}>

        {/* Brand */}
        <Text style={styles.brand}>SHIBA HIT</Text>

        {/* Alert card */}
        <View style={styles.card}>
          <View style={styles.iconRing}>
            <Ionicons name={cfg.icon} size={52} color={Colors.error} />
          </View>

          <Text style={styles.cardTitle}>⚠  {cfg.title}</Text>
          <View style={styles.divider} />
          <Text style={styles.cardSubtitle}>{cfg.subtitle}</Text>
          <Text style={styles.cardMessage}>{cfg.message}</Text>
        </View>

        {/* Action buttons */}
        <View style={[styles.btnRow, !hasSecondary && styles.btnRowSingle]}>
          <TouchableOpacity style={styles.exitBtn} onPress={exitApp} activeOpacity={0.82}>
            <Ionicons name="close-circle" size={18} color="#fff" />
            <Text style={styles.exitBtnText}>Exit App</Text>
          </TouchableOpacity>

          {cfg.openSettings && (
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={openAccessibilitySettings}
              activeOpacity={0.82}
            >
              <Ionicons name="settings" size={18} color="#0A0A0F" />
              <Text style={styles.retryBtnText}>Open Settings</Text>
            </TouchableOpacity>
          )}

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
          This security check protects our community and platform integrity.
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
  card: {
    width: '100%',
    backgroundColor: '#12121A',
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: Colors.error,
    paddingHorizontal: 24,
    paddingVertical: 28,
    alignItems: 'center',
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
  btnRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 26,
    width: '100%',
  },
  btnRowSingle: { justifyContent: 'center' },
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
  retryBtnDisabled: { opacity: 0.6 },
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
