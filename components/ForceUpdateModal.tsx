import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, Pressable, Linking, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { pb } from '@/lib/pocketbase';
import Colors from '@/constants/colors';

// ── Semantic version comparison ───────────────────────────────────────────────
// Returns true when `current` is strictly less than `minimum`.
function isVersionBehind(current: string, minimum: string): boolean {
  if (!minimum || minimum.trim() === '') return false;
  const parse = (v: string) =>
    v.trim().split('.').map((n) => parseInt(n, 10) || 0);
  const c = parse(current);
  const m = parse(minimum);
  const len = Math.max(c.length, m.length);
  for (let i = 0; i < len; i++) {
    const cv = c[i] ?? 0;
    const mv = m[i] ?? 0;
    if (cv < mv) return true;
    if (cv > mv) return false;
  }
  return false;
}

export function ForceUpdateModal() {
  const [visible, setVisible] = useState(false);
  const [playStoreUrl, setPlayStoreUrl] = useState('');

  useEffect(() => {
    if (__DEV__) return; // Skip in development
    (async () => {
      try {
        const res = await pb.collection('settings').getList(1, 1, {
          fields: 'minimum_version,play_store_url,app_store_link',
        });
        const s = res.items[0];
        if (!s) return;
        const minVer: string = s.minimum_version || '';
        const storeUrl: string = s.play_store_url || s.app_store_link || '';
        const currentVer: string = Constants.expoConfig?.version ?? '0.0.0';
        if (isVersionBehind(currentVer, minVer)) {
          setPlayStoreUrl(storeUrl);
          setVisible(true);
        }
      } catch {
        // Silently ignore — never block the app due to a settings fetch failure
      }
    })();
  }, []);

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
          <Text style={styles.subtitle}>
            A new version of Shiba Hit is available. Please update the app to continue mining.
          </Text>
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
              <Text style={styles.updateBtnText}>Update Now</Text>
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
