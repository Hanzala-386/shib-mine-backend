import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, Pressable, Linking, Platform, BackHandler,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { pb } from '@/lib/pocketbase';
import Colors from '@/constants/colors';
import { INSTALLED_APP_VERSION, isVersionLower } from '@/constants/version';

const DEFAULT_MESSAGE =
  'A critical new update is available. Please update to continue playing!';

export function ForceUpdateModal() {
  const [visible, setVisible] = useState(false);
  const [playStoreUrl, setPlayStoreUrl] = useState('');
  const [message, setMessage] = useState(DEFAULT_MESSAGE);

  // Fetch the force-update gate from PocketBase `app_config` at boot.
  useEffect(() => {
    // The Play Store force-update only applies to the native app — never block the
    // web preview (it has no Play Store update path).
    if (Platform.OS === 'web') return;
    (async () => {
      try {
        // Deterministically read the original seeded config row (oldest first),
        // so an accidental extra row can never silently change the gate.
        const res = await pb.collection('app_config').getList(1, 1, {
          sort: 'created',
          fields: 'min_required_version,play_store_url,update_message',
        });
        const c = res.items[0];
        if (!c) return;
        const minVer: string = c.min_required_version || '';
        if (isVersionLower(INSTALLED_APP_VERSION, minVer)) {
          setPlayStoreUrl(c.play_store_url || '');
          if (c.update_message) setMessage(c.update_message);
          setVisible(true);
        }
      } catch {
        // Fail-open: never block the app because the config fetch failed.
      }
    })();
  }, []);

  // Anti-bypass: trap the Android hardware back button while the gate is shown.
  useEffect(() => {
    if (!visible || Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [visible]);

  const handleUpdate = () => {
    if (playStoreUrl) {
      Linking.openURL(playStoreUrl).catch(() => {});
    }
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {}}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <LinearGradient
            colors={['rgba(244,196,48,0.18)', 'rgba(255,107,0,0.12)', 'rgba(10,10,15,0.96)']}
            style={StyleSheet.absoluteFill}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
          />
          <View style={styles.iconWrap}>
            <LinearGradient
              colors={[Colors.gold, Colors.neonOrange]}
              style={StyleSheet.absoluteFill}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            />
            <Ionicons name="arrow-up-circle" size={38} color="#000" />
          </View>
          <Text style={styles.title}>Update Required</Text>
          <Text style={styles.subtitle}>{message}</Text>
          <Pressable
            style={({ pressed }) => [styles.updateBtn, { opacity: pressed ? 0.85 : 1 }]}
            onPress={handleUpdate}
          >
            <LinearGradient
              colors={[Colors.gold, Colors.neonOrange]}
              style={styles.updateBtnGrad}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
            >
              <Ionicons name="download-outline" size={18} color="#000" />
              <Text style={styles.updateBtnText}>UPDATE NOW</Text>
            </LinearGradient>
          </Pressable>
          <Text style={styles.hint}>
            This update includes important improvements and security fixes.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(244,196,48,0.35)',
    padding: 32,
    alignItems: 'center',
    gap: 0,
  },
  iconWrap: {
    width: 76,
    height: 76,
    borderRadius: 38,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 26,
    color: Colors.gold,
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
    paddingHorizontal: 4,
  },
  updateBtn: { width: '100%', marginBottom: 16 },
  updateBtnGrad: {
    height: 54,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  updateBtnText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 17,
    color: '#000',
  },
  hint: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 17,
  },
});
