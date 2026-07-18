import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

/* Storage key — per-user so every new account sees T&C */
const termsKey = (uid: string) => `shib_terms_v2_${uid}`;

/* Same compact summary shown at signup */
const TC_CONTENT = `
Shiba Hit ("the App") is a free, gamified engagement and rewards platform — NOT a cryptocurrency mining service and NOT a gambling app. No device hardware is used for mining. No real money is ever staked or wagered: all in-game tokens are earned free, mini-game challenges are contests of skill, and we never accept deposits or payments of any kind. Virtual SHIB tokens are earned through in-app engagement sessions, rewarded advertisements, mini-games, and referrals. Virtual rewards have no inherent monetary value until converted through our approved withdrawal model.

1. Eligibility
You must be at least 13 years old to use this App.

2. Restricted Territories
The App is NOT available in Iran, Ukraine, Afghanistan, or North Korea. Connections from these regions — or attempts to hide your location using VPNs or proxies — are automatically denied and may result in a permanent ban.

3. Advertising
The App shows ads from Google AdMob, Unity Ads, and AppLovin MAX. Advertising is our only source of revenue and keeps the App free. Attempting to block, spoof, or manipulate the ad delivery system is a breach of these Terms and may result in account suspension.

4. Prohibited Conduct
No bots, scripts, auto-clickers, or automated tools. No multiple accounts or referral abuse. No reverse-engineering the App. No VPNs, proxies, or anonymisation services. No unlawful use.

5. Enforcement
Multi-accounting, suspicious activity, score manipulation, or fraud results in account suspension or a permanent ban, blacklisting of your email, and forfeiture of all virtual balances and pending withdrawals.

6. Withdrawals
Withdrawals are subject to a 24-hour manual review. They may be rejected for fraud, insufficient balance, or invalid wallet information. Applicable network fees will be deducted.

7. Account Deletion
Permanent deletion requires OTP verification sent to your registered email. All data — balance, history, referrals — is irreversibly erased. Deleted accounts are permanently blacklisted and cannot re-register.

8. Changes
We may update these Terms at any time. Continued use of the App constitutes acceptance of the revised Terms.

By continuing, you confirm you have read and agree to our full Privacy Policy and Terms of Service.
`.trim();

export function TermsGateModal() {
  const { user, firebaseUser, signOut } = useAuth();
  const insets = useSafeAreaInsets();

  const [visible, setVisible]     = useState(false);
  const [scrolled, setScrolled]   = useState(false);
  const [checked, setChecked]     = useState(false);
  const [declining, setDeclining] = useState(false);

  const checked_uid = useRef<string | null>(null);

  /* ── Show modal when user becomes verified and hasn't accepted terms yet ── */
  useEffect(() => {
    if (!firebaseUser?.uid || !user?.is_verified) {
      setVisible(false);
      return;
    }
    const uid = firebaseUser.uid;
    if (checked_uid.current === uid) return; // already evaluated for this session

    AsyncStorage.getItem(termsKey(uid)).then((v) => {
      checked_uid.current = uid;
      if (v !== 'true') {
        setVisible(true);
        setScrolled(false);
        setChecked(false);
      }
    });
  }, [firebaseUser?.uid, user?.is_verified]);

  /* ── Accept → persist + dismiss ── */
  const handleAccept = useCallback(async () => {
    if (!firebaseUser?.uid) return;
    await AsyncStorage.setItem(termsKey(firebaseUser.uid), 'true');
    setVisible(false);
  }, [firebaseUser?.uid]);

  /* ── Decline → sign the user out ── */
  const handleDecline = useCallback(async () => {
    setDeclining(true);
    try { await signOut(); } catch {}
    setVisible(false);
    setDeclining(false);
  }, [signOut]);

  /* ── Scroll-to-bottom detection ──
   * Robust against the three classic "stuck scroll" failure modes:
   *  1. The final momentum event never firing through the throttled onScroll —
   *     we ALSO check on drag-end and momentum-end.
   *  2. Content that changes size (font scaling) — re-checked via
   *     onContentSizeChange; content shorter than the viewport unlocks instantly.
   *  3. Sub-pixel rounding on Android making `offset + layout === size - 0.5px`
   *     unreachable — generous 24px tolerance.
   */
  const viewportH = useRef(0);
  const contentH  = useRef(0);

  const unlockIfAtBottom = useCallback((offsetY: number) => {
    if (contentH.current <= 0 || viewportH.current <= 0) return;
    if (viewportH.current + offsetY >= contentH.current - 24) setScrolled(true);
  }, []);

  const handleScroll = useCallback((e: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    viewportH.current = layoutMeasurement.height;
    contentH.current  = contentSize.height;
    unlockIfAtBottom(contentOffset.y);
  }, [unlockIfAtBottom]);

  const handleContentSize = useCallback((_w: number, h: number) => {
    contentH.current = h;
    // Whole text already visible (large screens / small fonts) → nothing to scroll.
    if (viewportH.current > 0 && h <= viewportH.current + 1) setScrolled(true);
  }, []);

  const handleScrollLayout = useCallback((e: any) => {
    viewportH.current = e.nativeEvent.layout.height;
    if (contentH.current > 0 && contentH.current <= viewportH.current + 1) setScrolled(true);
  }, []);

  const canAccept = scrolled && checked;

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => { /* must accept or decline — cannot dismiss */ }}
    >
      <View style={tc.overlay}>
        <View style={[tc.sheet, { paddingBottom: insets.bottom + 16 }]}>
          {/* Header */}
          <View style={tc.header}>
            <MaterialCommunityIcons name="shield-check" size={22} color={Colors.gold} />
            <Text style={tc.title}>Terms & Conditions</Text>
          </View>
          <Text style={tc.subhead}>
            Please read and scroll to the bottom before continuing
          </Text>

          {/* Scrollable T&C */}
          <ScrollView
            style={tc.scroll}
            contentContainerStyle={tc.scrollContent}
            onScroll={handleScroll}
            onScrollEndDrag={handleScroll}
            onMomentumScrollEnd={handleScroll}
            onContentSizeChange={handleContentSize}
            onLayout={handleScrollLayout}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator
            nestedScrollEnabled
            bounces={false}
            overScrollMode="never"
            testID="terms-scroll"
          >
            <Text style={tc.body}>{TC_CONTENT}</Text>
            <View style={tc.scrollHint}>
              <Ionicons
                name="arrow-down-circle"
                size={18}
                color={scrolled ? '#4caf50' : Colors.textMuted}
              />
              <Text style={[tc.scrollHintText, scrolled && { color: '#4caf50' }]}>
                {scrolled ? 'Scrolled to bottom ✓' : 'Scroll to the bottom to continue'}
              </Text>
            </View>
          </ScrollView>

          {/* Checkbox */}
          <Pressable
            style={[tc.checkRow, !scrolled && { opacity: 0.4 }]}
            onPress={() => { if (scrolled) setChecked(v => !v); }}
            disabled={!scrolled}
          >
            <View style={[tc.checkbox, checked && tc.checkboxChecked]}>
              {checked && <Ionicons name="checkmark" size={14} color="#000" />}
            </View>
            <Text style={tc.checkLabel}>
              I have read and agree to the Terms & Conditions and Privacy Policy
            </Text>
          </Pressable>

          {/* Accept button */}
          <Pressable
            style={[tc.continueBtn, !canAccept && { opacity: 0.45 }]}
            onPress={handleAccept}
            disabled={!canAccept}
          >
            <LinearGradient
              colors={canAccept ? [Colors.gold, Colors.neonOrange] : ['#333', '#222']}
              style={tc.continueBtnGradient}
            >
              <Text style={[tc.continueBtnText, !canAccept && { color: Colors.textMuted }]}>
                {canAccept ? 'Accept & Enter App' : 'Scroll to bottom first'}
              </Text>
            </LinearGradient>
          </Pressable>

          {/* Decline button */}
          <Pressable onPress={handleDecline} style={tc.cancelBtn} disabled={declining}>
            <Text style={tc.cancelText}>
              {declining ? 'Signing out…' : 'Decline & Sign Out'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const tc = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1a1a2e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 20,
    paddingHorizontal: 20,
    maxHeight: '90%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  subhead: {
    fontSize: 13,
    color: Colors.textMuted,
    marginBottom: 12,
  },
  scroll: {
    maxHeight: 300,
    backgroundColor: '#0d0d1a',
    borderRadius: 10,
    marginBottom: 12,
  },
  /* Padding MUST live on the content container, not the ScrollView itself —
   * style-padding on Android shrinks the scrollable viewport without shrinking
   * contentSize, which made the bottom threshold unreachable ("stuck" scroll). */
  scrollContent: {
    padding: 12,
  },
  body: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  scrollHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    marginBottom: 4,
  },
  scrollHintText: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 16,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: Colors.darkBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: Colors.gold,
    borderColor: Colors.gold,
  },
  checkLabel: {
    flex: 1,
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  continueBtn: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 10,
  },
  continueBtnGradient: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  continueBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000',
  },
  cancelBtn: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  cancelText: {
    fontSize: 14,
    color: Colors.error,
  },
});
