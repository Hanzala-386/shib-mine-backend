import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable,
  Alert, Platform, Linking, ActivityIndicator, RefreshControl,
  Image, Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { api, TaskItem } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

// ── Helpers ──────────────────────────────────────────────────────────────────
function RewardBadge({ amount, type }: { amount: number; type: string }) {
  const isSHIB = type === 'SHIB';
  return (
    <View style={[badge.wrap, { borderColor: isSHIB ? Colors.gold : Colors.neonOrange }]}>
      <MaterialCommunityIcons
        name={isSHIB ? 'cash' : 'lightning-bolt'}
        size={13}
        color={isSHIB ? Colors.gold : Colors.neonOrange}
      />
      <Text style={[badge.text, { color: isSHIB ? Colors.gold : Colors.neonOrange }]}>
        {isSHIB ? `${amount.toLocaleString()} SHIB` : `${amount.toLocaleString()} PT`}
      </Text>
    </View>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string; icon: string }> = {
    pending:  { label: 'Under Review', color: Colors.textMuted,     icon: 'time-outline' },
    approved: { label: 'Approved ✓',   color: Colors.success,       icon: 'checkmark-circle' },
    rejected: { label: 'Rejected',     color: Colors.error,         icon: 'close-circle' },
  };
  const cfg = map[status] || map.pending;
  return (
    <View style={[pill.wrap, { borderColor: cfg.color + '50' }]}>
      <Ionicons name={cfg.icon as any} size={13} color={cfg.color} />
      <Text style={[pill.text, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

// ── Task Card ─────────────────────────────────────────────────────────────────
function TaskCard({ item, pbId, onProofSelected }: {
  item: TaskItem;
  pbId: string;
  onProofSelected: (task: TaskItem, base64: string) => void;
}) {
  const pickProof = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission Required', 'Please allow photo access to upload proof.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaType.Images,
      allowsEditing: true,
      quality: 0.5,
      base64: true,
    });
    if (!result.canceled && result.assets[0].base64) {
      const ext = result.assets[0].uri.split('.').pop() || 'jpg';
      const b64 = `data:image/${ext === 'png' ? 'png' : 'jpeg'};base64,${result.assets[0].base64}`;
      onProofSelected(item, b64);
    }
  }, [item, onProofSelected]);

  const openLink = useCallback(() => {
    if (item.link) Linking.openURL(item.link).catch(() => {});
  }, [item.link]);

  return (
    <Animated.View entering={FadeInDown.springify()} style={card.wrap}>
      <View style={card.top}>
        <Text style={card.title}>{item.title}</Text>
        <RewardBadge amount={item.reward_amount} type={item.reward_type} />
      </View>

      {!!item.description && (
        <Text style={card.desc}>{item.description}</Text>
      )}

      <View style={card.actions}>
        {!!item.link && (
          <Pressable style={card.goBtn} onPress={openLink} android_ripple={{ color: Colors.darkBorder }}>
            <Ionicons name="open-outline" size={15} color={Colors.neonOrange} />
            <Text style={card.goBtnText}>Go</Text>
          </Pressable>
        )}

        {!item.submission ? (
          <Pressable style={card.submitBtn} onPress={pickProof} android_ripple={{ color: Colors.darkBorder }}>
            <Ionicons name="camera-outline" size={15} color="#0A0A0F" />
            <Text style={card.submitBtnText}>Upload Proof</Text>
          </Pressable>
        ) : (
          <StatusPill status={item.submission.status} />
        )}
      </View>

      {item.submission?.status === 'rejected' && !!item.submission.admin_notes && (
        <Text style={card.rejection}>Reason: {item.submission.admin_notes}</Text>
      )}
    </Animated.View>
  );
}

// ── Proof Preview Modal ───────────────────────────────────────────────────────
function ProofPreviewModal({ visible, uri, onConfirm, onCancel, isSubmitting }: {
  visible: boolean;
  uri: string;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={preview.overlay}>
        <View style={preview.sheet}>
          <Text style={preview.title}>Review Your Proof</Text>
          <Text style={preview.sub}>Make sure the screenshot clearly shows you completed the task.</Text>
          {!!uri && (
            <Image source={{ uri }} style={preview.img} resizeMode="contain" />
          )}
          <View style={preview.btns}>
            <Pressable style={preview.cancelBtn} onPress={onCancel} disabled={isSubmitting}>
              <Text style={preview.cancelText}>Re-select</Text>
            </Pressable>
            <Pressable style={preview.confirmBtn} onPress={onConfirm} disabled={isSubmitting}>
              {isSubmitting
                ? <ActivityIndicator size="small" color="#0A0A0F" />
                : <Text style={preview.confirmText}>Submit</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function TasksScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const qc = useQueryClient();

  const [pendingTask, setPendingTask] = useState<TaskItem | null>(null);
  const [pendingBase64, setPendingBase64] = useState('');

  const topPad = Platform.OS === 'web' ? 67 : insets.top + 8;

  const { data: tasks = [], isLoading, refetch } = useQuery<TaskItem[]>({
    queryKey: ['/api/app/tasks', user?.pbId],
    queryFn: () => api.getTasks(user?.pbId || ''),
    enabled: !!user?.pbId,
    staleTime: 30_000,
  });

  const submitMut = useMutation({
    mutationFn: ({ taskId, proofBase64 }: { taskId: string; proofBase64: string }) =>
      api.submitTaskProof({ pbId: user!.pbId, taskId, proofBase64 }),
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['/api/app/tasks', user?.pbId] });
      setPendingTask(null);
      setPendingBase64('');
      Alert.alert('Submitted!', 'Your proof is under review. You\'ll receive your reward once approved.');
    },
    onError: (e: any) => {
      Alert.alert('Error', e.message || 'Submission failed. Please try again.');
    },
  });

  const handleProofSelected = useCallback((task: TaskItem, base64: string) => {
    setPendingTask(task);
    setPendingBase64(base64);
  }, []);

  const handleConfirmSubmit = () => {
    if (!pendingTask) return;
    submitMut.mutate({ taskId: pendingTask.id, proofBase64: pendingBase64 });
  };

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      {/* Header */}
      <View style={styles.header}>
        <Ionicons name="checkmark-done-circle" size={24} color={Colors.gold} />
        <Text style={styles.headerTitle}>Tasks</Text>
        <Text style={styles.headerSub}>Complete tasks to earn rewards</Text>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.gold} />
        </View>
      ) : tasks.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="clipboard-outline" size={56} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>No Tasks Yet</Text>
          <Text style={styles.emptySub}>Check back soon — new tasks are added regularly.</Text>
        </View>
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(i) => i.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 120 }]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isLoading}
              onRefresh={refetch}
              tintColor={Colors.gold}
              colors={[Colors.gold]}
            />
          }
          renderItem={({ item }) => (
            <TaskCard
              item={item}
              pbId={user?.pbId || ''}
              onProofSelected={handleProofSelected}
            />
          )}
        />
      )}

      <ProofPreviewModal
        visible={!!pendingTask}
        uri={pendingBase64}
        onConfirm={handleConfirmSubmit}
        onCancel={() => { setPendingTask(null); setPendingBase64(''); }}
        isSubmitting={submitMut.isPending}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.darkBg },
  header: { paddingHorizontal: 20, paddingBottom: 12, gap: 2 },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 26, color: Colors.textPrimary, marginTop: 4 },
  headerSub: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32 },
  emptyTitle: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textSecondary, textAlign: 'center' },
  emptySub: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center' },
  list: { paddingHorizontal: 16, paddingTop: 8, gap: 12 },
});

const card = StyleSheet.create({
  wrap: {
    backgroundColor: Colors.darkCard,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    padding: 16,
    gap: 10,
  },
  top: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  title: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 15, color: Colors.textPrimary },
  desc: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, lineHeight: 19 },
  actions: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 4 },
  goBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1, borderColor: Colors.neonOrange,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8,
  },
  goBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.neonOrange },
  submitBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    backgroundColor: Colors.gold, borderRadius: 10, paddingVertical: 8,
  },
  submitBtnText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#0A0A0F' },
  rejection: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.error, fontStyle: 'italic' },
});

const badge = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  text: { fontFamily: 'Inter_700Bold', fontSize: 12 },
});

const pill = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  text: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
});

const preview = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: Colors.darkCard, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 14, paddingBottom: 48 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary, textAlign: 'center' },
  sub: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, textAlign: 'center' },
  img: { width: '100%', height: 220, borderRadius: 12, backgroundColor: Colors.darkSurface },
  btns: { flexDirection: 'row', gap: 12 },
  cancelBtn: { flex: 1, borderWidth: 1, borderColor: Colors.darkBorder, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  cancelText: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textSecondary },
  confirmBtn: { flex: 1, backgroundColor: Colors.gold, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  confirmText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#0A0A0F' },
});
