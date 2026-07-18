import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable, Platform,
  Animated as RNAnimated, Modal, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useNotifications, type AppNotification } from '@/context/NotificationsContext';
import Colors from '@/constants/colors';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function NotifItem({ item, isUnread, onPress }: { item: AppNotification; isUnread: boolean; onPress: (n: AppNotification) => void }) {
  const isGlobal = item.type === 'global';
  const iconColor = isGlobal ? Colors.gold : Colors.neonOrange;
  const iconBg    = isGlobal ? 'rgba(244,196,48,0.12)' : 'rgba(255,107,0,0.12)';

  return (
    <Animated.View entering={FadeInDown.springify()}>
      <Pressable
        onPress={() => onPress(item)}
        style={({ pressed }) => [styles.item, isUnread && styles.itemUnread, pressed && { opacity: 0.8 }]}
        testID={`notif-${item.id}`}
      >
        {isUnread && <View style={styles.unreadDot} />}
        <View style={[styles.iconWrap, { backgroundColor: iconBg }]}>
          <Ionicons name={isGlobal ? 'megaphone' : 'person-circle'} size={20} color={iconColor} />
        </View>
        <View style={styles.itemBody}>
          <View style={styles.topRow}>
            <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.itemTime}>{timeAgo(item.created)}</Text>
          </View>
          <Text style={styles.itemMsg} numberOfLines={4}>{item.message}</Text>
          <View style={styles.readMoreRow}>
            <View style={[styles.badge, { backgroundColor: isGlobal ? 'rgba(244,196,48,0.1)' : 'rgba(255,107,0,0.1)' }]}>
              <Text style={[styles.badgeText, { color: iconColor }]}>
                {isGlobal ? 'Broadcast' : 'Personal'}
              </Text>
            </View>
            <View style={styles.readMoreHint}>
              <Text style={styles.readMoreText}>Tap to read</Text>
              <Ionicons name="chevron-forward" size={12} color={Colors.textMuted} />
            </View>
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

/** Full-screen reader: the complete notification text, scrollable end-to-end. */
function NotifDetailModal({ notif, onClose }: { notif: AppNotification | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const isGlobal = notif?.type === 'global';
  const iconColor = isGlobal ? Colors.gold : Colors.neonOrange;

  return (
    <Modal visible={!!notif} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.detailContainer, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 10) }]}>
        <LinearGradient
          colors={['rgba(244,196,48,0.08)', 'transparent']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 0.4 }}
        />
        <View style={styles.detailHeader}>
          <Pressable onPress={onClose} style={styles.backBtn} testID="notif-detail-close">
            <Ionicons name="close" size={22} color={Colors.textPrimary} />
          </Pressable>
          <Text style={styles.headerTitle}>Notification</Text>
          <View style={{ width: 40 }} />
        </View>
        {notif && (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={[styles.detailBody, { paddingBottom: insets.bottom + 48 }]}
            showsVerticalScrollIndicator
          >
            <View style={[styles.iconWrap, { backgroundColor: isGlobal ? 'rgba(244,196,48,0.12)' : 'rgba(255,107,0,0.12)', width: 56, height: 56, borderRadius: 16 }]}>
              <Ionicons name={isGlobal ? 'megaphone' : 'person-circle'} size={26} color={iconColor} />
            </View>
            <Text style={styles.detailTitle}>{notif.title}</Text>
            <View style={styles.detailMetaRow}>
              <View style={[styles.badge, { backgroundColor: isGlobal ? 'rgba(244,196,48,0.1)' : 'rgba(255,107,0,0.1)' }]}>
                <Text style={[styles.badgeText, { color: iconColor }]}>{isGlobal ? 'Broadcast' : 'Personal'}</Text>
              </View>
              <Text style={styles.itemTime}>{notif.created ? timeAgo(notif.created) : ''}</Text>
            </View>
            <Text style={styles.detailMessage} selectable>{notif.message}</Text>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const { notifications, markAllRead, unreadCount, isLoading } = useNotifications();
  const [selected, setSelected] = useState<AppNotification | null>(null);

  const snapshotUnread = useRef(new Set<string>());

  useEffect(() => {
    // Capture which IDs are unread BEFORE marking all read
    snapshotUnread.current = new Set(
      notifications
        .filter(n => new Date(n.created).getTime() > Date.now() - 60_000 * 60 * 24 * 7) // rough proxy
        .map(n => n.id)
    );
    if (unreadCount > 0) markAllRead();
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.4 }}
      />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 10) }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Notifications</Text>
          {notifications.length > 0 && (
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{notifications.length}</Text>
            </View>
          )}
        </View>
        <View style={{ width: 40 }} />
      </View>

      <FlatList
        data={notifications}
        keyExtractor={item => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="notifications-off-outline" size={44} color={Colors.textMuted} />
            </View>
            <Text style={styles.emptyTitle}>
              {isLoading ? 'Loading…' : 'No notifications yet'}
            </Text>
            <Text style={styles.emptyDesc}>
              Important updates and alerts will appear here
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <NotifItem item={item} isUnread={false} onPress={setSelected} />
        )}
      />

      <NotifDetailModal notif={selected} onClose={() => setSelected(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.darkBorder,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: Colors.darkCard,
    alignItems: 'center', justifyContent: 'center',
  },
  headerCenter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },
  countBadge: {
    backgroundColor: 'rgba(244,196,48,0.15)',
    borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2,
  },
  countBadgeText: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.gold },

  list: { paddingHorizontal: 16, paddingTop: 14, gap: 10 },

  item: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: Colors.darkCard,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    position: 'relative',
    overflow: 'hidden',
  },
  itemUnread: {
    borderColor: 'rgba(244,196,48,0.3)',
    backgroundColor: 'rgba(244,196,48,0.04)',
  },
  unreadDot: {
    position: 'absolute', top: 14, right: 14,
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#FF3B30',
  },
  iconWrap: {
    width: 44, height: 44, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  itemBody: { flex: 1, gap: 5 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  itemTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textPrimary, flex: 1 },
  itemTime: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted, flexShrink: 0 },
  itemMsg: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, lineHeight: 19 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  badgeText: { fontFamily: 'Inter_600SemiBold', fontSize: 10 },

  readMoreRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  readMoreHint: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  readMoreText: { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },

  detailContainer: { flex: 1, backgroundColor: Colors.darkBg },
  detailHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.darkBorder,
  },
  detailBody: { paddingHorizontal: 24, paddingTop: 24, gap: 14 },
  detailTitle: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary, lineHeight: 30 },
  detailMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  detailMessage: { fontFamily: 'Inter_400Regular', fontSize: 15, color: Colors.textSecondary, lineHeight: 24 },

  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyIconWrap: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Colors.darkCard,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 17, color: Colors.textSecondary },
  emptyDesc: {
    fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted,
    textAlign: 'center', paddingHorizontal: 40, lineHeight: 19,
  },
});
