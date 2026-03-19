import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert,
  Platform, Switch, KeyboardAvoidingView, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useAdmin, type AppSettings } from '@/context/AdminContext';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import Colors from '@/constants/colors';

export default function AdminScreen() {
  const insets = useSafeAreaInsets();
  const { settings, updateSettings } = useAdmin();
  const { isAdmin, user } = useAuth();

  const [local, setLocal] = useState<AppSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [stats, setStats] = useState<{ totalUsers: number; totalSessions: number; pendingWithdrawals: number } | null>(null);

  useEffect(() => {
    if (settings) setLocal(settings);
  }, [settings?.id]);

  useEffect(() => {
    if (isAdmin) {
      api.adminGetStats().then(setStats).catch(() => {});
    }
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.darkBg, justifyContent: 'center', alignItems: 'center' }]}>
        <Ionicons name="lock-closed" size={48} color={Colors.error} />
        <Text style={styles.accessDenied}>Access Denied</Text>
        <Text style={styles.accessDeniedSub}>Admin access restricted.</Text>
      </View>
    );
  }

  if (!local) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.darkBg, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={Colors.gold} size="large" />
      </View>
    );
  }

  function setField<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setLocal(prev => prev ? { ...prev, [key]: value } : prev);
  }

  function setBoostCost(tier: '2x' | '4x' | '6x' | '10x', value: number) {
    setLocal(prev => prev ? { ...prev, boostCosts: { ...prev.boostCosts, [tier]: value } } : prev);
  }

  async function handleSave() {
    if (!local) return;
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSaving(true);
    try {
      await updateSettings(local);
      Alert.alert('Saved', 'Admin settings updated successfully.');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to save settings.');
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

          {stats && (
            <Animated.View entering={FadeInDown.springify()} style={styles.statsRow}>
              <View style={styles.statCard}>
                <Text style={styles.statNum}>{stats.totalUsers}</Text>
                <Text style={styles.statLbl}>Users</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statNum}>{stats.totalSessions}</Text>
                <Text style={styles.statLbl}>Sessions</Text>
              </View>
              <View style={[styles.statCard, { borderColor: Colors.gold }]}>
                <Text style={[styles.statNum, { color: Colors.gold }]}>{stats.pendingWithdrawals}</Text>
                <Text style={styles.statLbl}>Pending</Text>
              </View>
            </Animated.View>
          )}

          <AdminSection title="Mining Settings" icon="pickaxe">
            <AdminField
              label="Mining Rate Per Second (SHIB)"
              value={String(local.miningRatePerSec)}
              onChangeText={(v) => setField('miningRatePerSec', Number(v) || 0)}
              keyboardType="numeric"
            />
            <AdminField
              label="Duration (minutes)"
              value={String(local.miningDurationMinutes)}
              onChangeText={(v) => setField('miningDurationMinutes', Number(v) || 60)}
              keyboardType="numeric"
            />
            <AdminField
              label="Power Token Per Click (Knife Hit)"
              value={String(local.powerTokenPerClick)}
              onChangeText={(v) => setField('powerTokenPerClick', Number(v) || 0)}
              keyboardType="numeric"
            />
            <AdminField
              label="Tokens Per Round (Game)"
              value={String(local.tokensPerRound)}
              onChangeText={(v) => setField('tokensPerRound', Number(v) || 0)}
              keyboardType="numeric"
            />
          </AdminSection>

          <AdminSection title="Booster Costs (Power Tokens)" icon="lightning-bolt">
            {(['2x', '4x', '6x', '10x'] as const).map((key) => (
              <AdminField
                key={key}
                label={`${key} Booster Cost`}
                value={String(local.boostCosts[key])}
                onChangeText={(v) => setBoostCost(key, Number(v) || 0)}
                keyboardType="numeric"
              />
            ))}
          </AdminSection>

          <AdminSection title="Withdrawal Thresholds (SHIB)" icon="wallet">
            <AdminField label="Tier 1 Min (1st withdrawal)" value={String(local.minWithdrawal1)} onChangeText={(v) => setField('minWithdrawal1', Number(v) || 0)} keyboardType="numeric" />
            <AdminField label="Tier 2 Min (2nd withdrawal)" value={String(local.minWithdrawal2)} onChangeText={(v) => setField('minWithdrawal2', Number(v) || 0)} keyboardType="numeric" />
            <AdminField label="Tier 3 Min (3rd+ withdrawal)" value={String(local.minWithdrawal3)} onChangeText={(v) => setField('minWithdrawal3', Number(v) || 0)} keyboardType="numeric" />
          </AdminSection>

          <AdminSection title="Ad Settings" icon="megaphone">
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Show Ads</Text>
              <Switch
                value={local.showAds}
                onValueChange={(v) => setField('showAds', v)}
                trackColor={{ false: Colors.darkSurface, true: Colors.gold + '60' }}
                thumbColor={local.showAds ? Colors.gold : Colors.textMuted}
              />
            </View>
            <AdminField label="Active Ad Network" value={local.activeAdNetwork} onChangeText={(v) => setField('activeAdNetwork', v)} placeholder="admob | applovin | unity" />
            <AdminField label="AdMob Interstitial ID" value={local.admobUnitId} onChangeText={(v) => setField('admobUnitId', v)} placeholder="ca-app-pub-.../..." />
            <AdminField label="AdMob Banner ID" value={local.admobBannerUnitId} onChangeText={(v) => setField('admobBannerUnitId', v)} placeholder="ca-app-pub-.../..." />
            <AdminField label="AppLovin SDK Key" value={local.applovinSdkKey} onChangeText={(v) => setField('applovinSdkKey', v)} placeholder="AppLovin SDK Key" />
            <AdminField label="AppLovin Rewarded ID" value={local.applovinRewardedId} onChangeText={(v) => setField('applovinRewardedId', v)} placeholder="Rewarded Ad ID" />
            <AdminField label="Unity Game ID" value={local.unityGameId} onChangeText={(v) => setField('unityGameId', v)} placeholder="Unity Game ID" />
            <AdminField label="Unity Rewarded ID" value={local.unityRewardedId} onChangeText={(v) => setField('unityRewardedId', v)} placeholder="Unity Rewarded Placement ID" />
            <AdminField label="Play Store URL" value={local.playStoreUrl || ''} onChangeText={(v) => setField('playStoreUrl', v)} placeholder="https://play.google.com/store/apps/details?id=..." />
            <AdminField label="Rate Popup Frequency (claims)" value={String(local.ratePopupFrequency || 5)} onChangeText={(v) => setField('ratePopupFrequency', Number(v) || 5)} keyboardType="numeric" />
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
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 16, gap: 12 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary },
  saveBtn: {},
  saveBtnGradient: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10 },
  saveBtnText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#fff' },
  scroll: { paddingHorizontal: 20, paddingBottom: 60 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: Colors.darkCard, borderRadius: 14, padding: 14, alignItems: 'center', gap: 4, borderWidth: 1, borderColor: Colors.darkBorder },
  statNum: { fontFamily: 'Inter_700Bold', fontSize: 20, color: Colors.textPrimary },
  statLbl: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },
  section: { backgroundColor: Colors.darkCard, borderRadius: 18, borderWidth: 1, borderColor: Colors.darkBorder, marginBottom: 16, overflow: 'hidden' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.darkBorder, backgroundColor: 'rgba(255,107,0,0.06)' },
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.neonOrange, textTransform: 'uppercase', letterSpacing: 0.8 },
  sectionBody: { padding: 16, gap: 12 },
  fieldGroup: { gap: 6 },
  fieldLabel: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.textSecondary },
  fieldInput: { backgroundColor: Colors.darkSurface, borderRadius: 10, height: 44, paddingHorizontal: 14, fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.darkBorder },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  switchLabel: { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textPrimary },
  accessDenied: { fontFamily: 'Inter_700Bold', fontSize: 24, color: Colors.error, marginTop: 16 },
  accessDeniedSub: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textMuted, marginTop: 8 },
  adminNote: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  adminNoteText: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
});
