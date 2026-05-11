import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';
import { pb } from '@/lib/pocketbase';
import { getApiUrl } from '@/lib/query-client';
import { notifyPersonalNotification } from '@/lib/notifications';

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
  // Tracks which personal notification IDs have already triggered a push
  const pushedIdsKey = pbId ? `notifs_pushed_ids_${pbId}` : null;
  const pushedIdsRef = useRef<Set<string>>(new Set());
  const isFirstFetchRef = useRef(true);

  useEffect(() => {
    if (!storageKey) return;
    AsyncStorage.getItem(storageKey).then(val => {
      if (val) setLastSeenAt(Number(val));
    }).catch(() => {});
  }, [storageKey]);

  // Load previously pushed IDs from storage so we never re-push after an app restart
  useEffect(() => {
    if (!pushedIdsKey) return;
    AsyncStorage.getItem(pushedIdsKey).then(val => {
      if (val) {
        try {
          const arr: string[] = JSON.parse(val);
          pushedIdsRef.current = new Set(arr);
        } catch { /* ignore */ }
      }
    }).catch(() => {});
    // Reset first-fetch flag when user changes
    isFirstFetchRef.current = true;
  }, [pushedIdsKey]);

  const fetchNotifications = useCallback(async () => {
    if (!pbId) return;
    setIsLoading(true);
    let fetched: AppNotification[] = [];
    try {
      const url = new URL(`/api/app/notifications/${pbId}`, getApiUrl());
      const res = await globalThis.fetch(url.toString());
      if (res.ok) {
        const data = await res.json();
        fetched = data.items || [];
      } else {
        throw new Error('non-ok');
      }
    } catch {
      try {
        const r = await pb.collection('notifications').getList(1, 50, {
          filter: `type = "global" || (type = "personal" && target_user = "${pbId}")`,
          sort: '-created',
        });
        fetched = (r.items || []).map((n: any) => ({
          id: n.id,
          title: n.title,
          message: n.message,
          type: (n.type || 'global') as 'global' | 'personal',
          created: n.created,
        }));
      } catch { /* ignore */ }
    }

    setNotifications(fetched);

    // Fire a push for each personal notification that hasn't been pushed yet.
    // Skip the very first fetch on startup so we don't re-notify for old entries.
    if (!isFirstFetchRef.current && pushedIdsKey) {
      const newPersonal = fetched.filter(
        n => n.type === 'personal' && !pushedIdsRef.current.has(n.id)
      );
      for (const n of newPersonal) {
        notifyPersonalNotification(n.title, n.message).catch(() => {});
        pushedIdsRef.current.add(n.id);
      }
      if (newPersonal.length > 0) {
        AsyncStorage.setItem(pushedIdsKey, JSON.stringify([...pushedIdsRef.current])).catch(() => {});
      }
    }
    isFirstFetchRef.current = false;

    setIsLoading(false);
  }, [pbId, pushedIdsKey]);

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
