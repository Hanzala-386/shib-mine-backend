import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Alert, Switch, Platform,
  Modal, TextInput, Image, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  deleteUser,
} from 'firebase/auth';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useWallet } from '@/context/WalletContext';
import { getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';

const AVATAR_KEY = 'profile_avatar_uri';
const APP_VERSION = '1.0.0';
const APP_NAME    = 'SHIB Mine';

/* ── helpers ── */
function formatShib(val: number) {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(0)}K`;
  return val.toLocaleString();
}
function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
async function fetchJson(path: string) {
  const url = new URL(path, getApiUrl());
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ── MenuItem component ── */
interface MenuItemProps {
  icon: string;
  iconLib?: 'ionicons' | 'material-community';
  label: string;
  labelColor?: string;
  value?: string;
  danger?: boolean;
  onPress?: () => void;
  rightEl?: React.ReactNode;
  testID?: string;
}
function MenuItem({ icon, iconLib = 'ionicons', label, labelColor, value, danger, onPress, rightEl, testID }: MenuItemProps) {
  const IconComp = iconLib === 'material-community' ? MaterialCommunityIcons : Ionicons;
  const color = danger ? Colors.error : labelColor ?? Colors.textPrimary;
  return (
    <Pressable
      style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.7 : 1 }]}
      onPress={onPress}
      testID={testID}
    >
      <View style={[styles.menuIconWrap, { backgroundColor: (danger ? Colors.error : Colors.neonOrange) + '20' }]}>
        <IconComp name={icon as any} size={17} color={danger ? Colors.error : Colors.neonOrange} />
      </View>
      <Text style={[styles.menuLabel, { color }]}>{label}</Text>
      <View style={styles.menuRight}>
        {value ? <Text style={styles.menuValue}>{value}</Text> : null}
        {rightEl ?? null}
        {!rightEl && <Ionicons name="chevron-forward" size={15} color={Colors.textMuted} />}
      </View>
    </Pressable>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
export default function ProfileScreen() {
  const insets  = useSafeAreaInsets();
  const { user, pbUser, firebaseUser, signOut, isAdmin, refreshBalance } = useAuth();
  const { shibBalance, powerTokens } = useWallet();

  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [showVersion, setShowVersion] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPw, setCurrentPw]  = useState('');
  const [newPw, setNewPw]          = useState('');
  const [confirmPw, setConfirmPw]  = useState('');
  const [pwLoading, setPwLoading]  = useState(false);
  const [showConfirmDeleteModal, setShowConfirmDeleteModal] = useState(false);
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [isRequestingOtp, setIsRequestingOtp] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [otpError, setOtpError] = useState('');

  const miningCount  = pbUser?.totalClaims ?? 0;
  const referralCode = user?.referralCode || pbUser?.referralCode || '';
  const pbId         = pbUser?.pbId ?? '';

  /* Referral stats */
  const { data: referralStats } = useQuery({
    queryKey: ['/api/app/user/referral-stats', pbId],
    queryFn: () => fetchJson(`/api/app/user/${pbId}/referral-stats`),
    enabled: !!pbId,
    staleTime: 60_000,
  });
  const totalReferrals = referralStats?.referredCount ?? 0;

  /* Load saved avatar */
  useEffect(() => {
    AsyncStorage.getItem(AVATAR_KEY).then((uri) => {
      if (uri) setAvatarUri(uri);
    });
    refreshBalance();
  }, []);

  async function handlePickAvatar() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow photo access to change your profile picture.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]) {
      const uri = result.assets[0].uri;
      setAvatarUri(uri);
      await AsyncStorage.setItem(AVATAR_KEY, uri);
    }
  }

  async function handleCopyReferral() {
    if (!referralCode) return;
    await Clipboard.setStringAsync(referralCode);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('Copied!', `Referral code "${referralCode}" copied to clipboard.`);
  }

  async function handleRefreshStats() {
    setRefreshing(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try { await refreshBalance(); } finally { setRefreshing(false); }
  }

  async function handleSignOut() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    await signOut();
  }

  function handleInitiateDelete() {
    if (!pbId || !firebaseUser) return;
    setShowConfirmDeleteModal(true);
  }

  async function handleSendOtp() {
    const email = firebaseUser?.email || user?.email || '';
    if (!pbId || !email) return;
    setIsRequestingOtp(true);
    try {
      await api.requestDeleteOtp(pbId, email);
      setOtpCode('');
      setOtpError('');
      setShowConfirmDeleteModal(false);
      setShowOtpModal(true);
    } catch (e: any) {
      setOtpError(e?.message || 'Could not send OTP. Please try again.');
    } finally {
      setIsRequestingOtp(false);
    }
  }

  async function handleConfirmDelete() {
    if (otpCode.length !== 6) {
      setOtpError('Please enter the full 6-digit code.');
      return;
    }
    setOtpError('');
    setIsDeleting(true);
    try {
      // 1. Verify OTP + delete PocketBase record
      await api.confirmDelete(pbId, otpCode);
      // 2. Delete Firebase account
      await deleteUser(firebaseUser!);
      // 3. Navigate away
      setShowOtpModal(false);
      Alert.alert('Account Deleted', 'Your account has been permanently deleted. Goodbye!', [
        { text: 'OK', onPress: () => signOut() },
      ]);
    } catch (e: any) {
      setIsDeleting(false);
      setOtpError(e?.message || 'Verification failed. Please try again.');
    }
  }

  async function handleChangePassword() {
    if (!newPw || !currentPw) {
      Alert.alert('Missing Fields', 'Please fill in all password fields.');
      return;
    }
    if (newPw !== confirmPw) {
      Alert.alert('Mismatch', 'New passwords do not match.');
      return;
    }
    if (newPw.length < 6) {
      Alert.alert('Too Short', 'New password must be at least 6 characters.');
      return;
    }
    if (!firebaseUser || !user?.email) {
      Alert.alert('Error', 'Not authenticated. Please sign in again.');
      return;
    }
    setPwLoading(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, currentPw);
      await reauthenticateWithCredential(firebaseUser, credential);
      await updatePassword(firebaseUser, newPw);
      setShowChangePassword(false);
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
      Alert.alert('Success', 'Your password has been updated.');
    } catch (e: any) {
      const msg = e?.code === 'auth/wrong-password' || e?.code === 'auth/invalid-credential'
        ? 'Current password is incorrect.'
        : e?.message || 'Failed to update password.';
      Alert.alert('Failed', msg);
    } finally {
      setPwLoading(false);
    }
  }

  const initials = user?.displayName?.slice(0, 2).toUpperCase() ?? 'MM';

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 0.5 }}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, {
          paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16),
          paddingBottom: 120,
        }]}
      >
        {/* ── Avatar + name header ── */}
        <Animated.View entering={FadeInDown.delay(100).springify()} style={styles.profileCard}>
          <Pressable onPress={handlePickAvatar} style={styles.avatarWrap}>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatarImg} />
            ) : (
              <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.avatarGradient}>
                <Text style={styles.avatarText}>{initials}</Text>
              </LinearGradient>
            )}
            <View style={styles.avatarEditBadge}>
              <Ionicons name="camera" size={12} color="#fff" />
            </View>
          </Pressable>
          <Text style={styles.displayName}>{user?.displayName}</Text>
          <Text style={styles.emailText}>{user?.email}</Text>
          {user?.createdAt && (
            <Text style={styles.joinDate}>Member since {formatDate(user.createdAt)}</Text>
          )}
          {isAdmin && (
            <View style={styles.adminBadge}>
              <Ionicons name="shield-checkmark" size={12} color="#000" />
              <Text style={styles.adminBadgeText}>Admin</Text>
            </View>
          )}
        </Animated.View>

        {/* ── Stats grid: Sessions / Referrals / SHIB ── */}
        <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.statsGrid}>
          <View style={styles.statCell}>
            <MaterialCommunityIcons name="pickaxe" size={18} color={Colors.gold} />
            <Text style={styles.statNum}>{miningCount}</Text>
            <Text style={styles.statLbl}>Sessions</Text>
          </View>
          <View style={[styles.statCell, styles.statCellBorder]}>
            <Ionicons name="people" size={18} color={Colors.neonOrange} />
            <Text style={styles.statNum}>{totalReferrals}</Text>
            <Text style={styles.statLbl}>Referrals</Text>
          </View>
          <View style={styles.statCell}>
            <MaterialCommunityIcons name="bitcoin" size={18} color={Colors.gold} />
            <Text style={styles.statNum}>{formatShib(shibBalance)}</Text>
            <Text style={styles.statLbl}>SHIB</Text>
          </View>
        </Animated.View>

        {/* ── Referral code card ── */}
        <Animated.View entering={FadeInDown.delay(250).springify()} style={styles.referralCard}>
          <LinearGradient
            colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)']}
            style={styles.referralInner}
          >
            <View style={styles.referralRow}>
              <View style={styles.referralIconWrap}>
                <MaterialCommunityIcons name="account-multiple-plus" size={22} color={Colors.gold} />
              </View>
              <View style={styles.referralInfo}>
                <Text style={styles.referralTitle}>Your Referral Code</Text>
                <Text style={styles.referralDesc}>Share to earn 10% commission on friends' mining</Text>
              </View>
            </View>
            <Pressable
              style={({ pressed }) => [styles.referralCodeBox, { opacity: pressed ? 0.8 : 1 }]}
              onPress={handleCopyReferral}
            >
              <Text style={styles.referralCodeText}>{referralCode || '—'}</Text>
              <View style={styles.copyBtn}>
                <Ionicons name="copy-outline" size={15} color={Colors.gold} />
                <Text style={styles.copyBtnText}>Copy</Text>
              </View>
            </Pressable>
          </LinearGradient>
        </Animated.View>

        {/* ── My Profile section ── */}
        <Animated.View entering={FadeInDown.delay(300).springify()}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>My Profile</Text>
            <Pressable onPress={handleRefreshStats} style={styles.refreshBtn} disabled={refreshing}>
              <Ionicons name="refresh" size={14} color={Colors.textMuted} style={{ opacity: refreshing ? 0.4 : 1 }} />
            </Pressable>
          </View>

          {/* Profile card: image + user info + earnings */}
          <View style={styles.myProfileCard}>
            <Pressable onPress={handlePickAvatar} style={styles.mpAvatarWrap}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.mpAvatarImg} />
              ) : (
                <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.mpAvatarGradient}>
                  <Text style={styles.mpAvatarText}>{initials}</Text>
                </LinearGradient>
              )}
              <View style={styles.mpCamBadge}>
                <Ionicons name="camera" size={10} color="#fff" />
              </View>
            </Pressable>

            <View style={styles.mpInfo}>
              <Text style={styles.mpName}>{user?.displayName ?? '—'}</Text>
              <Text style={styles.mpEmail}>{user?.email ?? '—'}</Text>
              <View style={styles.mpEarningsRow}>
                <View style={styles.mpEarningPill}>
                  <MaterialCommunityIcons name="bitcoin" size={13} color={Colors.gold} />
                  <Text style={styles.mpEarningText}>{formatShib(shibBalance)} SHIB</Text>
                </View>
                <View style={styles.mpEarningPill}>
                  <MaterialCommunityIcons name="lightning-bolt" size={13} color={Colors.neonOrange} />
                  <Text style={[styles.mpEarningText, { color: Colors.neonOrange }]}>{powerTokens} PT</Text>
                </View>
              </View>
            </View>
          </View>

          <View style={styles.menuGroup}>
            <MenuItem icon="mail-outline" label="Email" value={user?.email ?? ''} />
            <MenuItem icon="lightning-bolt" iconLib="material-community" label="Power Tokens" value={`${powerTokens} PT`} />
            <MenuItem
              icon="lock-closed-outline"
              label="Change Password"
              onPress={() => setShowChangePassword(true)}
            />
            <MenuItem
              icon="person-add-outline"
              label="Invite & Earn"
              onPress={() => router.push('/(tabs)/invite')}
            />
          </View>
        </Animated.View>

        {/* ── Preferences ── */}
        <Animated.View entering={FadeInDown.delay(400).springify()}>
          <Text style={styles.sectionTitle}>Preferences</Text>
          <View style={styles.menuGroup}>
            <MenuItem
              icon="phone-portrait-outline"
              label="Haptic Feedback"
              rightEl={
                <Switch
                  value={hapticsEnabled}
                  onValueChange={setHapticsEnabled}
                  trackColor={{ false: Colors.darkSurface, true: Colors.gold + '60' }}
                  thumbColor={hapticsEnabled ? Colors.gold : Colors.textMuted}
                />
              }
            />
          </View>
        </Animated.View>

        {/* ── Administration ── */}
        {isAdmin && (
          <Animated.View entering={FadeInDown.delay(450).springify()}>
            <Text style={styles.sectionTitle}>Administration</Text>
            <View style={styles.menuGroup}>
              <MenuItem
                icon="settings-outline"
                label="Admin Control Panel"
                labelColor={Colors.error}
                onPress={() => router.push('/admin')}
              />
            </View>
          </Animated.View>
        )}

        {/* ── App Info ── */}
        <Animated.View entering={FadeInDown.delay(500).springify()}>
          <Text style={styles.sectionTitle}>App Info</Text>
          <View style={styles.menuGroup}>
            <MenuItem
              icon="information-circle-outline"
              label="Version"
              value={`v${APP_VERSION}`}
              onPress={() => setShowVersion(true)}
            />
            <MenuItem
              icon="shield-checkmark-outline"
              label="Privacy Policy"
              onPress={() => router.push('/privacy')}
            />
            <MenuItem
              icon="document-text-outline"
              label="Terms of Service"
              onPress={() => router.push('/terms')}
            />
          </View>
        </Animated.View>

        {/* ── Sign out & Delete ── */}
        <Animated.View entering={FadeInDown.delay(600).springify()}>
          <View style={styles.menuGroup}>
            <MenuItem icon="log-out-outline" label="Sign Out" danger onPress={handleSignOut} testID="btn-signout" />
            <MenuItem
              icon="trash-outline"
              label="Delete Account"
              danger
              onPress={handleInitiateDelete}
              testID="btn-delete-account"
            />
          </View>
        </Animated.View>
      </ScrollView>

      {/* ══ VERSION MODAL ══════════════════════════════════════════════════════ */}
      <Modal visible={showVersion} transparent animationType="fade" onRequestClose={() => setShowVersion(false)}>
        <Pressable style={styles.versionOverlay} onPress={() => setShowVersion(false)}>
          <Pressable style={styles.versionCard} onPress={(e) => e.stopPropagation()}>
            <LinearGradient
              colors={['rgba(244,196,48,0.15)', 'rgba(255,107,0,0.08)']}
              style={styles.versionGradient}
            >
              <MaterialCommunityIcons name="bitcoin" size={44} color={Colors.gold} />
              <Text style={styles.versionAppName}>{APP_NAME}</Text>
              <Text style={styles.versionNum}>Version {APP_VERSION}</Text>
              <View style={styles.versionDivider} />
              <Text style={styles.versionAbout}>
                SHIB Mine is a gamified engagement platform that rewards users with virtual SHIB tokens through timed sessions, mini-games, and rewarded ads.{'\n\n'}No device hardware is used for cryptocurrency mining. All rewards are virtual and processed through our reward model.
              </Text>
              <Text style={styles.versionCopy}>© 2026 SHIB Mine. All rights reserved.</Text>
              <Pressable style={styles.versionClose} onPress={() => setShowVersion(false)}>
                <Text style={styles.versionCloseText}>Close</Text>
              </Pressable>
            </LinearGradient>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ══ CHANGE PASSWORD MODAL ══════════════════════════════════════════════ */}
      <Modal visible={showChangePassword} transparent animationType="slide" onRequestClose={() => setShowChangePassword(false)}>
        <View style={styles.pwOverlay}>
          <View style={[styles.pwSheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.pwHandle} />
            <Text style={styles.pwTitle}>Change Password</Text>
            <Text style={styles.pwSub}>You will need to enter your current password to confirm.</Text>

            <Text style={styles.pwLabel}>Current Password</Text>
            <TextInput
              style={styles.pwInput}
              value={currentPw}
              onChangeText={setCurrentPw}
              secureTextEntry
              placeholder="Enter current password"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
            />

            <Text style={styles.pwLabel}>New Password</Text>
            <TextInput
              style={styles.pwInput}
              value={newPw}
              onChangeText={setNewPw}
              secureTextEntry
              placeholder="At least 6 characters"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
            />

            <Text style={styles.pwLabel}>Confirm New Password</Text>
            <TextInput
              style={styles.pwInput}
              value={confirmPw}
              onChangeText={setConfirmPw}
              secureTextEntry
              placeholder="Repeat new password"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
            />

            <Pressable
              style={[styles.pwSubmit, pwLoading && { opacity: 0.7 }]}
              onPress={handleChangePassword}
              disabled={pwLoading}
            >
              <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.pwSubmitGradient}>
                {pwLoading
                  ? <ActivityIndicator color="#000" />
                  : <Text style={styles.pwSubmitText}>Update Password</Text>}
              </LinearGradient>
            </Pressable>

            <Pressable onPress={() => { setShowChangePassword(false); setCurrentPw(''); setNewPw(''); setConfirmPw(''); }} style={styles.pwCancel}>
              <Text style={styles.pwCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ══ CONFIRM DELETE WARNING MODAL ════════════════════════════════════════ */}
      <Modal visible={showConfirmDeleteModal} transparent animationType="fade" onRequestClose={() => !isRequestingOtp && setShowConfirmDeleteModal(false)}>
        <Pressable style={styles.versionOverlay} onPress={() => !isRequestingOtp && setShowConfirmDeleteModal(false)}>
          <Pressable style={[styles.versionCard, { padding: 0 }]} onPress={(e) => e.stopPropagation()}>
            <LinearGradient colors={['rgba(220,38,38,0.20)', 'rgba(18,10,5,0.99)']} style={[styles.versionGradient, { gap: 12 }]}>
              <Ionicons name="warning" size={48} color={Colors.error} />
              <Text style={[styles.versionAppName, { color: Colors.error }]}>Delete Account</Text>

              {/* Email badge */}
              <View style={deleteModalStyles.emailBadge}>
                <Ionicons name="mail-outline" size={14} color={Colors.textMuted} />
                <Text style={deleteModalStyles.emailText} numberOfLines={1}>
                  {firebaseUser?.email || user?.email || ''}
                </Text>
              </View>

              <Text style={deleteModalStyles.warningText}>
                {'⚠️  This action is permanent.\n\nOnce deleted, your SHIB balance, Power Tokens, and account history will be gone forever.\n\nDo you wish to proceed?'}
              </Text>

              <View style={styles.versionDivider} />

              {!!otpError && <Text style={deleteModalStyles.sendError}>{otpError}</Text>}

              <Pressable
                style={[deleteModalStyles.sendOtpBtn, isRequestingOtp && { opacity: 0.65 }]}
                onPress={handleSendOtp}
                disabled={isRequestingOtp}
                testID="btn-send-otp"
              >
                {isRequestingOtp
                  ? <ActivityIndicator color="#fff" />
                  : <>
                      <Ionicons name="send-outline" size={16} color="#fff" />
                      <Text style={deleteModalStyles.sendOtpText}>Confirm & Send OTP</Text>
                    </>
                }
              </Pressable>

              <Pressable onPress={() => { setShowConfirmDeleteModal(false); setOtpError(''); }} disabled={isRequestingOtp} style={{ paddingVertical: 8 }}>
                <Text style={{ color: Colors.textMuted, fontSize: 14, textAlign: 'center' }}>Cancel</Text>
              </Pressable>
            </LinearGradient>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ══ OTP DELETION MODAL ══════════════════════════════════════════════════ */}
      <Modal visible={showOtpModal} transparent animationType="slide" onRequestClose={() => !isDeleting && setShowOtpModal(false)}>
        <View style={otpStyles.overlay}>
          <View style={[otpStyles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={otpStyles.handle} />
            <Ionicons name="mail-outline" size={36} color={Colors.error} style={{ alignSelf: 'center', marginBottom: 8 }} />
            <Text style={otpStyles.title}>Verify Your Identity</Text>
            <Text style={otpStyles.subtitle}>
              Enter the 6-digit code sent to{'\n'}
              <Text style={{ color: Colors.textPrimary }}>{firebaseUser?.email || ''}</Text>
            </Text>

            <TextInput
              style={otpStyles.input}
              value={otpCode}
              onChangeText={(t) => { setOtpCode(t.replace(/\D/g, '').slice(0, 6)); setOtpError(''); }}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="• • • • • •"
              placeholderTextColor={Colors.textMuted}
              textAlign="center"
              autoFocus
              editable={!isDeleting}
            />

            {!!otpError && <Text style={otpStyles.error}>{otpError}</Text>}

            <Pressable
              style={[otpStyles.confirmBtn, isDeleting && { opacity: 0.6 }]}
              onPress={handleConfirmDelete}
              disabled={isDeleting}
              testID="btn-confirm-delete-otp"
            >
              {isDeleting
                ? <ActivityIndicator color="#fff" />
                : <Text style={otpStyles.confirmBtnText}>Confirm Account Deletion</Text>}
            </Pressable>

            <Pressable
              onPress={() => {
                const email = firebaseUser?.email || user?.email || '';
                if (!email || !pbId || isDeleting) return;
                setIsRequestingOtp(true);
                api.requestDeleteOtp(pbId, email)
                  .then(() => { setOtpCode(''); setOtpError(''); Alert.alert('Sent', 'A new code has been sent to your email.'); })
                  .catch((e: any) => Alert.alert('Error', e?.message || 'Could not resend OTP.'))
                  .finally(() => setIsRequestingOtp(false));
              }}
              disabled={isRequestingOtp || isDeleting}
              style={otpStyles.resendBtn}
            >
              <Text style={otpStyles.resendText}>
                {isRequestingOtp ? 'Sending…' : 'Resend Code'}
              </Text>
            </Pressable>

            <Pressable onPress={() => setShowOtpModal(false)} disabled={isDeleting} style={{ paddingVertical: 8 }}>
              <Text style={{ color: Colors.textMuted, fontSize: 14, textAlign: 'center' }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* ── Styles ── */
const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 20 },

  /* ── Header ── */
  profileCard: { alignItems: 'center', gap: 6, marginBottom: 22, paddingBottom: 4 },
  avatarWrap:  { position: 'relative', marginBottom: 8 },
  avatarImg:   { width: 82, height: 82, borderRadius: 41, borderWidth: 3, borderColor: Colors.gold },
  avatarGradient: { width: 82, height: 82, borderRadius: 41, alignItems: 'center', justifyContent: 'center' },
  avatarText:  { fontFamily: 'Inter_700Bold', fontSize: 28, color: '#000' },
  avatarEditBadge: {
    position: 'absolute', bottom: 2, right: 2,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: Colors.neonOrange,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Colors.darkBg,
  },
  displayName: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary },
  emailText:   { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary },
  joinDate:    { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
  adminBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Colors.error, borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 4, marginTop: 4,
  },
  adminBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 11, color: '#000', textTransform: 'uppercase' },

  /* ── Stats grid ── */
  statsGrid: {
    flexDirection: 'row', backgroundColor: Colors.darkCard, borderRadius: 18,
    padding: 18, marginBottom: 24, borderWidth: 1, borderColor: Colors.darkBorder,
  },
  statCell:       { flex: 1, alignItems: 'center', gap: 5 },
  statCellBorder: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: Colors.darkBorder },
  statNum:        { fontFamily: 'Inter_700Bold', fontSize: 17, color: Colors.textPrimary },
  statLbl:        { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted, textAlign: 'center' },

  /* ── Referral card ── */
  referralCard:    { borderRadius: 18, overflow: 'hidden', marginBottom: 20, borderWidth: 1, borderColor: 'rgba(244,196,48,0.25)' },
  referralInner:   { padding: 18, gap: 14 },
  referralRow:     { flexDirection: 'row', alignItems: 'center', gap: 14 },
  referralIconWrap:{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(244,196,48,0.12)', alignItems: 'center', justifyContent: 'center' },
  referralInfo:    { flex: 1 },
  referralTitle:   { fontFamily: 'Inter_600SemiBold', fontSize: 15, color: Colors.textPrimary },
  referralDesc:    { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  referralCodeBox: {
    backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: 'rgba(244,196,48,0.2)',
  },
  referralCodeText:{ fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.gold, letterSpacing: 4 },
  copyBtn:         { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(244,196,48,0.1)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  copyBtnText:     { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.gold },

  /* ── My Profile card ── */
  myProfileCard: {
    flexDirection: 'row', gap: 14, alignItems: 'center',
    backgroundColor: Colors.darkCard, borderRadius: 18, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  mpAvatarWrap:     { position: 'relative' },
  mpAvatarImg:      { width: 58, height: 58, borderRadius: 29, borderWidth: 2, borderColor: Colors.gold },
  mpAvatarGradient: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center' },
  mpAvatarText:     { fontFamily: 'Inter_700Bold', fontSize: 20, color: '#000' },
  mpCamBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: Colors.neonOrange, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: Colors.darkBg,
  },
  mpInfo:        { flex: 1, gap: 4 },
  mpName:        { fontFamily: 'Inter_700Bold', fontSize: 16, color: Colors.textPrimary },
  mpEmail:       { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
  mpEarningsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  mpEarningPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(244,196,48,0.08)', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: 'rgba(244,196,48,0.18)',
  },
  mpEarningText: { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.gold },

  /* ── Shared menu ── */
  sectionTitle:    { fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 4 },
  sectionHeaderRow:{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, marginTop: 4 },
  refreshBtn:      { padding: 4 },
  menuGroup:       { backgroundColor: Colors.darkCard, borderRadius: 18, overflow: 'hidden', marginBottom: 18, borderWidth: 1, borderColor: Colors.darkBorder },
  menuItem:        { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.darkBorder },
  menuIconWrap:    { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  menuLabel:       { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 15 },
  menuRight:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  menuValue:       { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary },

  /* ── Version modal ── */
  versionOverlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  versionCard:     { width: '100%', borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(244,196,48,0.3)' },
  versionGradient: { padding: 32, alignItems: 'center', gap: 10 },
  versionAppName:  { fontFamily: 'Inter_700Bold', fontSize: 24, color: Colors.textPrimary },
  versionNum:      { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.textMuted },
  versionDivider:  { width: 60, height: 1, backgroundColor: 'rgba(244,196,48,0.3)', marginVertical: 6 },
  versionAbout:    { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  versionCopy:     { fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textMuted },
  versionClose:    { marginTop: 8, backgroundColor: Colors.darkCard, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 32 },
  versionCloseText:{ fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.textPrimary },

  /* ── Change password modal ── */
  pwOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  pwSheet:   { backgroundColor: Colors.darkCard, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 10 },
  pwHandle:  { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.darkBorder, alignSelf: 'center', marginBottom: 4 },
  pwTitle:   { fontFamily: 'Inter_700Bold', fontSize: 20, color: Colors.textPrimary, textAlign: 'center' },
  pwSub:     { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted, textAlign: 'center', lineHeight: 18 },
  pwLabel:   { fontFamily: 'Inter_500Medium', fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  pwInput:   {
    backgroundColor: Colors.darkSurface, borderRadius: 12, height: 48, paddingHorizontal: 16,
    fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textPrimary,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  pwSubmit:         { marginTop: 4 },
  pwSubmitGradient: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  pwSubmitText:     { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#000' },
  pwCancel:         { alignItems: 'center', paddingVertical: 8 },
  pwCancelText:     { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textMuted },
});

const deleteModalStyles = StyleSheet.create({
  emailBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 20,
    paddingVertical: 6, paddingHorizontal: 14, maxWidth: '100%',
  },
  emailText: {
    fontFamily: 'Inter_500Medium', fontSize: 13,
    color: Colors.textSecondary, flexShrink: 1,
  },
  warningText: {
    fontFamily: 'Inter_400Regular', fontSize: 14,
    color: Colors.textSecondary, textAlign: 'center',
    lineHeight: 22,
  },
  sendError: {
    fontFamily: 'Inter_400Regular', fontSize: 13,
    color: Colors.error, textAlign: 'center',
  },
  sendOtpBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: Colors.error, borderRadius: 14,
    paddingVertical: 15, width: '100%',
  },
  sendOtpText: {
    fontFamily: 'Inter_700Bold', fontSize: 16, color: '#fff',
  },
});

const otpStyles = StyleSheet.create({
  overlay:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet:      { backgroundColor: '#1a1209', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 14 },
  handle:     { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.darkBorder, alignSelf: 'center', marginBottom: 8 },
  title:      { fontFamily: 'Inter_700Bold', fontSize: 20, color: Colors.error, textAlign: 'center' },
  subtitle:   { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  input: {
    borderWidth: 2,
    borderColor: Colors.error + '60',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 12,
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
    color: Colors.textPrimary,
    letterSpacing: 12,
    backgroundColor: 'rgba(220,38,38,0.06)',
    textAlign: 'center',
  },
  error:          { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.error, textAlign: 'center' },
  confirmBtn:     { backgroundColor: Colors.error, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  confirmBtnText: { fontFamily: 'Inter_700Bold', fontSize: 16, color: '#fff' },
  resendBtn:      { alignItems: 'center', paddingVertical: 6 },
  resendText:     { fontFamily: 'Inter_500Medium', fontSize: 14, color: Colors.neonOrange },
});
