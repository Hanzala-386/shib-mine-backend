import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert,
  Platform, Switch, KeyboardAvoidingView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useAdmin, AdminSettings } from '@/context/AdminContext';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

export default function AdminScreen() {
  const insets = useSafeAreaInsets();
  const { settings, updateSettings } = useAdmin();
  const { isAdmin, user } = useAuth();

  const [local, setLocal] = useState(settings);
  const [saving, setSaving] = useState(false);

  if (!isAdmin) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.darkBg, justifyContent: 'center', alignItems: 'center' }]}>
        <Ionicons name="lock-closed" size={48} color={Colors.error} />
        <Text style={styles.accessDenied}>Access Denied</Text>
        <Text style={styles.accessDeniedSub}>Admin access restricted.</Text>
      </View>
    );
  }

  function updateLocal(path: string, value: any) {
    setLocal(prev => {
      const parts = path.split('.');
      const next = { ...prev } as any;
      let cur = next;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = { ...cur[parts[i]] };
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      return next;
    });
  }

  async function handleSave() {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSaving(true);
    try {
      await updateSettings(local);
      Alert.alert('Saved', 'Admin settings updated successfully.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(255,61,87,0.15)', 'rgba(244,196,48,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16) }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="close" size={22} color={Colors.textSecondary} />
        </Pressable>
        <Text style={styles.title}>Admin Panel</Text>
        <Pressable
          style={({ pressed }) => [styles.saveBtn, { opacity: pressed || saving ? 0.8 : 1 }]}
          onPress={handleSave}
          disabled={saving}
        >
          <LinearGradient colors={[Colors.error, '#CC1A2A']} style={styles.saveBtnGradient}>
            <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save All'}</Text>
          </LinearGradient>
        </Pressable>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <AdminSection title="Mining Settings" icon="pickaxe">
            <AdminField
              label="Entry Fee (Power Tokens)"
              value={String(local.miningEntryFee)}
              onChangeText={(v) => updateLocal('miningEntryFee', Number(v) || 0)}
              keyboardType="numeric"
            />
            <AdminField
              label="Base Mining Rate (SHIB per session)"
              value={String(local.baseMiningRate)}
              onChangeText={(v) => updateLocal('baseMiningRate', Number(v) || 0)}
              keyboardType="numeric"
            />
          </AdminSection>

          <AdminSection title="Booster Costs (PT)" icon="lightning-bolt">
            {(['2x', '4x', '6x', '10x'] as const).map((key) => (
              <AdminField
                key={key}
                label={`${key} Booster Cost`}
                value={String(local.boosterCosts[key])}
                onChangeText={(v) => updateLocal(`boosterCosts.${key}`, Number(v) || 0)}
                keyboardType="numeric"
              />
            ))}
          </AdminSection>

          <AdminSection title="AdMob Settings" icon="megaphone">
            <AdminField label="AdMob App ID" value={local.admob.appId} onChangeText={(v) => updateLocal('admob.appId', v)} placeholder="ca-app-pub-..." />
            <AdminField label="Banner Ad ID" value={local.admob.bannerId} onChangeText={(v) => updateLocal('admob.bannerId', v)} placeholder="ca-app-pub-.../..." />
            <AdminField label="Interstitial Ad ID" value={local.admob.interstitialId} onChangeText={(v) => updateLocal('admob.interstitialId', v)} placeholder="ca-app-pub-.../..." />
            <AdminField label="Rewarded Ad ID" value={local.admob.rewardedId} onChangeText={(v) => updateLocal('admob.rewardedId', v)} placeholder="ca-app-pub-.../..." />
          </AdminSection>

          <AdminSection title="Unity Ads Settings" icon="game-controller">
            <AdminField label="Unity Game ID" value={local.unity.gameId} onChangeText={(v) => updateLocal('unity.gameId', v)} placeholder="Enter Game ID" />
            <AdminField label="Interstitial Placement ID" value={local.unity.interstitialPlacementId} onChangeText={(v) => updateLocal('unity.interstitialPlacementId', v)} placeholder="Enter Placement ID" />
          </AdminSection>

          <AdminSection title="Withdrawal Settings" icon="wallet">
            <AdminField label="Binance Fee (%)" value={String(local.withdrawal.binanceFeePercent)} onChangeText={(v) => updateLocal('withdrawal.binanceFeePercent', Number(v) || 0)} keyboardType="numeric" />
            <AdminField label="BEP-20 Flat Fee (SHIB)" value={String(local.withdrawal.bep20FlatFee)} onChangeText={(v) => updateLocal('withdrawal.bep20FlatFee', Number(v) || 0)} keyboardType="numeric" />
            <AdminField label="Tier 1 Min Withdrawal (SHIB)" value={String(local.withdrawal.minTier1)} onChangeText={(v) => updateLocal('withdrawal.minTier1', Number(v) || 0)} keyboardType="numeric" />
            <AdminField label="Tier 2 Min Withdrawal (SHIB)" value={String(local.withdrawal.minTier2)} onChangeText={(v) => updateLocal('withdrawal.minTier2', Number(v) || 0)} keyboardType="numeric" />
            <AdminField label="Tier 3 Min Withdrawal (SHIB)" value={String(local.withdrawal.minTier3)} onChangeText={(v) => updateLocal('withdrawal.minTier3', Number(v) || 0)} keyboardType="numeric" />
          </AdminSection>

          <View style={styles.adminNote}>
            <Ionicons name="person" size={14} color={Colors.textMuted} />
            <Text style={styles.adminNoteText}>Logged in as: {user?.email}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function AdminSection({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <Animated.View entering={FadeInDown.springify()} style={styles.section}>
      <View style={styles.sectionHeader}>
        <MaterialCommunityIcons name={icon as any} size={16} color={Colors.neonOrange} />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </Animated.View>
  );
}

function AdminField({ label, value, onChangeText, keyboardType, placeholder }: { label: string; value: string; onChangeText: (v: string) => void; keyboardType?: any; placeholder?: string }) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType ?? 'default'}
        placeholder={placeholder ?? ''}
        placeholderTextColor={Colors.textMuted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20,
    paddingBottom: 16, gap: 12,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary },
  saveBtn: {},
  saveBtnGradient: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10 },
  saveBtnText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#fff' },
  scroll: { paddingHorizontal: 20, paddingBottom: 60 },
  section: {
    backgroundColor: Colors.darkCard, borderRadius: 18,
    borderWidth: 1, borderColor: Colors.darkBorder, marginBottom: 16, overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: Colors.darkBorder,
    backgroundColor: 'rgba(255,107,0,0.06)',
  },
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.neonOrange, textTransform: 'uppercase', letterSpacing: 0.8 },
  sectionBody: { padding: 16, gap: 12 },
  fieldGroup: { gap: 6 },
  fieldLabel: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.textSecondary },
  fieldInput: {
    backgroundColor: Colors.darkSurface, borderRadius: 10, height: 44,
    paddingHorizontal: 14, fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textPrimary,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  accessDenied: { fontFamily: 'Inter_700Bold', fontSize: 24, color: Colors.error, marginTop: 16 },
  accessDeniedSub: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textMuted, marginTop: 8 },
  adminNote: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8,
  },
  adminNoteText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
});
