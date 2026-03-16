import React from 'react';
import { View, Text, ScrollView, StyleSheet, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';

const SECTIONS = [
  {
    title: '1. Acceptance of Terms',
    body: `By downloading, installing, or using the SHIB Mine application ("the App"), you agree to be bound by these Terms of Service. If you do not agree, do not use the App.`,
  },
  {
    title: '2. Nature of the Platform',
    body: `SHIB Mine is a gamified engagement and rewards platform. It is NOT a cryptocurrency mining service. No device hardware is used for mining. Virtual SHIB tokens are earned through:\n\n• Completing timed in-app engagement sessions.\n• Watching rewarded video advertisements.\n• Participating in in-app mini-games.\n• Referring new users via the referral program.\n\nVirtual rewards do not constitute real cryptocurrency and have no direct monetary value until explicitly approved through our withdrawal reward model.`,
  },
  {
    title: '3. Eligibility',
    body: `You must be at least 13 years old to use this App. By using the App, you represent and warrant that you meet this age requirement and that all registration information you provide is accurate and truthful.`,
  },
  {
    title: '4. Data Collection',
    body: `We collect the following information during registration and use:\n\n• Email Address – for account authentication and communication.\n• Username / Display Name – displayed on the public leaderboard.\n• In-App Activity Data – session counts, game scores, referral counts, and virtual balances.\n\nWe do not collect payment card information, government ID, or sensitive personal data. See our Privacy Policy for full details.`,
  },
  {
    title: '5. Withdrawal Processing',
    body: `Withdrawal requests are subject to a manual review process. Standard processing time is 24 hours from request submission. We reserve the right to extend this period for additional verification. Withdrawals may be rejected if:\n\n• The account is flagged for fraudulent activity.\n• The withdrawal does not meet the minimum threshold for the applicable tier.\n• The provided wallet address or email is invalid.\n\nApproved withdrawal amounts reflect the net value after applicable network fees.`,
  },
  {
    title: '6. Virtual Rewards Policy',
    body: `Virtual SHIB token balances are maintained within the App's reward ledger system. These balances:\n\n• Are not legal tender or traditional cryptocurrency.\n• Have no guaranteed exchange value.\n• May only be redeemed through the App's approved withdrawal reward model.\n• Cannot be transferred between accounts.\n• May be forfeited if the account is found in violation of these Terms.`,
  },
  {
    title: '7. Advertising',
    body: `The App displays advertisements powered by the following certified partners:\n\n• Google AdMob (Google LLC)\n• Unity Ads (Unity Technologies)\n• AppLovin MAX (AppLovin Corporation)\n\nRewarded video advertisements are integral to the in-app reward model. By using the App, you agree to receive ads from these networks. Attempting to circumvent, block, spoof, or manipulate the ad delivery system — including through VPNs, ad blockers, or tampered APKs — constitutes a material breach of these Terms and may result in immediate account suspension and forfeiture of all virtual balances.`,
  },
  {
    title: '8. Prohibited Conduct',
    body: `You agree not to:\n\n• Use bots, scripts, or automated tools to manipulate session timers or scores.\n• Create multiple accounts to abuse the referral program.\n• Attempt to reverse-engineer or tamper with the App.\n• Use the App for any unlawful purpose.\n\nViolations may result in immediate account termination and forfeiture of all virtual balances.`,
  },
  {
    title: '9. Disclaimers',
    body: `The App is provided "as is" without warranties of any kind. We do not guarantee uninterrupted availability, specific earnings, or that virtual balances will always be convertible. Virtual reward availability depends on operational, legal, and financial factors outside our control.`,
  },
  {
    title: '10. Changes to Terms',
    body: `We reserve the right to modify these Terms at any time. Continued use of the App after changes are posted constitutes acceptance. We will notify users of material changes via in-app notification where practicable.`,
  },
  {
    title: '11. Contact',
    body: `For questions regarding these Terms, contact us at:\n\n[ENTER_SUPPORT_EMAIL_HERE]`,
  },
];

export default function TermsScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 12) }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Terms of Service</Text>
        <View style={{ width: 38 }} />
      </View>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 0) + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.lastUpdated}>Last Updated: March 15, 2026</Text>
        {SECTIONS.map((s) => (
          <View key={s.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{s.title}</Text>
            <Text style={styles.sectionBody}>{s.body}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.darkBg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.darkBorder,
  },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.darkCard, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 17, color: Colors.textPrimary },
  scroll: { paddingHorizontal: 22, paddingTop: 20 },
  lastUpdated: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted, marginBottom: 24 },
  section: { marginBottom: 26 },
  sectionTitle: { fontFamily: 'Inter_700Bold', fontSize: 15, color: Colors.gold, marginBottom: 10 },
  sectionBody: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary, lineHeight: 22 },
});
