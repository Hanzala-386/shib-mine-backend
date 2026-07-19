/**
 * SupportWidget — floating draggable support button + modal
 * Snaps to left/right edge on release.
 * Shows a red badge when the admin has replied and the user hasn't read it yet.
 */
import React, {
  useState, useEffect, useRef, useCallback, memo,
} from 'react';
import {
  View, Text, Modal, Pressable, TextInput, StyleSheet,
  PanResponder, Animated, Dimensions, KeyboardAvoidingView,
  Platform, ActivityIndicator, ScrollView,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { pb } from '@/lib/pocketbase';
import { cleanFreeText, cleanDisplayName } from '@/lib/sanitize';
import Colors from '@/constants/colors';
import { useAuth } from '@/context/AuthContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname } from 'expo-router';
import { useTournament } from '@/context/TournamentContext';

// ── Types ──────────────────────────────────────────────────────────────────
export interface SupportTicket {
  id: string;
  user_name: string;
  user_email: string;
  user_pb_id: string;
  question: string;
  reply: string;
  status: 'Pending' | 'Replied';
  is_read_by_user: boolean;
  created: string;
}

// ── PocketBase helpers (direct SDK — works on APK) ─────────────────────────
async function fetchMyTicket(pbId: string): Promise<SupportTicket | null> {
  try {
    const res = await pb.collection('support_tickets').getList(1, 1, {
      filter: `user_pb_id = "${pbId}"`,
      sort: '-created',
    });
    const item = res.items[0];
    if (!item) return null;
    return {
      id: item.id,
      user_name: item.user_name ?? '',
      user_email: item.user_email ?? '',
      user_pb_id: item.user_pb_id ?? '',
      question: item.question ?? '',
      reply: item.reply ?? '',
      status: (item.status ?? 'Pending') as 'Pending' | 'Replied',
      is_read_by_user: !!item.is_read_by_user,
      created: item.created ?? '',
    };
  } catch {
    return null;
  }
}

async function createTicket(pbId: string, name: string, email: string, question: string): Promise<boolean> {
  try {
    await pb.collection('support_tickets').create({
      user_pb_id: pbId,
      user_name: name,
      user_email: email,
      question,
      status: 'Pending',
      is_read_by_user: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function markTicketRead(ticketId: string): Promise<void> {
  try {
    await pb.collection('support_tickets').update(ticketId, { is_read_by_user: true });
  } catch { /* ignore */ }
}

async function deleteTicket(ticketId: string): Promise<boolean> {
  try {
    await pb.collection('support_tickets').delete(ticketId);
    return true;
  } catch {
    return false;
  }
}

// ── Floating widget ─────────────────────────────────────────────────────────
const WIDGET_SIZE = 52;
const EDGE_MARGIN = 14;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

function SupportWidgetInner() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const [modalVisible, setModalVisible] = useState(false);
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [question, setQuestion] = useState('');
  const [hasUnread, setHasUnread] = useState(false);
  const [pollKey, setPollKey] = useState(0);

  // Position — starts right edge, 40% down
  const startY = SCREEN_H * 0.42;
  const pos = useRef(new Animated.ValueXY({
    x: SCREEN_W - WIDGET_SIZE - EDGE_MARGIN,
    y: startY,
  })).current;
  const lastPos = useRef({ x: SCREEN_W - WIDGET_SIZE - EDGE_MARGIN, y: startY });

  // ── Fetch ticket on mount and periodically ──
  useEffect(() => {
    if (!user?.pbId) return;
    let alive = true;
    (async () => {
      const t = await fetchMyTicket(user.pbId);
      if (!alive) return;
      setTicket(t);
      setHasUnread(!!(t && t.status === 'Replied' && !t.is_read_by_user));
    })();
    return () => { alive = false; };
  }, [user?.pbId, pollKey]);

  // Poll every 30s when modal is closed to catch admin replies
  useEffect(() => {
    if (modalVisible || !user?.pbId) return;
    const id = setInterval(() => setPollKey(k => k + 1), 30_000);
    return () => clearInterval(id);
  }, [modalVisible, user?.pbId]);

  // ── PanResponder ──
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3,
      onPanResponderGrant: () => {
        pos.setOffset({ x: lastPos.current.x, y: lastPos.current.y });
        pos.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: Animated.event(
        [null, { dx: pos.x, dy: pos.y }],
        { useNativeDriver: false },
      ),
      onPanResponderRelease: (_, g) => {
        pos.flattenOffset();
        const rawX: number = lastPos.current.x + g.dx;
        const rawY: number = lastPos.current.y + g.dy;

        // Clamp Y
        const minY = EDGE_MARGIN + insets.top;
        const maxY = SCREEN_H - WIDGET_SIZE - EDGE_MARGIN - insets.bottom - 100;
        const clampedY = Math.max(minY, Math.min(maxY, rawY));

        // Snap to nearest edge
        const midX = SCREEN_W / 2;
        const snapX = rawX + WIDGET_SIZE / 2 < midX
          ? EDGE_MARGIN
          : SCREEN_W - WIDGET_SIZE - EDGE_MARGIN;

        lastPos.current = { x: snapX, y: clampedY };

        Animated.spring(pos, {
          toValue: { x: snapX, y: clampedY },
          useNativeDriver: false,
          tension: 80,
          friction: 10,
        }).start();
      },
    })
  ).current;

  // ── Open modal ──
  const openModal = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setModalVisible(true);
    if (!user?.pbId) return;
    setLoading(true);
    const t = await fetchMyTicket(user.pbId);
    setTicket(t);
    setHasUnread(!!(t && t.status === 'Replied' && !t.is_read_by_user));
    setLoading(false);
  }, [user?.pbId]);

  // ── Submit ticket ──
  const handleSubmit = useCallback(async () => {
    if (!question.trim() || !user) return;
    setSubmitting(true);
    const cleaned = cleanFreeText(question, 1000);
    if (!cleaned) { setSubmitting(false); return; }
    const ok = await createTicket(
      user.pbId,
      cleanDisplayName(user.displayName || user.email),
      user.email,
      cleaned,
    );
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setQuestion('');
      const t = await fetchMyTicket(user.pbId);
      setTicket(t);
    }
    setSubmitting(false);
  }, [question, user]);

  // ── Clear / start new ──
  const handleClear = useCallback(async () => {
    if (!ticket) return;
    setSubmitting(true);
    await deleteTicket(ticket.id);
    setTicket(null);
    setHasUnread(false);
    setSubmitting(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [ticket]);

  const pathname = usePathname();
  const { tournamentTabActive } = useTournament();
  // Focus mode: hide the floating widget on the Tournament tab and inside a live match.
  const hideForFocusMode = tournamentTabActive || pathname.startsWith('/hub/arcade-match');

  if (!user?.pbId || hideForFocusMode) return null;

  return (
    <>
      {/* ── Floating button ── */}
      <Animated.View
        style={[styles.floatWrap, { transform: pos.getTranslateTransform() }]}
        {...panResponder.panHandlers}
      >
        <Pressable onPress={openModal} style={styles.floatBtn}>
          <LinearGradient
            colors={['rgba(244,196,48,0.22)', 'rgba(255,107,0,0.18)']}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          />
          <Ionicons name="headset" size={22} color={Colors.gold} />
        </Pressable>
        {/* Badge lives OUTSIDE the overflow:hidden Pressable so it is never clipped */}
        {hasUnread && (
          <View style={[styles.badge, { pointerEvents: 'none' }]}>
            <Text style={styles.badgeText}>i</Text>
          </View>
        )}
      </Animated.View>

      {/* ── Modal ── */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <Pressable style={styles.backdrop} onPress={() => setModalVisible(false)} />
          <View style={styles.sheet}>
            {/* Header */}
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleRow}>
                <MaterialCommunityIcons name="headset" size={18} color={Colors.gold} />
                <Text style={styles.sheetTitle}>Live Support</Text>
              </View>
              <Pressable onPress={() => setModalVisible(false)} style={styles.closeBtn}>
                <Ionicons name="close" size={20} color={Colors.textMuted} />
              </Pressable>
            </View>

            {loading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator color={Colors.gold} />
              </View>
            ) : ticket?.status === 'Replied' ? (
              /* ── Replied state ── */
              <ScrollView contentContainerStyle={styles.sheetBody} showsVerticalScrollIndicator={false}>
                <View style={styles.repliedBadge}>
                  <Ionicons name="checkmark-circle" size={14} color="#4CAF50" />
                  <Text style={styles.repliedBadgeText}>Support team replied</Text>
                </View>
                <Text style={styles.qLabel}>Your question</Text>
                <Text style={styles.qText}>{ticket.question}</Text>
                <View style={styles.replyBox}>
                  <Text style={styles.replyLabel}>SUPPORT TEAM REPLY</Text>
                  <Text style={styles.replyText}>{ticket.reply}</Text>
                </View>
                <Pressable
                  style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                  onPress={handleClear}
                  disabled={submitting}
                >
                  <LinearGradient
                    colors={[Colors.gold, Colors.neonOrange]}
                    style={styles.submitGrad}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  >
                    {submitting
                      ? <ActivityIndicator size="small" color="#000" />
                      : <Text style={styles.submitText}>Clear & Start New Ticket</Text>}
                  </LinearGradient>
                </Pressable>
              </ScrollView>
            ) : ticket?.status === 'Pending' ? (
              /* ── Pending state ── */
              <View style={styles.sheetBody}>
                <View style={styles.pendingBox}>
                  <MaterialCommunityIcons name="clock-outline" size={36} color={Colors.gold} style={{ marginBottom: 10 }} />
                  <Text style={styles.pendingTitle}>Your question is under review</Text>
                  <Text style={styles.pendingText}>We will reply within 12 hours. You'll see a badge on the support button when we do.</Text>
                </View>
                <View style={styles.myQuestionBox}>
                  <Text style={styles.qLabel}>Your question</Text>
                  <Text style={styles.qText}>{ticket.question}</Text>
                </View>
              </View>
            ) : (
              /* ── No ticket ── */
              <View style={styles.sheetBody}>
                <Text style={styles.inputLabel}>How can we help you?</Text>
                <TextInput
                  style={styles.questionInput}
                  value={question}
                  onChangeText={setQuestion}
                  placeholder="Describe your issue or question…"
                  placeholderTextColor={Colors.textMuted}
                  multiline
                  numberOfLines={5}
                  textAlignVertical="top"
                  maxLength={1000}
                />
                <Text style={styles.charCount}>{question.length}/1000</Text>
                <Pressable
                  style={[styles.submitBtn, (!question.trim() || submitting) && { opacity: 0.5 }]}
                  onPress={handleSubmit}
                  disabled={!question.trim() || submitting}
                >
                  <LinearGradient
                    colors={[Colors.gold, Colors.neonOrange]}
                    style={styles.submitGrad}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  >
                    {submitting
                      ? <ActivityIndicator size="small" color="#000" />
                      : <Text style={styles.submitText}>Submit Support Ticket</Text>}
                  </LinearGradient>
                </Pressable>
                <Text style={styles.replyNote}>We typically reply within 12 hours.</Text>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

export const SupportWidget = memo(SupportWidgetInner);

const styles = StyleSheet.create({
  // Floating button
  floatWrap: {
    position: 'absolute',
    zIndex: 9999,
    elevation: 9999,
    width: WIDGET_SIZE,
    height: WIDGET_SIZE,
  },
  floatBtn: {
    width: WIDGET_SIZE,
    height: WIDGET_SIZE,
    borderRadius: WIDGET_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(18,18,26,0.92)',
    borderWidth: 1.5,
    borderColor: 'rgba(244,196,48,0.38)',
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 12,
    overflow: 'hidden',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#FF3B30',
    borderWidth: 1.5,
    borderColor: Colors.darkBg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#fff',
    lineHeight: 11,
  },
  // Modal / bottom sheet
  backdrop: {
    flex: 1,
  },
  sheet: {
    backgroundColor: Colors.darkCard,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: 'rgba(244,196,48,0.18)',
    maxHeight: '80%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.darkBorder,
  },
  sheetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetTitle: { fontFamily: 'Inter_700Bold', fontSize: 17, color: Colors.textPrimary },
  closeBtn: { padding: 4 },
  loadingBox: { padding: 40, alignItems: 'center' },
  sheetBody: { padding: 20, gap: 14 },
  // Pending state
  pendingBox: {
    backgroundColor: Colors.darkSurface,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
  },
  pendingTitle: { fontFamily: 'Inter_700Bold', fontSize: 16, color: Colors.gold, textAlign: 'center', marginBottom: 6 },
  pendingText: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  myQuestionBox: { backgroundColor: Colors.darkSurface, borderRadius: 12, padding: 14, gap: 4 },
  // Replied state
  repliedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(76,175,80,0.12)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' },
  repliedBadgeText: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: '#4CAF50' },
  qLabel: { fontFamily: 'Inter_500Medium', fontSize: 11, color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8 },
  qText: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textPrimary, lineHeight: 20 },
  replyBox: {
    backgroundColor: 'rgba(244,196,48,0.06)',
    borderRadius: 14, padding: 14, gap: 6,
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.18)',
  },
  replyLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.gold, textTransform: 'uppercase', letterSpacing: 0.8 },
  replyText: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textPrimary, lineHeight: 21 },
  // No ticket state
  inputLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textPrimary },
  questionInput: {
    backgroundColor: Colors.darkSurface, borderRadius: 12, padding: 14,
    fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textPrimary,
    borderWidth: 1, borderColor: Colors.darkBorder, minHeight: 120,
  },
  charCount: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, textAlign: 'right', marginTop: -8 },
  submitBtn: { marginTop: 4 },
  submitGrad: { borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  submitText: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#000' },
  replyNote: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, textAlign: 'center', marginTop: -4 },
});
