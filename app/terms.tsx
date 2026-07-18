import React from 'react';
import { View, Text, ScrollView, StyleSheet, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';

const SECTIONS = [
  {
    title: '1. Acceptance of Terms',
    body: `By downloading, installing, registering with, or using the Shiba Hit application ("the App", "we", "us", "our"), you agree to be bound by these Terms of Service and our Privacy Policy. If you do not agree with any part of these Terms, you must not use the App.\n\nThese Terms constitute a legally binding agreement between you and the operator of the App. We may refuse service, terminate accounts, or restrict access at our sole discretion where these Terms are violated.`,
  },
  {
    title: '2. Nature of the Platform',
    body: `Shiba Hit is a free, gamified engagement and rewards platform. For the avoidance of doubt:\n\n• It is NOT a cryptocurrency mining service. No device hardware is used for mining or blockchain computation of any kind.\n• It is NOT a gambling, betting, wagering, casino, or lottery product (see Section 3).\n• It does NOT accept deposits or payments of any kind (see Section 4).\n\nVirtual SHIB tokens and other in-app currencies are earned through:\n\n• Completing timed in-app engagement sessions.\n• Watching rewarded video advertisements.\n• Participating in skill-based in-app mini-games.\n• Referring new users via the referral program.\n\nVirtual rewards do not constitute real cryptocurrency and have no direct monetary value until explicitly approved through our withdrawal reward model.`,
  },
  {
    title: '3. Not a Gambling Application',
    body: `The App is not a gambling product and does not offer gambling services of any kind:\n\n• No real money is ever staked, wagered, deposited, or risked by users anywhere in the App.\n• All in-app tokens used in games (Power Tokens, Hit Tickets) are virtual items earned FREE through engagement and advertisements — they cannot be purchased with real money.\n• Head-to-head mini-game challenges are contests of SKILL: outcomes are determined by player performance (score achieved), never by chance-based mechanics such as dice, cards, slots, or random draws.\n• No purchase or payment is necessary to participate in any feature of the App.\n\nBecause no real-money consideration is ever collected from users, the App does not fall within the definition of gambling, betting, or wagering under applicable laws. If you believe any feature could be construed otherwise in your jurisdiction, discontinue use and contact us.`,
  },
  {
    title: '4. No Deposits — Free to Use',
    body: `The App is 100% free:\n\n• We do not accept, request, or process deposits, in-app purchases, subscriptions, or payments of any kind.\n• We will never ask you to send cryptocurrency, pay a fee, or make a payment to unlock rewards, withdrawals, or features. Any such request — in-app, by email, or on social media — is fraudulent and should be reported to support@shibahit.com immediately.\n• Our sole source of revenue is advertising (Section 9). This is what allows all features to remain free for every user.`,
  },
  {
    title: '5. Eligibility',
    body: `You must be at least 13 years old to use this App (or older where required by the law of your country). By using the App, you represent and warrant that:\n\n• You meet the applicable age requirement.\n• All registration information you provide is accurate and truthful.\n• You are creating an account for your own personal, non-commercial use.\n• You are not located in, and will not access the App from, a restricted territory (Section 6).\n• You have not previously had an account terminated, banned, or blacklisted by us.`,
  },
  {
    title: '6. Geographic Restrictions',
    body: `The App is explicitly RESTRICTED and unavailable to users located in, or accessing the service from, the following territories:\n\n• Islamic Republic of Iran\n• Ukraine\n• Islamic Republic of Afghanistan\n• Democratic People's Republic of Korea (North Korea)\n\nEnforcement:\n\n• Network connections are screened at sign-in and continuously during use.\n• Connections identified as originating from a restricted territory are automatically denied access.\n• Any attempt to disguise your location — through VPNs, proxies, Tor, or other anonymisation services — is a material breach of these Terms and results in immediate, permanent account suspension and forfeiture of all virtual balances and pending withdrawals.\n\nWe maintain these restrictions to comply with applicable sanctions, export-control, and regulatory obligations. The restricted list may be expanded at any time without prior notice.`,
  },
  {
    title: '7. Data Collection',
    body: `We collect the following information during registration and use:\n\n• Email Address – for account authentication and communication.\n• Username / Display Name – displayed on the public leaderboard.\n• In-App Activity Data – session counts, game scores, match results, referral counts, and virtual balances.\n• IP Address & Network Configuration – analysed at sign-in and during use to detect VPNs, proxies, datacenter/hosting connections, and restricted regions for security and compliance purposes.\n\nWe do not collect payment card information, government ID, or sensitive personal data. See our Privacy Policy for full details.`,
  },
  {
    title: '8. Virtual Rewards Policy',
    body: `Virtual SHIB token balances are maintained within the App's reward ledger system. These balances:\n\n• Are not legal tender, deposits, investments, or traditional cryptocurrency.\n• Have no guaranteed exchange value and may be revalued at our discretion.\n• May only be redeemed through the App's approved withdrawal reward model.\n• Cannot be transferred, sold, or exchanged between accounts or outside the App.\n• May be forfeited in full if the account is found in violation of these Terms.\n\nAll reward calculations are performed and validated server-side. In the event of a discrepancy between a value displayed on your device and our server ledger, the server ledger is final and authoritative.`,
  },
  {
    title: '9. Advertising',
    body: `The App displays advertisements powered by the following certified partners:\n\n• Google AdMob (Google LLC)\n• Unity Ads (Unity Technologies)\n• AppLovin MAX (AppLovin Corporation)\n\nRewarded video advertisements are integral to the in-app reward model and are the App's sole source of revenue. By using the App, you agree to receive ads from these networks. Attempting to circumvent, block, spoof, or manipulate the ad delivery system — including through VPNs, ad blockers, modified system settings, or tampered APKs — constitutes a material breach of these Terms and may result in immediate account suspension and forfeiture of all virtual balances.`,
  },
  {
    title: '10. Withdrawal Processing',
    body: `Withdrawal requests are subject to a manual review process. Standard processing time is 24 hours from request submission. We reserve the right to extend this period for additional verification. Withdrawals may be rejected or voided if:\n\n• The account is flagged for fraudulent activity, multi-accounting, or automation.\n• The withdrawal does not meet the minimum threshold for the applicable tier.\n• The provided wallet address or email is invalid.\n• The account is found to be operating from a restricted territory (Section 6).\n\nApproved withdrawal amounts reflect the net value after applicable network fees. Withdrawals are a discretionary reward disbursement, not a repayment of any deposit — the App holds no user funds because no deposits are ever accepted.`,
  },
  {
    title: '11. Prohibited Conduct',
    body: `You agree not to:\n\n• Use bots, scripts, macros, auto-clickers, accessibility-service automation, or any automated tools to manipulate session timers, gameplay, or scores.\n• Create or operate multiple accounts, or use another person's account.\n• Abuse the referral program through self-referral, fake accounts, or coordinated referral rings.\n• Exploit bugs, glitches, or unintended behaviour instead of reporting them.\n• Attempt to reverse-engineer, decompile, modify, or tamper with the App or its network traffic.\n• Use the App for any unlawful purpose.\n• Access the App through a VPN, proxy, Tor exit node, datacenter/hosting IP, or any network anonymisation service. The App enforces a zero-tolerance network policy: connections identified as VPN/proxy or originating from restricted regions or sanctioned territories are automatically denied access.\n\nViolations may result in immediate account termination and forfeiture of all virtual balances.`,
  },
  {
    title: '12. Enforcement — Suspension, Ban & Blacklist',
    body: `We operate a strict, multi-tier enforcement policy to protect honest users:\n\n• DETECTION — Automated systems continuously monitor gameplay integrity (input cadence, score progression, physics-consistent timing), network signals, and cross-account patterns. Suspicious activity is flagged in real time.\n• WARNING / RESTRICTION — Accounts flagged for a first offense may receive an in-app warning and temporary feature restrictions while under review.\n• SUSPENSION — Confirmed violations (automation, multi-accounting, referral abuse, score manipulation, ad fraud) result in account suspension and voiding of pending withdrawals.\n• PERMANENT BAN & BLACKLIST — Repeat or severe violations result in a permanent ban. The account's email address and associated identifiers are added to a permanent blacklist, preventing any future registration. Blacklisting is final and is not subject to appeal.\n\nWe reserve the right to withhold or reverse any virtual balance, ticket, or pending withdrawal that our systems determine was obtained through fraudulent or manipulated activity. All enforcement decisions are made at our sole discretion and are final.`,
  },
  {
    title: '13. Disclaimers',
    body: `The App is provided "as is" and "as available" without warranties of any kind, express or implied. We do not guarantee uninterrupted availability, error-free operation, specific earnings, or that virtual balances will always be convertible. Virtual reward availability depends on operational, legal, and financial factors outside our control.\n\nThe App is an entertainment product. Nothing in the App constitutes financial, investment, or legal advice, and participation should never be treated as a source of income.`,
  },
  {
    title: '14. Limitation of Liability',
    body: `To the maximum extent permitted by law, we shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of profits, data, goodwill, or virtual balances, arising from your use of — or inability to use — the App.\n\nBecause the App accepts no deposits and charges no fees, your sole and exclusive remedy for any dissatisfaction with the App is to stop using it and delete your account.`,
  },
  {
    title: '15. Account Deletion & OTP Verification',
    body: `For your security, permanently deleting your account requires email-based One-Time Password (OTP) verification. Upon submitting a deletion request:\n\n• A 6-digit OTP is sent to your registered email address.\n• The OTP is valid for 5 minutes and is single-use.\n• Successful verification results in the permanent, irreversible deletion of your account and all associated data, including your virtual balance and history.\n\nThis measure protects users against unauthorised account deletion.`,
  },
  {
    title: '16. Fraud Prevention & Account Blacklisting',
    body: `To protect the integrity of our platform and prevent abuse, we operate a permanent email blacklist for deleted and banned accounts.\n\nUpon account deletion or a fraud ban:\n\n• The registered email address is permanently recorded in a blacklist database before account data is erased.\n• The blacklisted email address cannot be used to register a new Shiba Hit account, ever.\n• This restriction cannot be reversed or appealed.\n\nThis policy exists to prevent fraudulent exploitation of welcome bonuses (100 SHIB + 500 PT), referral rewards, and withdrawal thresholds. By using this App, you explicitly consent to and acknowledge this policy.\n\nAttempting to circumvent this restriction — through email aliasing, new Firebase accounts, temporary email providers, or any other means — constitutes a material breach of these Terms and will result in permanent ban of all associated accounts.`,
  },
  {
    title: '17. Termination',
    body: `You may stop using the App and delete your account at any time. We may suspend or terminate your access at any time, with or without notice, for any violation of these Terms. Upon termination for breach, all virtual balances, tickets, and pending withdrawals are forfeited. Sections 6, 8, 12, 13, 14, and 16 survive termination.`,
  },
  {
    title: '18. Changes to Terms',
    body: `We reserve the right to modify these Terms at any time. Continued use of the App after changes are posted constitutes acceptance. We will notify users of material changes via in-app notification where practicable. If you do not accept a revision, you must stop using the App.`,
  },
  {
    title: '19. Contact',
    body: `For questions regarding these Terms, contact us at:\n\nsupport@shibahit.com`,
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
        <Text style={styles.lastUpdated}>Last Updated: July 18, 2026</Text>
        {SECTIONS.map((s) => (
          <View key={s.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{s.title}</Text>
            <Text style={styles.sectionBody}>{s.body}</Text>
          </View>
        ))}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Questions? Contact us at</Text>
          <Text style={styles.footerEmail}>support@shibahit.com</Text>
        </View>
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
  footer: { marginTop: 12, paddingTop: 20, borderTopWidth: 1, borderTopColor: Colors.darkBorder, alignItems: 'center', gap: 4 },
  footerText: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textMuted },
  footerEmail: { fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.neonOrange },
});
