import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';
import { pb } from '@/lib/pocketbase';
import { getApiUrl } from '@/lib/query-client';

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  type: 'global' | 'personal';
  created: string;
}

interface NotificationsContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  markAllRead: () => Promise<void>;
  refetch: () => Promise<void>;
  isLoading: boolean;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used inside NotificationsProvider');
  return ctx;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { pbUser } = useAuth();
  const pbId = pbUser?.pbId ?? null;

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [lastSeenAt, setLastSeenAt] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);

  const storageKey = pbId ? `notifs_last_seen_${pbId}` : null;

  useEffect(() => {
    if (!storageKey) return;
    AsyncStorage.getItem(storageKey).then(val => {
      if (val) setLastSeenAt(Number(val));
    }).catch(() => {});
  }, [storageKey]);

  const fetchNotifications = useCallback(async () => {
    if (!pbId) return;
    setIsLoading(true);
    try {
      const url = new URL(`/api/app/notifications/${pbId}`, getApiUrl());
      const res = await fetch(url.toString());
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.items || []);
        setIsLoading(false);
        return;
      }
    } catch { /* fall through to PB SDK */ }

    try {
      const r = await pb.collection('notifications').getList(1, 50, {
        filter: `type = "global" || (type = "personal" && target_user = "${pbId}")`,
        sort: '-created',
      });
      setNotifications((r.items || []).map((n: any) => ({
        id: n.id,
        title: n.title,
        message: n.message,
        type: (n.type || 'global') as 'global' | 'personal',
        created: n.created,
      })));
    } catch { /* ignore */ }

    setIsLoading(false);
  }, [pbId]);

  useEffect(() => {
    if (!pbId) return;
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 60_000);
    return () => clearInterval(interval);
  }, [fetchNotifications, pbId]);

  const unreadCount = notifications.filter(n =>
    new Date(n.created).getTime() > lastSeenAt
  ).length;

  const markAllRead = useCallback(async () => {
    const now = Date.now();
    setLastSeenAt(now);
    if (storageKey) {
      await AsyncStorage.setItem(storageKey, String(now)).catch(() => {});
    }
  }, [storageKey]);

  return (
    <NotificationsContext.Provider value={{ notifications, unreadCount, markAllRead, refetch: fetchNotifications, isLoading }}>
      {children}
    </NotificationsContext.Provider>
  );
}
