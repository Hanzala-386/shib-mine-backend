import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert,
  Platform, Switch, KeyboardAvoidingView, ActivityIndicator, Image, Modal,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useAdmin, type AppSettings } from '@/context/AdminContext';
import { useAuth } from '@/context/AuthContext';
import { api, type AdminTask, type AdminTaskSubmission, type SupportTicketRecord, type PBUser } from '@/lib/api';
import { pb } from '@/lib/pocketbase';
import { cleanFreeText } from '@/lib/sanitize';
import { MAX_VIP_LEVEL } from '@shared/vip';
import { KYC_REJECT_REASONS } from '@shared/kyc';
import type { VerificationRequestRecord } from '@/lib/api';
import Colors from '@/constants/colors';

// Mint a unique cycle identifier for a freshly-launched tournament. Mirrors
// generateCycleId() on the server (server/tournament.ts) — manual cycles are
// identified by this opaque id, NOT by any calendar bucket.
function mintCycleId(): string {
  return `cycle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

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

  // ── VIP override state ──
  const [vipQuery, setVipQuery]       = useState('');
  const [vipResults, setVipResults]   = useState<PBUser[]>([]);
  const [vipSearching, setVipSearching] = useState(false);
  const [vipSavingId, setVipSavingId] = useState<string | null>(null);

  const handleVipSearch = async () => {
    const q = vipQuery.trim();
    if (!q) return;
    setVipSearching(true);
    try {
      const users = await api.adminSearchUsers(q);
      setVipResults(users);
    } catch {
      setVipResults([]);
    } finally {
      setVipSearching(false);
    }
  };

  const handleSetVip = async (pbId: string, level: number) => {
    setVipSavingId(pbId);
    try {
      const updated = await api.adminSetUserVip(pbId, level);
      setVipResults((prev) => prev.map((u) => (u.pbId === pbId ? updated : u)));
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to set VIP level');
    } finally {
      setVipSavingId(null);
    }
  };

  // ── KYC verification requests state ──
  const [verifications, setVerifications]   = useState<VerificationRequestRecord[]>([]);
  const [verifLoading, setVerifLoading]     = useState(false);
  const [verifActingId, setVerifActingId]   = useState<string | null>(null);
  const [rejectTarget, setRejectTarget]     = useState<VerificationRequestRecord | null>(null);
  const [rejectReason, setRejectReason]     = useState<string>(KYC_REJECT_REASONS[0]);
  const [unverifyingId, setUnverifyingId]   = useState<string | null>(null);

  const fetchVerifications = useCallback(async () => {
    setVerifLoading(true);
    try {
      const res = await api.adminGetVerifications('under_review');
      setVerifications(res.items);
    } catch {
      setVerifications([]);
    } finally {
      setVerifLoading(false);
    }
  }, []);

  const handleApproveVerification = (req: VerificationRequestRecord) => {
    Alert.alert(
      'Approve Verification',
      `Approve ${req.fullName} (${req.userEmail || req.userId})? Their withdrawal destination will be locked to these details.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          onPress: async () => {
            setVerifActingId(req.id);
            try {
              await api.adminApproveVerification(req.id);
              setVerifications((prev) => prev.filter((r) => r.id !== req.id));
              if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Failed to approve');
            } finally {
              setVerifActingId(null);
            }
          },
        },
      ],
    );
  };

  const handleRejectVerification = async () => {
    if (!rejectTarget) return;
    const req = rejectTarget;
    setVerifActingId(req.id);
    setRejectTarget(null);
    try {
      await api.adminRejectVerification(req.id, rejectReason);
      setVerifications((prev) => prev.filter((r) => r.id !== req.id));
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to reject');
    } finally {
      setVerifActingId(null);
    }
  };

  const handleUnverify = (u: PBUser) => {
    Alert.alert(
      'Unverify User',
      `Remove verification from ${u.email || u.displayName}? They will be blocked from Wallet & Multiplayer until they verify again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unverify',
          style: 'destructive',
          onPress: async () => {
            setUnverifyingId(u.pbId);
            try {
              await api.adminUnverifyUser(u.pbId);
              setVipResults((prev) => prev.map((x) => (x.pbId === u.pbId ? { ...x, kycStatus: 'none' } : x)));
              if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Failed to unverify');
            } finally {
              setUnverifyingId(null);
            }
          },
        },
      ],
    );
  };

  // ── Solo Game Config state ──
  type SoloGameConfigRow = {
    id: string; game_id: string; game_name: string;
    pt_multiplier: string; max_pt: string; max_raw_score: string; max_pt_per_sec: string;
  };
  const [soloConfigs, setSoloConfigs]           = useState<SoloGameConfigRow[]>([]);
  const [soloConfigSaving, setSoloConfigSaving] = useState<string | null>(null);

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

  // ── Support ticket state ──
  const [supportTickets, setSupportTickets] = useState<SupportTicketRecord[]>([]);
  const [supportLoading, setSupportLoading] = useState(false);
  const [replyTexts, setReplyTexts]         = useState<Record<string, string>>({});
  const [replyingId, setReplyingId]         = useState<string | null>(null);
  const [supportTab, setSupportTab]         = useState<'Pending' | 'Replied'>('Pending');

  // ── Tournament state ──
  const [tournament, setTournament] = useState({
    id: '',
    prizePool: '500000',
    winnersCount: '3',
    existingBannerUrl: '', // URL of already-uploaded banner (for thumbnail preview)
    rank1: '250000',
    rank2: '150000',
    rank3: '100000',
    startInHours: '0',   // 0 = start now (live); >0 = scheduled pre-start window
    durationDays: '7',   // arbitrary cycle length — days component
    durationHours: '0',  // arbitrary cycle length — hours component
    isActive: false,     // whether a tournament is currently running (drives "End now")
  });
  const [localBannerUri, setLocalBannerUri]   = useState<string | null>(null);
  const [localBannerMime, setLocalBannerMime] = useState<string>('image/jpeg');
  const [savingTournament, setSavingTournament] = useState(false);

  // ── Daily Reward Settings state ──
  const [dailySettingsId, setDailySettingsId] = useState('');
  type DayImgState = { localUri: string | null; localMime: string; existingUrl: string };
  const [dayImages, setDayImages] = useState<Record<string, DayImgState>>({
    day_1: { localUri: null, localMime: 'image/jpeg', existingUrl: '' },
    day_2: { localUri: null, localMime: 'image/jpeg', existingUrl: '' },
    day_3: { localUri: null, localMime: 'image/jpeg', existingUrl: '' },
    day_4: { localUri: null, localMime: 'image/jpeg', existingUrl: '' },
    day_5: { localUri: null, localMime: 'image/jpeg', existingUrl: '' },
    day_6: { localUri: null, localMime: 'image/jpeg', existingUrl: '' },
    day_7_shiba: { localUri: null, localMime: 'image/jpeg', existingUrl: '' },
    day_7_power: { localUri: null, localMime: 'image/jpeg', existingUrl: '' },
  });
  const [dayAmounts, setDayAmounts] = useState<Record<string, string>>({
    day_1: '1000', day_2: '50', day_3: '3000', day_4: '100',
    day_5: '5000', day_6: '200', day_7_shiba: '10000', day_7_power: '500',
  });
  const [savingDailySettings, setSavingDailySettings] = useState(false);

  const fetchSupportTickets = useCallback(async () => {
    setSupportLoading(true);
    try {
      // Direct PocketBase SDK — works on APK and dev
      const res = await pb.collection('support_tickets').getFullList({
        sort: '-created',
      });
      setSupportTickets(res.map((r: any) => ({
        id: r.id,
        user_pb_id: r.user_pb_id ?? '',
        user_name: r.user_name ?? '',
        user_email: r.user_email ?? '',
        question: r.question ?? '',
        reply: r.reply ?? '',
        status: (r.status ?? 'Pending') as 'Pending' | 'Replied',
        is_read_by_user: !!r.is_read_by_user,
        created: r.created ?? '',
      })));
    } catch { /* ignore */ } finally {
      setSupportLoading(false);
    }
  }, []);

  const handleSendReply = useCallback(async (ticketId: string) => {
    const reply = cleanFreeText(replyTexts[ticketId] ?? '', 2000);
    if (!reply) return;
    setReplyingId(ticketId);
    try {
      await pb.collection('support_tickets').update(ticketId, {
        reply,
        status: 'Replied',
        is_read_by_user: false,
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setReplyTexts(prev => { const n = { ...prev }; delete n[ticketId]; return n; });
      await fetchSupportTickets();
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to send reply.');
    } finally {
      setReplyingId(null);
    }
  }, [replyTexts, fetchSupportTickets]);

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
      fetchSupportTickets();
      fetchVerifications();
      // Load tournament config
      pb.collection('tournament_config').getList(1, 1, { sort: '-created' })
        .then(res => {
          const raw = res.items[0];
          if (!raw) return;
          let rw: Record<string, number> = {};
          try { rw = JSON.parse(raw.reward_structure || '{}'); } catch {}
          // Build existing banner URL from file field or legacy text field
          let existingBannerUrl = '';
          if (raw.banner) {
            const fname = Array.isArray(raw.banner) ? raw.banner[0] : raw.banner;
            if (fname) existingBannerUrl = `https://api.webcod.in/api/files/tournament_config/${raw.id}/${fname}`;
          }
          if (!existingBannerUrl && raw.banner_url) existingBannerUrl = raw.banner_url;
          // Derive whether a tournament is currently running: is_active flag AND
          // the end_time hasn't passed yet (matches the client phase model).
          const endMs = raw.end_time ? new Date(raw.end_time).getTime() : 0;
          const running = !!raw.is_active && (!endMs || endMs > Date.now());
          setTournament({
            id: raw.id,
            prizePool: String(raw.prize_pool_total || 500000),
            winnersCount: String(raw.winners_count || 3),
            existingBannerUrl,
            rank1: String(rw['1'] || 250000),
            rank2: String(rw['2'] || 150000),
            rank3: String(rw['3'] || 100000),
            startInHours: '0',
            durationDays: '7',
            durationHours: '0',
            isActive: running,
          });
        }).catch(() => {});

      // Load daily claim settings (images + amounts per day)
      api.getDailySettings().then(cs => {
        setDailySettingsId(cs.id || '');
        const fu = (url: string | null) => url ?? '';
        setDayImages({
          day_1:       { localUri: null, localMime: 'image/jpeg', existingUrl: fu(cs.day1ImageUrl) },
          day_2:       { localUri: null, localMime: 'image/jpeg', existingUrl: fu(cs.day2ImageUrl) },
          day_3:       { localUri: null, localMime: 'image/jpeg', existingUrl: fu(cs.day3ImageUrl) },
          day_4:       { localUri: null, localMime: 'image/jpeg', existingUrl: fu(cs.day4ImageUrl) },
          day_5:       { localUri: null, localMime: 'image/jpeg', existingUrl: fu(cs.day5ImageUrl) },
          day_6:       { localUri: null, localMime: 'image/jpeg', existingUrl: fu(cs.day6ImageUrl) },
          day_7_shiba: { localUri: null, localMime: 'image/jpeg', existingUrl: fu(cs.day7ShibImageUrl) },
          day_7_power: { localUri: null, localMime: 'image/jpeg', existingUrl: fu(cs.day7PowerImageUrl) },
        });
        setDayAmounts({
          day_1: String(cs.day1Amount), day_2: String(cs.day2Amount),
          day_3: String(cs.day3Amount), day_4: String(cs.day4Amount),
          day_5: String(cs.day5Amount), day_6: String(cs.day6Amount),
          day_7_shiba: String(cs.day7ShibAmount), day_7_power: String(cs.day7PowerAmount),
        });
      }).catch(() => {});
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

  async function pickBannerImage() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow photo library access to upload a banner.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.92,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setLocalBannerUri(asset.uri);
      setLocalBannerMime(asset.mimeType || 'image/jpeg');
    }
  }

  async function handleSaveTournament() {
    setSavingTournament(true);
    try {
      // ── Lifecycle guard ──────────────────────────────────────────────────
      // Launching mints a fresh cycle_id + wipes ALL participant rows. If the
      // current cycle has not been fully finalized, overwriting it here would
      // bypass that cycle's payout + history (the server's runEndOfCycle would
      // never fire for the old cycle_id). Re-fetch the live config (authoritative —
      // not the possibly-stale in-memory flag) and refuse to launch while:
      //   • the cycle is still active (is_active=true — covers a running cycle AND
      //     the window after "End Tournament Now" before the server freezes it), OR
      //   • a cycle_id exists that the server has NOT yet marked paid
      //     (payout_finalized_cycle !== cycle_id — closes the freeze→payout gap).
      // The admin must End it first and wait for the server to finalize.
      // FAIL CLOSED: if we cannot read/validate the live config, we cannot prove the
      // previous cycle was finalized, so we must NOT launch (a launch overwrites the
      // config + wipes participants and could skip the old cycle's payout).
      try {
        const liveList = await pb.collection('tournament_config').getList(1, 1, { sort: '-created' });
        const live = liveList?.items?.[0] as any;
        const stillActive    = live?.is_active === true;
        const hasUnfinalized = !!live?.cycle_id && live.payout_finalized_cycle !== live.cycle_id;
        if (live && (stillActive || hasUnfinalized)) {
          setSavingTournament(false);
          Alert.alert(
            'Tournament still wrapping up',
            stillActive
              ? 'A tournament is currently live. Tap "End Tournament Now" first — winners are paid out and the leaderboard is cleared — before launching a new one.'
              : 'The previous tournament is still being finalized (paying out winners). Please wait a moment and try again.',
          );
          return;
        }
      } catch (guardErr: any) {
        console.warn('[admin] active-cycle guard check failed (failing closed):', guardErr?.message);
        setSavingTournament(false);
        Alert.alert(
          'Could not verify tournament status',
          'We could not confirm whether a tournament is still running. Launching is blocked to protect the previous cycle\'s payout. Please check your connection and try again.',
        );
        return;
      }

      const rewardStructure = JSON.stringify({
        '1': Number(tournament.rank1) || 0,
        '2': Number(tournament.rank2) || 0,
        '3': Number(tournament.rank3) || 0,
      });

      // Manual cycle: start in X hours (0 = now → live immediately; >0 → pre-start
      // phase), and an arbitrary duration of (days + hours). A fresh cycle_id is
      // minted on EVERY launch so the server's per-cycle payout guard treats this
      // as a brand-new tournament. Server scores mining from start_time onward.
      const hrs        = Math.max(0, Number(tournament.startInHours) || 0);
      const durDays    = Math.max(0, Number(tournament.durationDays) || 0);
      const durHours   = Math.max(0, Number(tournament.durationHours) || 0);
      const durationMs = (durDays * 24 + durHours) * 3_600_000;
      if (durationMs <= 0) {
        Alert.alert('Invalid duration', 'Tournament duration must be at least 1 hour.');
        setSavingTournament(false);
        return;
      }
      const startMs  = Date.now() + hrs * 3_600_000;
      const startIso = new Date(startMs).toISOString();
      const endIso   = new Date(startMs + durationMs).toISOString();
      const cycleId  = mintCycleId();

      // Use FormData so the banner image file is uploaded as multipart
      const form = new FormData();
      form.append('prize_pool_total', String(Number(tournament.prizePool) || 0));
      form.append('winners_count',    String(Number(tournament.winnersCount) || 3));
      form.append('reward_structure', rewardStructure);
      form.append('week_start',       startIso);
      form.append('start_time',       startIso);
      form.append('end_time',         endIso);
      form.append('is_active',        'true');
      form.append('cycle_id',         cycleId);

      if (localBannerUri) {
        // Append image file — React Native FormData file shape
        const ext = localBannerMime.includes('png') ? 'png' : localBannerMime.includes('gif') ? 'gif' : 'jpg';
        form.append('banner', {
          uri:  localBannerUri,
          type: localBannerMime,
          name: `tournament-banner.${ext}`,
        } as any);
      }

      let rec: any;
      if (tournament.id) {
        rec = await pb.collection('tournament_config').update(tournament.id, form);
      } else {
        rec = await pb.collection('tournament_config').create(form);
        setTournament(prev => ({ ...prev, id: rec.id }));
      }

      // Fresh-cycle cleanup (production path — the APK has no Express server, so
      // this mirrors the server's end-of-cycle wipe client-side via the PB SDK).
      // Launching a new cycle_id means a brand-new tournament, so ALL existing
      // participant rows from any previous cycle are cleared. Best-effort — never
      // block the admin save.
      try {
        const stale = await pb.collection('tournament_participants').getFullList({
          fields: 'id',
          batch:  500,
        });
        for (const r of stale) {
          try { await pb.collection('tournament_participants').delete(r.id); } catch {}
        }
        if (stale.length) {
          console.log(`[admin] Cleared ${stale.length} participant row(s) for new cycle ${cycleId}`);
        }
      } catch (cleanupErr: any) {
        console.warn('[admin] participant cleanup skipped:', cleanupErr?.message);
      }

      // Update displayed thumbnail with the newly uploaded banner
      if (rec && rec.banner) {
        const fname = Array.isArray(rec.banner) ? rec.banner[0] : rec.banner;
        const newUrl = fname ? `https://api.webcod.in/api/files/tournament_config/${rec.id}/${fname}` : '';
        setTournament(prev => ({ ...prev, existingBannerUrl: newUrl }));
        setLocalBannerUri(null);
      }
      setTournament(prev => ({ ...prev, isActive: true }));

      const durLabel = `${durDays}d ${durHours}h`;
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        hrs > 0 ? 'Tournament Scheduled' : 'Tournament Started',
        hrs > 0
          ? `Registration is open now. The tournament goes live in ${hrs} hour${hrs === 1 ? '' : 's'} and runs for ${durLabel}.`
          : `New tournament is now live for all users — it runs for ${durLabel}.`,
      );
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to save tournament config.');
    } finally {
      setSavingTournament(false);
    }
  }

  // End the running tournament immediately: set end_time = now (keeping
  // is_active=true). The server's end-of-cycle reconciler then runs payout +
  // participant wipe once for this cycle_id and flips the tournament inactive.
  async function handleEndTournamentNow() {
    if (!tournament.id) return;
    Alert.alert(
      'End tournament now?',
      'This ends the current tournament immediately. Winners are paid out and the leaderboard is cleared. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End Now',
          style: 'destructive',
          onPress: async () => {
            setSavingTournament(true);
            try {
              await pb.collection('tournament_config').update(tournament.id, {
                end_time: new Date().toISOString(),
                is_active: true,
              });
              setTournament(prev => ({ ...prev, isActive: false }));
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert('Tournament Ending', 'The tournament is wrapping up. Payouts and cleanup run within a minute.');
            } catch (e: any) {
              Alert.alert('Error', e.message || 'Failed to end tournament.');
            } finally {
              setSavingTournament(false);
            }
          },
        },
      ],
    );
  }

  async function pickDayImage(key: string) {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow photo library access to upload an image.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.90,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setDayImages(prev => ({
        ...prev,
        [key]: { ...prev[key], localUri: asset.uri, localMime: asset.mimeType || 'image/jpeg' },
      }));
    }
  }

  async function handleSaveDailySettings() {
    setSavingDailySettings(true);
    try {
      const pbFieldMap: Record<string, { imageField: string; amountField: string }> = {
        day_1:       { imageField: 'day_1_image',       amountField: 'day_1_amount' },
        day_2:       { imageField: 'day_2_image',       amountField: 'day_2_amount' },
        day_3:       { imageField: 'day_3_image',       amountField: 'day_3_amount' },
        day_4:       { imageField: 'day_4_image',       amountField: 'day_4_amount' },
        day_5:       { imageField: 'day_5_image',       amountField: 'day_5_amount' },
        day_6:       { imageField: 'day_6_image',       amountField: 'day_6_amount' },
        day_7_shiba: { imageField: 'day_7_shiba_image', amountField: 'day_7_shiba_amount' },
        day_7_power: { imageField: 'day_7_power_image', amountField: 'day_7_power_amount' },
      };
      const form = new FormData();
      for (const [key, fields] of Object.entries(pbFieldMap)) {
        const img = dayImages[key];
        if (img.localUri) {
          const ext = img.localMime.includes('png') ? 'png' : 'jpg';
          form.append(fields.imageField, { uri: img.localUri, type: img.localMime, name: `${key}-image.${ext}` } as any);
        }
        form.append(fields.amountField, dayAmounts[key] || '0');
      }
      let rec: any;
      if (dailySettingsId) {
        rec = await pb.collection('daily_claim_settings').update(dailySettingsId, form);
      } else {
        rec = await pb.collection('daily_claim_settings').create(form);
        setDailySettingsId(rec.id);
      }
      // Refresh existingUrls
      const newImages = { ...dayImages };
      for (const [key, fields] of Object.entries(pbFieldMap)) {
        const fname = rec[fields.imageField];
        if (fname) {
          newImages[key] = { ...newImages[key], existingUrl: `https://api.webcod.in/api/files/daily_claim_settings/${rec.id}/${fname}`, localUri: null };
        }
      }
      setDayImages(newImages);
      // Sync amounts to settings collection for server-side claim computation
      if (local) {
        await updateSettings({
          ...local,
          dailyRewardDay1Shib: Number(dayAmounts.day_1) || 0,
          dailyRewardDay2Pt:   Number(dayAmounts.day_2) || 0,
          dailyRewardDay3Shib: Number(dayAmounts.day_3) || 0,
          dailyRewardDay4Pt:   Number(dayAmounts.day_4) || 0,
          dailyRewardDay5Shib: Number(dayAmounts.day_5) || 0,
          dailyRewardDay6Pt:   Number(dayAmounts.day_6) || 0,
          dailyRewardDay7Shib: Number(dayAmounts.day_7_shiba) || 0,
          dailyRewardDay7Pt:   Number(dayAmounts.day_7_power) || 0,
        });
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Saved', 'Daily reward configuration updated!');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to save daily settings.');
    } finally {
      setSavingDailySettings(false);
    }
  }

  // ── Solo Game Config: load on mount ──
  useEffect(() => {
    if (!isAdmin) return;
    pb.collection('solo_game_config').getList(1, 50, { sort: 'game_id' })
      .then(res => setSoloConfigs(res.items.map((r: any) => ({
        id:             r.id,
        game_id:        r.game_id ?? '',
        game_name:      r.game_name ?? r.game_id ?? '',
        pt_multiplier:  String(r.pt_multiplier ?? ''),
        max_pt:         String(r.max_pt ?? ''),
        max_raw_score:  String(r.max_raw_score ?? ''),
        max_pt_per_sec: String(r.max_pt_per_sec ?? ''),
      }))))
      .catch(() => {});
  }, [isAdmin]);

  async function handleSaveSoloConfig(row: SoloGameConfigRow) {
    setSoloConfigSaving(row.id);
    try {
      await pb.collection('solo_game_config').update(row.id, {
        pt_multiplier:  parseFloat(row.pt_multiplier)  || 1,
        max_pt:         parseFloat(row.max_pt)         || 2000,
        max_raw_score:  parseFloat(row.max_raw_score)  || 2000,
        max_pt_per_sec: parseFloat(row.max_pt_per_sec) || 15,
      });
      Alert.alert('Saved', `${row.game_name || row.game_id} config updated.`);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to save game config');
    } finally {
      setSoloConfigSaving(null);
    }
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

          <AdminSection title="Daily Reward Images & Amounts" icon="gift">
            {([
              { key: 'day_1',       label: 'Day 1',              amtLabel: 'SHIB Amount' },
              { key: 'day_2',       label: 'Day 2',              amtLabel: 'PT Amount' },
              { key: 'day_3',       label: 'Day 3',              amtLabel: 'SHIB Amount' },
              { key: 'day_4',       label: 'Day 4',              amtLabel: 'PT Amount' },
              { key: 'day_5',       label: 'Day 5',              amtLabel: 'SHIB Amount' },
              { key: 'day_6',       label: 'Day 6',              amtLabel: 'PT Amount' },
              { key: 'day_7_shiba', label: 'Day 7 Grand — SHIB', amtLabel: 'SHIB Amount' },
              { key: 'day_7_power', label: 'Day 7 Grand — PT',   amtLabel: 'PT Amount' },
            ] as const).map(({ key, label, amtLabel }) => {
              const img = dayImages[key];
              const thumbUri = img.localUri || (img.existingUrl || null);
              return (
                <View key={key} style={{ marginBottom: 18, gap: 8 }}>
                  <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textSecondary, letterSpacing: 0.5 }}>{label}</Text>
                  <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                    {thumbUri ? (
                      <Image source={{ uri: thumbUri }} style={{ width: 54, height: 54, borderRadius: 10 }} resizeMode="cover" />
                    ) : (
                      <View style={{ width: 54, height: 54, borderRadius: 10, backgroundColor: Colors.darkCard, borderWidth: 1, borderColor: Colors.darkBorder, alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="image-outline" size={22} color={Colors.textMuted} />
                      </View>
                    )}
                    <Pressable
                      onPress={() => pickDayImage(key)}
                      style={({ pressed }) => [styles.pickerBtn, { opacity: pressed ? 0.7 : 1, flex: 1 }]}
                    >
                      <Ionicons name="cloud-upload-outline" size={16} color={Colors.gold} />
                      <Text style={styles.pickerBtnText}>{thumbUri ? 'Change Image' : 'Upload Image'}</Text>
                    </Pressable>
                  </View>
                  <AdminField
                    label={amtLabel}
                    value={dayAmounts[key] ?? ''}
                    onChangeText={(v) => setDayAmounts(prev => ({ ...prev, [key]: v }))}
                    keyboardType="numeric"
                    placeholder="e.g. 1000"
                  />
                </View>
              );
            })}
            <Pressable
              onPress={handleSaveDailySettings}
              disabled={savingDailySettings}
              style={({ pressed }) => ({ opacity: pressed || savingDailySettings ? 0.8 : 1, borderRadius: 12, overflow: 'hidden', marginTop: 4 })}
            >
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={{ paddingVertical: 13, alignItems: 'center', borderRadius: 12 }}
              >
                <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 14, color: '#0A0A0F' }}>
                  {savingDailySettings ? 'Saving…' : '✦ Save Daily Reward Config'}
                </Text>
              </LinearGradient>
            </Pressable>
          </AdminSection>

          <AdminSection title="Withdrawal Thresholds (SHIB)" icon="wallet">
            <AdminField label="Tier 1 Min (1st withdrawal)" value={String(local.minWithdrawal1)} onChangeText={(v) => setField('minWithdrawal1', Number(v) || 0)} keyboardType="numeric" />
            <AdminField label="Tier 2 Min (2nd withdrawal)" value={String(local.minWithdrawal2)} onChangeText={(v) => setField('minWithdrawal2', Number(v) || 0)} keyboardType="numeric" />
            <AdminField label="Tier 3 Min (3rd+ withdrawal)" value={String(local.minWithdrawal3)} onChangeText={(v) => setField('minWithdrawal3', Number(v) || 0)} keyboardType="numeric" />
            <AdminField label="BEP-20 Network Fee (0 = default 3680)" value={String(local.bep20Fees ?? 3680)} onChangeText={(v) => setField('bep20Fees', Number(v) || 0)} keyboardType="numeric" />
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
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Force Unity Only</Text>
              <Switch
                value={local.forceUnityOnly}
                onValueChange={(v) => setField('forceUnityOnly', v)}
                trackColor={{ false: Colors.darkSurface, true: Colors.gold + '60' }}
                thumbColor={local.forceUnityOnly ? Colors.gold : Colors.textMuted}
              />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Network Guard (VPN/Proxy Block)</Text>
              <Switch
                value={local.networkGuardEnabled}
                onValueChange={(v) => setField('networkGuardEnabled', v)}
                trackColor={{ false: Colors.darkSurface, true: Colors.gold + '60' }}
                thumbColor={local.networkGuardEnabled ? Colors.gold : Colors.textMuted}
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
            <AdminField label="Minimum App Version (Force Update)" value={(local as any).minimumVersion || ''} onChangeText={(v) => setField('minimumVersion' as any, v)} placeholder="e.g. 1.0.2 — leave empty to disable" />
          </AdminSection>

          {/* ── VIP Override ────────────────────────────────────────────── */}
          <AdminSection title="VIP Override" icon="crown">
            <Text style={styles.fieldLabel}>Search user (email / referral code / name)</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              <TextInput
                style={[styles.fieldInput, { flex: 1 }]}
                value={vipQuery}
                onChangeText={setVipQuery}
                placeholder="user@email.com"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={handleVipSearch}
                returnKeyType="search"
              />
              <Pressable onPress={handleVipSearch} style={styles.vipSearchBtn} disabled={vipSearching}>
                {vipSearching
                  ? <ActivityIndicator color="#1a1200" size="small" />
                  : <Ionicons name="search" size={18} color="#1a1200" />}
              </Pressable>
            </View>

            {!vipSearching && vipResults.length === 0 && (
              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>
                No users found yet — search above to override a VIP level.
              </Text>
            )}

            {vipResults.map((u) => (
              <View key={u.pbId} style={styles.vipUserCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.vipUserEmail} numberOfLines={1}>
                      {u.email || u.displayName || u.pbId}
                    </Text>
                    <Text style={styles.vipUserMeta}>
                      Current VIP {u.vipLevel}
                      {u.isAdminPromoted ? ` · floor ${u.adminPromotedLevel} (immune)` : ''}
                    </Text>
                    {(u.isBlacklist1 || u.isBlacklist2) && (
                      <View style={styles.blacklistBadge}>
                        <MaterialCommunityIcons name="alert" size={11} color="#fff" />
                        <Text style={styles.blacklistBadgeText}>
                          {u.isBlacklist2 ? 'BLACKLIST 2 · repeat offender' : 'BLACKLIST 1 · flagged'}
                        </Text>
                      </View>
                    )}
                  </View>
                  {vipSavingId === u.pbId && <ActivityIndicator color={Colors.gold} size="small" />}
                </View>
                {u.kycStatus === 'verified' && (
                  <Pressable
                    style={styles.unverifyBtn}
                    disabled={unverifyingId === u.pbId}
                    onPress={() => handleUnverify(u)}
                    testID={`admin-unverify-${u.pbId}`}
                  >
                    {unverifyingId === u.pbId
                      ? <ActivityIndicator color={Colors.error} size="small" />
                      : (
                        <>
                          <Ionicons name="shield-outline" size={13} color={Colors.error} />
                          <Text style={styles.unverifyBtnText}>Unverify Account</Text>
                        </>
                      )}
                  </Pressable>
                )}
                <View style={styles.vipLevelRow}>
                  {Array.from({ length: MAX_VIP_LEVEL + 1 }, (_, lvl) => (
                    <Pressable
                      key={lvl}
                      onPress={() => handleSetVip(u.pbId, lvl)}
                      disabled={vipSavingId === u.pbId}
                      style={[styles.vipLevelChip, u.vipLevel === lvl && styles.vipLevelChipActive]}
                    >
                      <Text style={[styles.vipLevelChipText, u.vipLevel === lvl && styles.vipLevelChipTextActive]}>
                        {lvl}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
          </AdminSection>

          {/* ── Verification Requests (KYC) ─────────────────────────────── */}
          <AdminSection title="Verification Requests" icon="shield-account">
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={styles.fieldLabel}>
                {verifLoading ? 'Loading…' : `${verifications.length} pending`}
              </Text>
              <Pressable onPress={fetchVerifications} style={styles.refreshBtn} disabled={verifLoading}>
                <Ionicons name="refresh" size={16} color={Colors.gold} />
              </Pressable>
            </View>

            {!verifLoading && verifications.length === 0 && (
              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>
                No pending verification requests.
              </Text>
            )}

            {verifications.map((req) => (
              <View key={req.id} style={styles.vipUserCard} testID={`verif-card-${req.id}`}>
                <Text style={styles.vipUserEmail} numberOfLines={1}>{req.fullName}</Text>
                <Text style={styles.vipUserMeta} numberOfLines={1}>
                  {req.userEmail || req.userId || '—'}
                </Text>
                <View style={{ marginTop: 8, gap: 3 }}>
                  <Text style={styles.verifDetail}>Country: <Text style={styles.verifDetailVal}>{req.country} ({req.countryCode})</Text></Text>
                  <Text style={styles.verifDetail}>Phone: <Text style={styles.verifDetailVal}>{req.countryCode} {req.phone}</Text></Text>
                  {/* Phone-verified stamp (Telegram share-contact) — set server-side at submit time */}
                  <View style={[styles.waBadge, !req.phoneVerified && styles.waBadgeOff]} testID={`verif-wa-${req.id}`}>
                    <Ionicons
                      name={req.phoneVerified ? 'paper-plane' : 'alert-circle-outline'}
                      size={12}
                      color={req.phoneVerified ? '#229ED9' : Colors.textMuted}
                    />
                    <Text style={[styles.waBadgeTxt, !req.phoneVerified && { color: Colors.textMuted }]}>
                      {req.phoneVerified ? 'Telegram verified' : 'Phone not verified'}
                    </Text>
                  </View>
                  {!!req.binanceEmail && (
                    <Text style={styles.verifDetail}>Binance Email: <Text style={styles.verifDetailVal}>{req.binanceEmail}</Text></Text>
                  )}
                  <Text style={styles.verifDetail}>BEP-20: <Text style={styles.verifDetailVal} numberOfLines={1}>{req.bep20Address}</Text></Text>
                  {!!req.created && (
                    <Text style={styles.verifDetail}>Submitted: <Text style={styles.verifDetailVal}>{req.created.slice(0, 16).replace('T', ' ')}</Text></Text>
                  )}
                </View>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <Pressable
                    style={[styles.verifApproveBtn, verifActingId === req.id && { opacity: 0.5 }]}
                    disabled={verifActingId === req.id}
                    onPress={() => handleApproveVerification(req)}
                    testID={`verif-approve-${req.id}`}
                  >
                    {verifActingId === req.id
                      ? <ActivityIndicator color="#0A0A0F" size="small" />
                      : (
                        <>
                          <Ionicons name="checkmark-circle" size={15} color="#0A0A0F" />
                          <Text style={styles.verifApproveText}>Approve</Text>
                        </>
                      )}
                  </Pressable>
                  <Pressable
                    style={[styles.verifRejectBtn, verifActingId === req.id && { opacity: 0.5 }]}
                    disabled={verifActingId === req.id}
                    onPress={() => { setRejectReason(KYC_REJECT_REASONS[0]); setRejectTarget(req); }}
                    testID={`verif-reject-${req.id}`}
                  >
                    <Ionicons name="close-circle" size={15} color={Colors.error} />
                    <Text style={styles.verifRejectText}>Reject</Text>
                  </Pressable>
                </View>
              </View>
            ))}
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

          {/* ── Live Support ─────────────────────────────────────────────── */}
          <AdminSection title={`Live Support (${supportTickets.length})`} icon="headset">
            {/* Tab selector */}
            <View style={styles.supportTabRow}>
              {(['Pending', 'Replied'] as const).map(tab => (
                <Pressable
                  key={tab}
                  style={[styles.supportTab, supportTab === tab && styles.supportTabActive]}
                  onPress={() => setSupportTab(tab)}
                >
                  <Text style={[styles.supportTabText, supportTab === tab && styles.supportTabTextActive]}>
                    {tab} ({supportTickets.filter(t => t.status === tab).length})
                  </Text>
                </Pressable>
              ))}
              <Pressable onPress={fetchSupportTickets} style={styles.refreshBtn}>
                <Ionicons name="refresh" size={15} color={Colors.textMuted} />
              </Pressable>
            </View>

            {supportLoading ? (
              <ActivityIndicator color={Colors.gold} style={{ marginVertical: 12 }} />
            ) : supportTickets.filter(t => t.status === supportTab).length === 0 ? (
              <Text style={styles.emptyText}>No {supportTab.toLowerCase()} tickets.</Text>
            ) : (
              supportTickets
                .filter(t => t.status === supportTab)
                .map(ticket => (
                  <View key={ticket.id} style={styles.supportCard}>
                    {/* Header row */}
                    <View style={styles.supportCardHeader}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.supportUserName}>{ticket.user_name}</Text>
                        <Text style={styles.supportUserEmail}>{ticket.user_email}</Text>
                      </View>
                      <View style={[
                        styles.supportStatusBadge,
                        { backgroundColor: ticket.status === 'Pending' ? 'rgba(255,107,0,0.15)' : 'rgba(76,175,80,0.15)' }
                      ]}>
                        <Text style={[
                          styles.supportStatusText,
                          { color: ticket.status === 'Pending' ? Colors.neonOrange : '#4CAF50' }
                        ]}>{ticket.status}</Text>
                      </View>
                    </View>

                    {/* Question */}
                    <Text style={styles.supportLabel}>Question</Text>
                    <Text style={styles.supportQuestion}>{ticket.question}</Text>

                    {/* If already replied — show the reply */}
                    {ticket.status === 'Replied' && !!ticket.reply && (
                      <>
                        <Text style={styles.supportLabel}>Your Reply</Text>
                        <Text style={styles.supportReplyText}>{ticket.reply}</Text>
                        {!ticket.is_read_by_user && (
                          <View style={styles.unreadBadge}>
                            <Text style={styles.unreadBadgeText}>● Not yet seen by user</Text>
                          </View>
                        )}
                      </>
                    )}

                    {/* Reply input — always available to update */}
                    {ticket.status === 'Pending' && (
                      <>
                        <Text style={styles.supportLabel}>Reply</Text>
                        <TextInput
                          style={styles.supportReplyInput}
                          value={replyTexts[ticket.id] ?? ''}
                          onChangeText={v => setReplyTexts(prev => ({ ...prev, [ticket.id]: v }))}
                          placeholder="Type your reply…"
                          placeholderTextColor={Colors.textMuted}
                          multiline
                          numberOfLines={3}
                          textAlignVertical="top"
                        />
                        <Pressable
                          style={[styles.replyBtn, (!replyTexts[ticket.id]?.trim() || replyingId === ticket.id) && { opacity: 0.5 }]}
                          onPress={() => handleSendReply(ticket.id)}
                          disabled={!replyTexts[ticket.id]?.trim() || replyingId === ticket.id}
                        >
                          <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.replyBtnGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                            {replyingId === ticket.id
                              ? <ActivityIndicator size="small" color="#000" />
                              : <Text style={styles.replyBtnText}>Send Reply</Text>}
                          </LinearGradient>
                        </Pressable>
                      </>
                    )}

                    {/* Timestamp */}
                    <Text style={styles.supportTimestamp}>
                      {new Date(ticket.created).toLocaleDateString()} {new Date(ticket.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                ))
            )}
          </AdminSection>

          {/* ── Tournament Setup ─────────────────────────────────────── */}
          <AdminSection title="Tournament Setup" icon="trophy">
            {/* Current status banner */}
            <View style={[styles.statusPill, tournament.isActive ? styles.statusPillLive : styles.statusPillInactive]}>
              <View style={[styles.statusDot, { backgroundColor: tournament.isActive ? '#00C853' : '#FF453A' }]} />
              <Text style={[styles.statusPillText, { color: tournament.isActive ? '#00C853' : '#FF453A' }]}>
                {tournament.isActive ? 'TOURNAMENT ACTIVE' : 'NO ACTIVE TOURNAMENT'}
              </Text>
            </View>

            {/* ── Banner image picker ── */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Tournament Banner Image</Text>
              {/* Thumbnail preview — local pick takes priority, then existing from PB */}
              {(localBannerUri || tournament.existingBannerUrl) ? (
                <Image
                  source={{ uri: localBannerUri || tournament.existingBannerUrl }}
                  style={styles.bannerThumb}
                  resizeMode="cover"
                />
              ) : (
                <View style={styles.bannerThumbEmpty}>
                  <MaterialCommunityIcons name="image-outline" size={32} color={Colors.textMuted} />
                  <Text style={styles.bannerThumbEmptyText}>No banner uploaded yet</Text>
                </View>
              )}
              <Pressable style={styles.pickerBtn} onPress={pickBannerImage}>
                <MaterialCommunityIcons name="image-plus" size={16} color={Colors.gold} />
                <Text style={styles.pickerBtnText}>
                  {localBannerUri ? 'Change Image' : tournament.existingBannerUrl ? 'Replace Banner' : 'Upload Banner'}
                </Text>
              </Pressable>
              {localBannerUri && (
                <Text style={[styles.emptyText, { color: '#00C853', textAlign: 'left', marginTop: 2 }]}>
                  ✓ New image selected — will upload on Save
                </Text>
              )}
            </View>
            <AdminField
              label="Total Prize Pool (SHIB)"
              value={tournament.prizePool}
              onChangeText={v => setTournament(p => ({ ...p, prizePool: v }))}
              keyboardType="numeric"
            />

            <AdminField
              label="Start in hours (0 = now)"
              value={tournament.startInHours}
              onChangeText={v => setTournament(p => ({ ...p, startInHours: v.replace(/[^0-9]/g, '') }))}
              keyboardType="numeric"
            />

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Tournament Duration</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <AdminField
                    label="Days"
                    value={tournament.durationDays}
                    onChangeText={v => setTournament(p => ({ ...p, durationDays: v.replace(/[^0-9]/g, '') }))}
                    keyboardType="numeric"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <AdminField
                    label="Hours"
                    value={tournament.durationHours}
                    onChangeText={v => setTournament(p => ({ ...p, durationHours: v.replace(/[^0-9]/g, '') }))}
                    keyboardType="numeric"
                  />
                </View>
              </View>
            </View>

            <Text style={[styles.emptyText, { textAlign: 'left', marginTop: -4, marginBottom: 4 }]}>
              {(() => {
                const h  = Math.max(0, Number(tournament.startInHours) || 0);
                const dd = Math.max(0, Number(tournament.durationDays) || 0);
                const dh = Math.max(0, Number(tournament.durationHours) || 0);
                const durLabel = `${dd}d ${dh}h`;
                if (dd === 0 && dh === 0) return 'Set a duration of at least 1 hour.';
                return h > 0
                  ? `Registration opens now; tournament goes live in ${h} hour${h === 1 ? '' : 's'} and runs for ${durLabel}.`
                  : `Tournament goes live immediately and runs for ${durLabel}.`;
              })()}
            </Text>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Winners Cap</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['3', '50', '100'] as const).map(n => (
                  <Pressable
                    key={n}
                    style={[styles.typeBtn, tournament.winnersCount === n && styles.typeBtnActive]}
                    onPress={() => setTournament(p => ({ ...p, winnersCount: n }))}
                  >
                    <Text style={[styles.typeBtnText, tournament.winnersCount === n && styles.typeBtnTextActive]}>
                      Top {n}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Rank Prizes (SHIB)</Text>
              <View style={{ gap: 8 }}>
                <AdminField label="🥇 1st Place"  value={tournament.rank1} onChangeText={v => setTournament(p => ({ ...p, rank1: v }))} keyboardType="numeric" />
                <AdminField label="🥈 2nd Place"  value={tournament.rank2} onChangeText={v => setTournament(p => ({ ...p, rank2: v }))} keyboardType="numeric" />
                <AdminField label="🥉 3rd Place"  value={tournament.rank3} onChangeText={v => setTournament(p => ({ ...p, rank3: v }))} keyboardType="numeric" />
              </View>
            </View>

            <Pressable
              style={[styles.createBtn, savingTournament && { opacity: 0.6 }]}
              disabled={savingTournament}
              onPress={handleSaveTournament}
            >
              <LinearGradient colors={['#00C853', '#1B5E20']} style={styles.createBtnGrad}>
                {savingTournament
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={[styles.createBtnText, { color: '#fff' }]}>🚀  Launch New Tournament</Text>}
              </LinearGradient>
            </Pressable>

            <Text style={[styles.emptyText, { marginTop: 4 }]}>
              Launching mints a fresh cycle, clears the previous leaderboard, and shows the popup to all users.
            </Text>

            {/* End tournament now — only when one is active */}
            {tournament.isActive && tournament.id && (
              <>
                <Pressable
                  style={[styles.endNowBtn, savingTournament && { opacity: 0.6 }]}
                  disabled={savingTournament}
                  onPress={handleEndTournamentNow}
                >
                  <MaterialCommunityIcons name="stop-circle-outline" size={18} color="#FF453A" />
                  <Text style={styles.endNowBtnText}>End Tournament Now</Text>
                </Pressable>
                <Text style={[styles.emptyText, { marginTop: 4 }]}>
                  Ends the current cycle immediately — winners are paid out and the leaderboard is cleared.
                </Text>
              </>
            )}
          </AdminSection>

          <AdminSection title="Solo Game Config" icon="gamepad-variant">
            {soloConfigs.length === 0 ? (
              <Text style={styles.emptyText}>Loading… (collection seeded by backend on first boot)</Text>
            ) : (
              soloConfigs.map(row => (
                <View key={row.id} style={{ marginBottom: 20 }}>
                  <Text style={[styles.fieldLabel, { marginBottom: 6, color: Colors.neonOrange }]}>
                    {row.game_name || row.game_id}
                  </Text>
                  <AdminField
                    label="PT Multiplier  (raw score × this = PT)"
                    value={row.pt_multiplier}
                    keyboardType="numeric"
                    onChangeText={v => setSoloConfigs(cs => cs.map(c => c.id === row.id ? { ...c, pt_multiplier: v } : c))}
                  />
                  <AdminField
                    label="Max PT per session"
                    value={row.max_pt}
                    keyboardType="numeric"
                    onChangeText={v => setSoloConfigs(cs => cs.map(c => c.id === row.id ? { ...c, max_pt: v } : c))}
                  />
                  <AdminField
                    label="Max Raw Score (hard cap)"
                    value={row.max_raw_score}
                    keyboardType="numeric"
                    onChangeText={v => setSoloConfigs(cs => cs.map(c => c.id === row.id ? { ...c, max_raw_score: v } : c))}
                  />
                  <AdminField
                    label="Max PT/sec (anti-cheat rate cap)"
                    value={row.max_pt_per_sec}
                    keyboardType="numeric"
                    onChangeText={v => setSoloConfigs(cs => cs.map(c => c.id === row.id ? { ...c, max_pt_per_sec: v } : c))}
                  />
                  <Pressable
                    style={[styles.saveBtn, soloConfigSaving === row.id && { opacity: 0.6 }]}
                    onPress={() => handleSaveSoloConfig(row)}
                    disabled={soloConfigSaving === row.id}
                  >
                    <LinearGradient colors={[Colors.neonOrange, '#CC4400']} style={styles.saveBtnGradient}>
                      <Text style={styles.saveBtnText}>
                        {soloConfigSaving === row.id ? 'Saving…' : `Save ${row.game_name || row.game_id}`}
                      </Text>
                    </LinearGradient>
                  </Pressable>
                </View>
              ))
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

    {/* KYC reject-reason picker modal */}
    <Modal visible={!!rejectTarget} transparent animationType="fade" onRequestClose={() => setRejectTarget(null)}>
      <View style={styles.rejectOverlay}>
        <View style={styles.rejectCard}>
          <Text style={styles.rejectTitle}>Reject Verification</Text>
          <Text style={styles.rejectSub} numberOfLines={1}>
            {rejectTarget?.fullName} · {rejectTarget?.userEmail || rejectTarget?.userId || ''}
          </Text>
          <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Select a reason (shown to the user):</Text>
          {KYC_REJECT_REASONS.map((r) => (
            <Pressable
              key={r}
              style={[styles.rejectReasonRow, rejectReason === r && styles.rejectReasonRowActive]}
              onPress={() => setRejectReason(r)}
              testID={`reject-reason-${r}`}
            >
              <Ionicons
                name={rejectReason === r ? 'radio-button-on' : 'radio-button-off'}
                size={17}
                color={rejectReason === r ? Colors.gold : Colors.textMuted}
              />
              <Text style={[styles.rejectReasonText, rejectReason === r && { color: Colors.textPrimary }]}>{r}</Text>
            </Pressable>
          ))}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <Pressable style={styles.rejectCancelBtn} onPress={() => setRejectTarget(null)}>
              <Text style={styles.rejectCancelText}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.rejectConfirmBtn} onPress={handleRejectVerification} testID="reject-confirm">
              <Text style={styles.rejectConfirmText}>Reject</Text>
            </Pressable>
          </View>
        </View>
      </View>
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
  vipSearchBtn: { width: 46, height: 44, borderRadius: 12, backgroundColor: Colors.gold, alignItems: 'center', justifyContent: 'center' },
  vipUserCard: { marginTop: 12, padding: 12, borderRadius: 14, backgroundColor: Colors.darkSurface, borderWidth: 1, borderColor: Colors.darkBorder },
  vipUserEmail: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textPrimary },
  vipUserMeta: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  blacklistBadge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, marginTop: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: Colors.error },
  blacklistBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 10, color: '#fff', letterSpacing: 0.4 },

  /* ── KYC verification ── */
  unverifyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 10, paddingVertical: 8, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.error + '66', backgroundColor: Colors.error + '14',
  },
  unverifyBtnText: { fontFamily: 'Inter_700Bold', fontSize: 12, color: Colors.error },
  verifDetail: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary },
  verifDetailVal: { fontFamily: 'Inter_500Medium', color: Colors.textPrimary },
  waBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    marginTop: 2,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(34,158,217,0.5)',
    backgroundColor: 'rgba(34,158,217,0.10)',
  },
  waBadgeOff: {
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  waBadgeTxt: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: '#229ED9' },
  verifApproveBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: 10, backgroundColor: Colors.gold,
  },
  verifApproveText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#0A0A0F' },
  verifRejectBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: Colors.error + '66',
    backgroundColor: Colors.error + '14',
  },
  verifRejectText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.error },
  rejectOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  rejectCard: {
    width: '100%', maxWidth: 420, backgroundColor: Colors.darkCard, borderRadius: 18,
    borderWidth: 1, borderColor: Colors.darkBorder, padding: 18,
  },
  rejectTitle: { fontFamily: 'Inter_700Bold', fontSize: 17, color: Colors.textPrimary },
  rejectSub: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary, marginTop: 3 },
  rejectReasonRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 10,
    borderRadius: 10, marginTop: 6, backgroundColor: Colors.darkSurface,
    borderWidth: 1, borderColor: 'transparent',
  },
  rejectReasonRowActive: { borderColor: Colors.gold + '66', backgroundColor: Colors.gold + '12' },
  rejectReasonText: { fontFamily: 'Inter_500Medium', fontSize: 13, color: Colors.textSecondary, flex: 1 },
  rejectCancelBtn: {
    flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center',
    borderWidth: 1, borderColor: Colors.darkBorder, backgroundColor: Colors.darkSurface,
  },
  rejectCancelText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: Colors.textSecondary },
  rejectConfirmBtn: {
    flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center', backgroundColor: Colors.error,
  },
  rejectConfirmText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#fff' },
  vipLevelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  vipLevelChip: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.darkCard, borderWidth: 1, borderColor: Colors.darkBorder },
  vipLevelChipActive: { backgroundColor: Colors.gold, borderColor: Colors.gold },
  vipLevelChipText: { fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textSecondary },
  vipLevelChipTextActive: { color: '#1a1200' },
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
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, marginBottom: 12,
  },
  statusPillLive:     { backgroundColor: 'rgba(0,200,83,0.10)', borderColor: 'rgba(0,200,83,0.35)' },
  statusPillInactive: { backgroundColor: 'rgba(255,69,58,0.10)', borderColor: 'rgba(255,69,58,0.35)' },
  statusDot:          { width: 8, height: 8, borderRadius: 4 },
  statusPillText:     { fontFamily: 'Inter_700Bold', fontSize: 11, letterSpacing: 1 },
  endNowBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 12, paddingVertical: 13, borderRadius: 12,
    backgroundColor: 'rgba(255,69,58,0.08)', borderWidth: 1, borderColor: 'rgba(255,69,58,0.40)',
  },
  endNowBtnText: { fontFamily: 'Inter_700Bold', fontSize: 14, color: '#FF453A' },
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
  // Live Support
  supportTabRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  supportTab: {
    paddingHorizontal: 16, paddingVertical: 7, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.darkBorder,
    backgroundColor: Colors.darkSurface,
  },
  supportTabActive: { borderColor: Colors.gold, backgroundColor: 'rgba(244,196,48,0.1)' },
  supportTabText: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textMuted },
  supportTabTextActive: { color: Colors.gold },
  supportCard: {
    backgroundColor: Colors.darkSurface, borderRadius: 14, padding: 14,
    gap: 8, marginBottom: 12, borderWidth: 1, borderColor: Colors.darkBorder,
  },
  supportCardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 4 },
  supportUserName: { fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.textPrimary },
  supportUserEmail: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary },
  supportStatusBadge: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4 },
  supportStatusText: { fontFamily: 'Inter_700Bold', fontSize: 11 },
  supportLabel: {
    fontFamily: 'Inter_500Medium', fontSize: 10,
    color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8,
  },
  supportQuestion: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textPrimary, lineHeight: 20 },
  supportReplyText: {
    fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textPrimary,
    lineHeight: 20, backgroundColor: 'rgba(244,196,48,0.06)',
    borderRadius: 10, padding: 10,
  },
  supportReplyInput: {
    backgroundColor: Colors.darkCard, borderRadius: 10, padding: 12,
    fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textPrimary,
    borderWidth: 1, borderColor: Colors.darkBorder, minHeight: 80,
  },
  replyBtn: {},
  replyBtnGrad: { borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  replyBtnText: { fontFamily: 'Inter_700Bold', fontSize: 13, color: '#000' },
  supportTimestamp: {
    fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted,
    textAlign: 'right', marginTop: 4,
  },
  unreadBadge: {
    backgroundColor: 'rgba(255,59,48,0.12)', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start',
  },
  unreadBadgeText: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: '#FF3B30' },
  // Banner image picker
  bannerThumb: {
    width: '100%', height: 140, borderRadius: 10,
    backgroundColor: Colors.darkCard, marginBottom: 8,
  },
  bannerThumbEmpty: {
    width: '100%', height: 100, borderRadius: 10,
    backgroundColor: Colors.darkSurface,
    borderWidth: 1, borderColor: Colors.darkBorder, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 8,
  },
  bannerThumbEmptyText: {
    fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted,
  },
  pickerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.darkSurface,
    borderWidth: 1, borderColor: Colors.gold + '40',
    borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14,
  },
  pickerBtnText: {
    fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.gold,
  },
});
