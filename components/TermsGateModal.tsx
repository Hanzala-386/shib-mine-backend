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

/* Full Terms of Service — keep in sync with app/terms.tsx.
 * Exported: also shown in the signup T&C modal (app/auth.tsx). */
export const TC_CONTENT = `
Last Updated: July 18, 2026

1. Acceptance of Terms
By downloading, installing, registering with, or using the Shiba Hit application ("the App", "we", "us", "our"), you agree to be bound by these Terms of Service and our Privacy Policy. If you do not agree with any part of these Terms, you must not use the App.

These Terms constitute a legally binding agreement between you and the operator of the App. We may refuse service, terminate accounts, or restrict access at our sole discretion where these Terms are violated.

2. Nature of the Platform
Shiba Hit is a free, gamified engagement and rewards platform. For the avoidance of doubt:

• It is NOT a cryptocurrency mining service. No device hardware is used for mining or blockchain computation of any kind.
• It is NOT a gambling, betting, wagering, casino, or lottery product (see Section 3).
• It does NOT accept deposits or payments of any kind (see Section 4).

Virtual SHIB tokens and other in-app currencies are earned through:

• Completing timed in-app engagement sessions.
• Watching rewarded video advertisements.
• Participating in skill-based in-app mini-games.
• Referring new users via the referral program.

Virtual rewards do not constitute real cryptocurrency and have no direct monetary value until explicitly approved through our withdrawal reward model.

3. Not a Gambling Application
The App is not a gambling product and does not offer gambling services of any kind:

• No real money is ever staked, wagered, deposited, or risked by users anywhere in the App.
• All in-app tokens used in games (Power Tokens, Hit Tickets) are virtual items earned FREE through engagement and advertisements — they cannot be purchased with real money.
• Head-to-head mini-game challenges are contests of SKILL: outcomes are determined by player performance (score achieved), never by chance-based mechanics such as dice, cards, slots, or random draws.
• No purchase or payment is necessary to participate in any feature of the App.

Because no real-money consideration is ever collected from users, the App does not fall within the definition of gambling, betting, or wagering under applicable laws. If you believe any feature could be construed otherwise in your jurisdiction, discontinue use and contact us.

4. No Deposits — Free to Use
The App is 100% free:

• We do not accept, request, or process deposits, in-app purchases, subscriptions, or payments of any kind.
• We will never ask you to send cryptocurrency, pay a fee, or make a payment to unlock rewards, withdrawals, or features. Any such request — in-app, by email, or on social media — is fraudulent and should be reported to support@shibahit.com immediately.
• Our sole source of revenue is advertising (Section 9). This is what allows all features to remain free for every user.

5. Eligibility
You must be at least 13 years old to use this App (or older where required by the law of your country). By using the App, you represent and warrant that:

• You meet the applicable age requirement.
• All registration information you provide is accurate and truthful.
• You are creating an account for your own personal, non-commercial use.
• You are not located in, and will not access the App from, a restricted territory (Section 6).
• You have not previously had an account terminated, banned, or blacklisted by us.

6. Geographic Restrictions
The App is explicitly RESTRICTED and unavailable to users located in, or accessing the service from, the following territories:

• Islamic Republic of Iran
• Ukraine
• Islamic Republic of Afghanistan
• Democratic People's Republic of Korea (North Korea)

Enforcement:

• Network connections are screened at sign-in and continuously during use.
• Connections identified as originating from a restricted territory are automatically denied access.
• Any attempt to disguise your location — through VPNs, proxies, Tor, or other anonymisation services — is a material breach of these Terms and results in immediate, permanent account suspension and forfeiture of all virtual balances and pending withdrawals.

We maintain these restrictions to comply with applicable sanctions, export-control, and regulatory obligations. The restricted list may be expanded at any time without prior notice.

7. Data Collection
We collect the following information during registration and use:

• Email Address – for account authentication and communication.
• Username / Display Name – displayed on the public leaderboard.
• In-App Activity Data – session counts, game scores, match results, referral counts, and virtual balances.
• IP Address & Network Configuration – analysed at sign-in and during use to detect VPNs, proxies, datacenter/hosting connections, and restricted regions for security and compliance purposes.

We do not collect payment card information, government ID, or sensitive personal data. See our Privacy Policy for full details.

8. Virtual Rewards Policy
Virtual SHIB token balances are maintained within the App's reward ledger system. These balances:

• Are not legal tender, deposits, investments, or traditional cryptocurrency.
• Have no guaranteed exchange value and may be revalued at our discretion.
• May only be redeemed through the App's approved withdrawal reward model.
• Cannot be transferred, sold, or exchanged between accounts or outside the App.
• May be forfeited in full if the account is found in violation of these Terms.

All reward calculations are performed and validated server-side. In the event of a discrepancy between a value displayed on your device and our server ledger, the server ledger is final and authoritative.

9. Advertising
The App displays advertisements powered by the following certified partners:

• Google AdMob (Google LLC)
• Unity Ads (Unity Technologies)
• AppLovin MAX (AppLovin Corporation)

Rewarded video advertisements are integral to the in-app reward model and are the App's sole source of revenue. By using the App, you agree to receive ads from these networks. Attempting to circumvent, block, spoof, or manipulate the ad delivery system — including through VPNs, ad blockers, modified system settings, or tampered APKs — constitutes a material breach of these Terms and may result in immediate account suspension and forfeiture of all virtual balances.

10. Withdrawal Processing
Withdrawal requests are subject to a manual review process. Standard processing time is 24 hours from request submission. We reserve the right to extend this period for additional verification. Withdrawals may be rejected or voided if:

• The account is flagged for fraudulent activity, multi-accounting, or automation.
• The withdrawal does not meet the minimum threshold for the applicable tier.
• The provided wallet address or email is invalid.
• The account is found to be operating from a restricted territory (Section 6).

Approved withdrawal amounts reflect the net value after applicable network fees. Withdrawals are a discretionary reward disbursement, not a repayment of any deposit — the App holds no user funds because no deposits are ever accepted.

11. Prohibited Conduct
You agree not to:

• Use bots, scripts, macros, auto-clickers, accessibility-service automation, or any automated tools to manipulate session timers, gameplay, or scores.
• Create or operate multiple accounts, or use another person's account.
• Abuse the referral program through self-referral, fake accounts, or coordinated referral rings.
• Exploit bugs, glitches, or unintended behaviour instead of reporting them.
• Attempt to reverse-engineer, decompile, modify, or tamper with the App or its network traffic.
• Use the App for any unlawful purpose.
• Access the App through a VPN, proxy, Tor exit node, datacenter/hosting IP, or any network anonymisation service. The App enforces a zero-tolerance network policy: connections identified as VPN/proxy or originating from restricted regions or sanctioned territories are automatically denied access.

Violations may result in immediate account termination and forfeiture of all virtual balances.

12. Enforcement — Suspension, Ban & Blacklist
We operate a strict, multi-tier enforcement policy to protect honest users:

• DETECTION — Automated systems continuously monitor gameplay integrity (input cadence, score progression, physics-consistent timing), network signals, and cross-account patterns. Suspicious activity is flagged in real time.
• WARNING / RESTRICTION — Accounts flagged for a first offense may receive an in-app warning and temporary feature restrictions while under review.
• SUSPENSION — Confirmed violations (automation, multi-accounting, referral abuse, score manipulation, ad fraud) result in account suspension and voiding of pending withdrawals.
• PERMANENT BAN & BLACKLIST — Repeat or severe violations result in a permanent ban. The account's email address and associated identifiers are added to a permanent blacklist, preventing any future registration. Blacklisting is final and is not subject to appeal.

We reserve the right to withhold or reverse any virtual balance, ticket, or pending withdrawal that our systems determine was obtained through fraudulent or manipulated activity. All enforcement decisions are made at our sole discretion and are final.

13. Disclaimers
The App is provided "as is" and "as available" without warranties of any kind, express or implied. We do not guarantee uninterrupted availability, error-free operation, specific earnings, or that virtual balances will always be convertible. Virtual reward availability depends on operational, legal, and financial factors outside our control.

The App is an entertainment product. Nothing in the App constitutes financial, investment, or legal advice, and participation should never be treated as a source of income.

14. Limitation of Liability
To the maximum extent permitted by law, we shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of profits, data, goodwill, or virtual balances, arising from your use of — or inability to use — the App.

Because the App accepts no deposits and charges no fees, your sole and exclusive remedy for any dissatisfaction with the App is to stop using it and delete your account.

15. Account Deletion & OTP Verification
For your security, permanently deleting your account requires email-based One-Time Password (OTP) verification. Upon submitting a deletion request:

• A 6-digit OTP is sent to your registered email address.
• The OTP is valid for 5 minutes and is single-use.
• Successful verification results in the permanent, irreversible deletion of your account and all associated data, including your virtual balance and history.

This measure protects users against unauthorised account deletion.

16. Fraud Prevention & Account Blacklisting
To protect the integrity of our platform and prevent abuse, we operate a permanent email blacklist for deleted and banned accounts.

Upon account deletion or a fraud ban:

• The registered email address is permanently recorded in a blacklist database before account data is erased.
• The blacklisted email address cannot be used to register a new Shiba Hit account, ever.
• This restriction cannot be reversed or appealed.

This policy exists to prevent fraudulent exploitation of welcome bonuses (100 SHIB + 500 PT), referral rewards, and withdrawal thresholds. By using this App, you explicitly consent to and acknowledge this policy.

Attempting to circumvent this restriction — through email aliasing, new Firebase accounts, temporary email providers, or any other means — constitutes a material breach of these Terms and will result in permanent ban of all associated accounts.

17. Termination
You may stop using the App and delete your account at any time. We may suspend or terminate your access at any time, with or without notice, for any violation of these Terms. Upon termination for breach, all virtual balances, tickets, and pending withdrawals are forfeited. Sections 6, 8, 12, 13, 14, and 16 survive termination.

18. Changes to Terms
We reserve the right to modify these Terms at any time. Continued use of the App after changes are posted constitutes acceptance. We will notify users of material changes via in-app notification where practicable. If you do not accept a revision, you must stop using the App.

19. Contact
For questions regarding these Terms, contact us at:

support@shibahit.com

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
