import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert,
  Platform, Switch, KeyboardAvoidingView, ActivityIndicator, Image, Modal,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useAdmin, type AppSettings } from '@/context/AdminContext';
import { useAuth } from '@/context/AuthContext';
import { api, type AdminTask, type AdminTaskSubmission } from '@/lib/api';
import Colors from '@/constants/colors';

// Build a PocketBase file URL for a given collection record and filename
function pbFileUrl(recordId: string, filename: string): string {
  return `https://api.webcod.in/api/files/task_submissions/${recordId}/${filename}`;
}

export default function AdminScreen() {
  const insets = useSafeAreaInsets();
  const { settings, updateSettings } = useAdmin();
  const { isAdmin, user } = useAuth();

  const [local, setLocal] = useState<AppSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [stats, setStats] = useState<{ totalUsers: number; totalSessions: number; pendingWithdrawals: number } | null>(null);

  // ── Task management state ──
  const [tasks, setTasks]                   = useState<AdminTask[]>([]);
  const [submissions, setSubmissions]       = useState<AdminTaskSubmission[]>([]);
  const [tasksLoading, setTasksLoading]     = useState(false);
  const [subLoading, setSubLoading]         = useState(false);
  const [proofModal, setProofModal]         = useState<string | null>(null);
  const [newTask, setNewTask]               = useState({
    title: '', description: '', link: '',
    reward_amount: '', reward_type: 'PT' as 'SHIB' | 'PT', is_active: true,
  });
  const [creatingTask, setCreatingTask]     = useState(false);

  const fetchTasks = useCallback(() => {
    setTasksLoading(true);
    api.adminGetTasks().then(setTasks).catch(() => {}).finally(() => setTasksLoading(false));
  }, []);

  const fetchSubmissions = useCallback(() => {
    setSubLoading(true);
    api.adminGetSubmissions('pending').then(setSubmissions).catch(() => {}).finally(() => setSubLoading(false));
  }, []);

  useEffect(() => {
    if (settings) setLocal(settings);
  }, [settings?.id]);

  useEffect(() => {
    if (isAdmin) {
      api.adminGetStats().then(setStats).catch(() => {});
      fetchTasks();
      fetchSubmissions();
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
    <>
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

          {/* ── Create Task ─────────────────────────────────────────────── */}
          <AdminSection title="Create Task" icon="clipboard-plus">
            <AdminField label="Title *" value={newTask.title} onChangeText={v => setNewTask(p => ({ ...p, title: v }))} placeholder="e.g. Follow us on X" />
            <AdminField label="Description" value={newTask.description} onChangeText={v => setNewTask(p => ({ ...p, description: v }))} placeholder="Steps to complete the task" />
            <AdminField label="Link (URL)" value={newTask.link} onChangeText={v => setNewTask(p => ({ ...p, link: v }))} placeholder="https://..." />
            <AdminField label="Reward Amount *" value={newTask.reward_amount} onChangeText={v => setNewTask(p => ({ ...p, reward_amount: v }))} keyboardType="numeric" placeholder="e.g. 500" />
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Reward Type</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['PT', 'SHIB'] as const).map(t => (
                  <Pressable
                    key={t}
                    style={[styles.typeBtn, newTask.reward_type === t && styles.typeBtnActive]}
                    onPress={() => setNewTask(p => ({ ...p, reward_type: t }))}
                  >
                    <Text style={[styles.typeBtnText, newTask.reward_type === t && styles.typeBtnTextActive]}>{t}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Active</Text>
              <Switch
                value={newTask.is_active}
                onValueChange={v => setNewTask(p => ({ ...p, is_active: v }))}
                trackColor={{ false: Colors.darkSurface, true: Colors.gold + '60' }}
                thumbColor={newTask.is_active ? Colors.gold : Colors.textMuted}
              />
            </View>
            <Pressable
              style={[styles.createBtn, creatingTask && { opacity: 0.6 }]}
              disabled={creatingTask}
              onPress={async () => {
                if (!newTask.title || !newTask.reward_amount) {
                  Alert.alert('Missing Fields', 'Title and Reward Amount are required.');
                  return;
                }
                setCreatingTask(true);
                try {
                  await api.adminCreateTask({
                    title: newTask.title,
                    description: newTask.description,
                    link: newTask.link,
                    reward_amount: Number(newTask.reward_amount),
                    reward_type: newTask.reward_type,
                    is_active: newTask.is_active,
                  });
                  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  setNewTask({ title: '', description: '', link: '', reward_amount: '', reward_type: 'PT', is_active: true });
                  fetchTasks();
                  Alert.alert('Created', 'Task created successfully.');
                } catch (e: any) {
                  Alert.alert('Error', e.message || 'Failed to create task.');
                } finally {
                  setCreatingTask(false);
                }
              }}
            >
              <LinearGradient colors={[Colors.gold, '#C8A000']} style={styles.createBtnGrad}>
                {creatingTask ? <ActivityIndicator size="small" color="#0A0A0F" /> : <Text style={styles.createBtnText}>Create Task</Text>}
              </LinearGradient>
            </Pressable>
          </AdminSection>

          {/* ── Task List ────────────────────────────────────────────────── */}
          <AdminSection title={`Task List (${tasks.length})`} icon="format-list-bulleted">
            {tasksLoading
              ? <ActivityIndicator color={Colors.gold} />
              : tasks.length === 0
                ? <Text style={styles.emptyText}>No tasks yet.</Text>
                : tasks.map(t => (
                  <View key={t.id} style={styles.taskRow}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.taskTitle}>{t.title}</Text>
                      <Text style={styles.taskMeta}>{t.reward_amount} {t.reward_type}</Text>
                    </View>
                    <Switch
                      value={!!t.is_active}
                      onValueChange={async (v) => {
                        await api.adminToggleTask(t.id, v).catch(() => {});
                        fetchTasks();
                      }}
                      trackColor={{ false: Colors.darkSurface, true: Colors.gold + '60' }}
                      thumbColor={t.is_active ? Colors.gold : Colors.textMuted}
                    />
                  </View>
                ))
            }
          </AdminSection>

          {/* ── Task Submissions ─────────────────────────────────────────── */}
          <AdminSection title={`Pending Submissions (${submissions.length})`} icon="check-decagram">
            {subLoading
              ? <ActivityIndicator color={Colors.gold} />
              : submissions.length === 0
                ? <Text style={styles.emptyText}>No pending submissions.</Text>
                : submissions.map(s => (
                  <View key={s.id} style={styles.subCard}>
                    <Text style={styles.subUser}>{s.user_email || s.user_id}</Text>
                    <Text style={styles.subTask}>{s.task_title}</Text>
                    <Text style={styles.subReward}>{s.reward_amount} {s.reward_type}</Text>
                    {!!s.proof_screenshot && (
                      <Pressable onPress={() => setProofModal(pbFileUrl(s.id, s.proof_screenshot))}>
                        <Image source={{ uri: pbFileUrl(s.id, s.proof_screenshot) }} style={styles.subProofThumb} resizeMode="cover" />
                        <Text style={styles.subProofHint}>Tap to enlarge</Text>
                      </Pressable>
                    )}
                    <View style={styles.subBtns}>
                      <Pressable
                        style={styles.rejectBtn}
                        onPress={() => Alert.prompt(
                          'Reject Submission',
                          'Enter a reason for rejection (optional):',
                          async (notes) => {
                            await api.adminRejectSubmission(s.id, notes || '').catch(() => {});
                            fetchSubmissions();
                          },
                          'plain-text',
                        )}
                      >
                        <Text style={styles.rejectBtnText}>Reject</Text>
                      </Pressable>
                      <Pressable
                        style={styles.approveBtn}
                        onPress={async () => {
                          try {
                            await api.adminApproveSubmission(s.id);
                            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                            fetchSubmissions();
                            Alert.alert('Approved', `${s.reward_amount} ${s.reward_type} added to user.`);
                          } catch (e: any) {
                            Alert.alert('Error', e.message || 'Approval failed.');
                          }
                        }}
                      >
                        <Text style={styles.approveBtnText}>Approve ✓</Text>
                      </Pressable>
                    </View>
                  </View>
                ))
            }
            {submissions.length > 0 && (
              <Pressable onPress={fetchSubmissions} style={styles.refreshBtn}>
                <Text style={styles.refreshBtnText}>Refresh</Text>
              </Pressable>
            )}
          </AdminSection>

          <View style={styles.adminNote}>
            <Ionicons name="person" size={14} color={Colors.textMuted} />
            <Text style={styles.adminNoteText}>Logged in as: {user?.email}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>

    {/* Proof image full-screen modal */}
    <Modal visible={!!proofModal} transparent animationType="fade" onRequestClose={() => setProofModal(null)}>
      <Pressable style={styles.proofOverlay} onPress={() => setProofModal(null)}>
        {!!proofModal && (
          <Image source={{ uri: proofModal }} style={styles.proofFull} resizeMode="contain" />
        )}
        <Text style={styles.proofClose}>Tap anywhere to close</Text>
      </Pressable>
    </Modal>
    </>
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
  // Task management
  typeBtn: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: Colors.darkBorder },
  typeBtnActive: { borderColor: Colors.gold, backgroundColor: Colors.gold + '20' },
  typeBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textMuted },
  typeBtnTextActive: { color: Colors.gold },
  createBtn: { marginTop: 4 },
  createBtnGrad: { borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  createBtnText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#0A0A0F' },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.darkBorder },
  taskTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.textPrimary },
  taskMeta: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },
  emptyText: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center', paddingVertical: 8 },
  subCard: { backgroundColor: Colors.darkSurface, borderRadius: 12, padding: 12, gap: 6, marginBottom: 10 },
  subUser: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold },
  subTask: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.textPrimary },
  subReward: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.neonOrange },
  subProofThumb: { width: '100%', height: 140, borderRadius: 8, marginTop: 4, backgroundColor: Colors.darkCard },
  subProofHint: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted, textAlign: 'center', marginTop: 2 },
  subBtns: { flexDirection: 'row', gap: 8, marginTop: 4 },
  rejectBtn: { flex: 1, borderWidth: 1, borderColor: Colors.error, borderRadius: 10, paddingVertical: 9, alignItems: 'center' },
  rejectBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.error },
  approveBtn: { flex: 1, backgroundColor: Colors.gold, borderRadius: 10, paddingVertical: 9, alignItems: 'center' },
  approveBtnText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#0A0A0F' },
  refreshBtn: { marginTop: 6, alignItems: 'center', paddingVertical: 6 },
  refreshBtnText: { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.textSecondary },
  // Proof modal
  proofOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  proofFull: { width: '100%', height: '80%', borderRadius: 12 },
  proofClose: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, marginTop: 16 },
});
