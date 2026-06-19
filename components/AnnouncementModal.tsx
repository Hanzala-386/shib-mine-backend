import React, { useEffect, useState } from 'react';
import {
  Modal, View, StyleSheet, Pressable, Image, Linking, Platform,
  BackHandler, ActivityIndicator, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { pb, POCKETBASE_URL } from '@/lib/pocketbase';
import storage from '@/lib/storage';
import Colors from '@/constants/colors';

const LAST_SEEN_BANNER_ID = 'LAST_SEEN_BANNER_ID';
const CURRENT_SHOW_COUNT = 'CURRENT_SHOW_COUNT';
const FETCH_TIMEOUT_MS = 6000;
const DEFAULT_FREQUENCY_LIMIT = 3;

export interface AnnouncementData {
  id: string;
  posterUrl: string;
  redirectUrl: string;
  currentCount: number;
}

/**
 * Boot-time announcement audit.
 *
 * Runs the PocketBase query + AsyncStorage frequency evaluation during the splash
 * phase and reports a single resolved decision. The caller MUST hold the main
 * navigator until `resolved` is true so the banner can never pop over a live
 * screen because of a slow API response.
 *
 * Returns `announcement` (the record to display) only when the device is still
 * under its frequency cap for the active creative; otherwise it stays null.
 */
export function useAnnouncementGate() {
  const [resolved, setResolved] = useState(false);
  const [announcement, setAnnouncement] = useState<AnnouncementData | null>(null);

  useEffect(() => {
    let settled = false;
    const finish = (data: AnnouncementData | null) => {
      if (settled) return;
      settled = true;
      if (data) setAnnouncement(data);
      setResolved(true);
    };

    // Safety net: never hang the splash forever on a slow/dead network. If the
    // audit can't finish quickly, boot WITHOUT the banner — and ignore a late
    // response so it can't appear over an already-mounted screen.
    const timer = setTimeout(() => finish(null), FETCH_TIMEOUT_MS);

    (async () => {
      try {
        // A. Latest active creative, newest first.
        const res = await pb.collection('announcements').getList(1, 1, {
          filter: 'is_active = true',
          sort: '-created',
        });
        if (settled) return; // timed out already → don't mutate storage or show late
        const rec = res.items[0];
        if (!rec) return finish(null);

        const remoteId = String(rec.id);

        // DATA CORRUPTION FALLBACK — safe-cast the admin-entered limit.
        const limitRaw = Number(rec.frequency_limit);
        const limit =
          Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.floor(limitRaw)
            : DEFAULT_FREQUENCY_LIMIT;

        let count: number;
        const lastSeenId = await storage.getItem(LAST_SEEN_BANNER_ID);
        if (lastSeenId !== remoteId) {
          // CASE 1 — new creative invalidation: flush old metrics + reset to 0.
          await storage.setItem(LAST_SEEN_BANNER_ID, remoteId);
          await storage.setItem(CURRENT_SHOW_COUNT, '0');
          count = 0;
        } else {
          // CASE 2 — persistent creative: read stored impressions (safe-cast).
          const storedRaw = Number(await storage.getItem(CURRENT_SHOW_COUNT));
          count = Number.isFinite(storedRaw) && storedRaw > 0 ? Math.floor(storedRaw) : 0;
        }

        // Frequency cap reached → bypass rendering entirely.
        if (count >= limit) return finish(null);

        const posterFile = rec.poster_image ? String(rec.poster_image) : '';
        if (!posterFile) return finish(null); // no creative asset → nothing to show

        const posterUrl =
          `${POCKETBASE_URL}/api/files/${rec.collectionId}/${rec.id}/${encodeURIComponent(posterFile)}`;
        const redirectUrl = rec.redirect_url ? String(rec.redirect_url).trim() : '';

        finish({ id: remoteId, posterUrl, redirectUrl, currentCount: count });
      } catch {
        finish(null); // fail-open: never block boot on the announcement audit
      } finally {
        clearTimeout(timer);
      }
    })();

    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, []);

  return { resolved, announcement };
}

export function AnnouncementModal({
  announcement,
  onClose,
}: {
  announcement: AnnouncementData;
  onClose: () => void;
}) {
  const [aspectRatio, setAspectRatio] = useState(0.8); // width / height fallback
  const [imgLoaded, setImgLoaded] = useState(false);
  const { width: screenW, height: screenH } = Dimensions.get('window');

  // Run-time invalidation: count the impression the MOMENT the modal mounts.
  useEffect(() => {
    storage
      .setItem(CURRENT_SHOW_COUNT, String(announcement.currentCount + 1))
      .catch(() => {});
  }, []);

  // Resolve the real poster aspect ratio so it never renders distorted.
  useEffect(() => {
    let active = true;
    Image.getSize(
      announcement.posterUrl,
      (w, h) => { if (active && h > 0) setAspectRatio(w / h); },
      () => {},
    );
    return () => { active = false; };
  }, [announcement.posterUrl]);

  // Non-dismissible: trap the Android hardware back button — the X is the only exit.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const hasRedirect = announcement.redirectUrl.length > 0;
  const handlePress = () => {
    if (hasRedirect) Linking.openURL(announcement.redirectUrl).catch(() => {});
  };

  // Fit the poster within the viewport while preserving aspect ratio.
  const maxW = screenW * 0.9;
  const maxH = screenH * 0.78;
  let imgW = maxW;
  let imgH = maxW / aspectRatio;
  if (imgH > maxH) {
    imgH = maxH;
    imgW = maxH * aspectRatio;
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}} statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={[styles.imageWrap, { width: imgW, height: imgH }]}>
          <Pressable
            style={styles.pressable}
            onPress={handlePress}
            disabled={!hasRedirect}
            testID="announcement-poster"
          >
            <Image
              source={{ uri: announcement.posterUrl }}
              style={styles.image}
              resizeMode="contain"
              onLoad={() => setImgLoaded(true)}
            />
            {!imgLoaded && (
              <View style={styles.loader}>
                <ActivityIndicator size="large" color={Colors.gold} />
              </View>
            )}
          </Pressable>

          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={12} testID="announcement-close">
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  imageWrap: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: Colors.darkCard,
    borderWidth: 1.5,
    borderColor: 'rgba(244,196,48,0.4)',
  },
  pressable: { flex: 1 },
  image: { width: '100%', height: '100%' },
  loader: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
});
