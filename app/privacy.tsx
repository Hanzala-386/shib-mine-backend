import React from 'react';
import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable } from 'react-native';
import Colors from '@/constants/colors';

const SECTIONS = [
  {
    title: '1. Overview & Scope',
    body: `Shiba Hit ("the App", "we", "us", "our") is a free, gamified engagement and rewards platform. This Privacy Policy explains what information we collect, how we use it, and the choices available to you. It applies to every version of the App and to all related services we operate.\n\nImportant clarifications about the nature of the App:\n\n• The App is NOT a cryptocurrency mining application. No device hardware (CPU, GPU, or any compute resource) is ever used for actual cryptocurrency mining or blockchain computation of any kind.\n• The App is NOT a gambling, betting, wagering, casino, or lottery product. No feature of the App involves staking or risking real money, and no outcome is determined by chance in exchange for real-money consideration.\n• The App does NOT accept deposits. We never request, collect, or process payments, card details, bank details, or cryptocurrency deposits from users. Every interaction within the App is completely free of charge.\n\nVirtual rewards ("SHIB tokens", "Power Tokens", "Hit Tickets") are awarded based purely on in-app engagement, rewarded advertisement interactions, and skill-based gamified activities. These virtual rewards have no inherent monetary value until explicitly converted through the App's approved withdrawal reward model.`,
  },
  {
    title: '2. No Deposits, No Purchases, No Financial Data',
    body: `Because the App is entirely free to use:\n\n• We do not collect or store payment card numbers, bank account details, or billing addresses.\n• We do not operate in-app purchases, paid subscriptions, or any storefront that accepts real money.\n• We will NEVER email you or message you asking for a deposit, a payment, or a "fee" to unlock a withdrawal. Any such request is fraudulent and should be reported to us immediately.\n\nThe only financial-adjacent information we hold is the destination you voluntarily provide for an approved reward withdrawal (a BEP-20 wallet address or a Binance account email), which is used solely to deliver that withdrawal.`,
  },
  {
    title: '3. Information We Collect',
    body: `We collect the following personal data when you register or use the App:\n\n• Email Address – used for account creation, identity verification, and transactional communications.\n• Display Name / Username – shown publicly on the leaderboard and within the App.\n• Referral Code – generated for each user to enable the referral rewards program.\n• In-App Activity Data – session counts, game scores, match results, referral counts, and virtual balances, used to operate the reward ledger and detect abuse.\n• IP Address & Network Signals – analysed at sign-in and during use to detect VPNs, proxies, datacenter connections, multi-accounting, and access from restricted regions (see Section 9).\n• Device Integrity Signals (Android) – limited, non-identifying checks for known automation and auto-clicker tools, used exclusively for fraud prevention. We do not scan, read, or upload your files, photos, messages, or app list beyond these declared integrity checks.\n\nWe do NOT collect: financial information, government-issued ID documents, biometric data, precise device location, contacts, or message content.`,
  },
  {
    title: '4. How We Use Your Information',
    body: `Your data is used to:\n\n• Authenticate and maintain your account.\n• Calculate and distribute in-app virtual rewards.\n• Process withdrawal requests through our manual review process.\n• Display public leaderboard rankings (username and balance only).\n• Send transactional notifications (e.g., mining session complete, withdrawal status).\n• Detect, investigate, and prevent fraud, multi-accounting, automation, and other violations of our Terms of Service.\n• Comply with applicable legal, regulatory, and sanctions obligations.\n\nWe process your data on the legal bases of contract performance (operating your account), legitimate interest (platform integrity and fraud prevention), and legal obligation (sanctions and compliance screening).`,
  },
  {
    title: '5. Advertising & Third-Party SDKs',
    body: `We display advertisements through the following certified advertising partners:\n\n• Google AdMob — Governed by Google's Privacy Policy (policies.google.com/privacy). AdMob may collect device identifiers and usage data to serve relevant ads.\n\n• Unity Ads (Unity Technologies) — Governed by Unity's Privacy Policy (unity.com/legal/privacy-policy). Unity may collect device identifiers and gameplay data to serve ads.\n\n• AppLovin MAX (AppLovin Corporation) — Governed by AppLovin's Privacy Policy (applovin.com/privacy). AppLovin may collect device and behavioral data to deliver and optimize ad delivery.\n\nAdvertising is the sole revenue model of the App — it is what allows every feature to remain free. By using this App, you consent to the display of advertisements from these networks. You may opt out of personalized advertising through your device's ad settings (Settings > Privacy > Advertising on iOS; Settings > Google > Ads on Android). You may also visit each partner's privacy portal to manage your preferences.`,
  },
  {
    title: '6. Data Storage & Security',
    body: `Account and balance data is stored securely on our backend servers. We use industry-standard encryption for data in transit (TLS/HTTPS), scoped access rules so that users can only read their own records, and server-side validation of every balance-affecting operation.\n\nWe do not sell, rent, or share your personal data with third parties for marketing purposes. Data is disclosed only to the advertising partners listed in Section 5 (under their own policies), to service providers strictly necessary to operate the App (e.g., email delivery), or where required by law.`,
  },
  {
    title: '7. Data Retention',
    body: `We retain your account data for as long as your account remains active. Activity records (game history, session logs, withdrawal records) are retained while the account exists to operate the reward ledger and to satisfy our fraud-prevention obligations.\n\nWhen your account is deleted, all personal data is permanently erased, with the sole exception of the blacklist entry described in Section 13 and minimal fraud-investigation records we are required to keep to protect the platform and comply with law.`,
  },
  {
    title: '8. Fraud Detection & Multi-Account Screening',
    body: `Maintaining a fair reward economy requires active anti-fraud screening. For this purpose we automatically analyse:\n\n• Network signals (IP reputation, VPN/proxy/datacenter detection).\n• Behavioural signals (input cadence, score progression, session patterns) to detect bots, scripts, auto-clickers, and automation tools.\n• Cross-account signals (shared referral chains, matching network fingerprints) to detect multi-accounting and referral abuse.\n\nAccounts flagged by these systems may be restricted, suspended, or permanently blacklisted, and pending withdrawals may be voided, as described in our Terms of Service. This processing is a legitimate interest essential to operating the platform and cannot be opted out of while using the App.`,
  },
  {
    title: '9. Geographic Restrictions & Sanctions Compliance',
    body: `The App is NOT available to users located in, or accessing the service from, the following restricted territories:\n\n• Islamic Republic of Iran\n• Ukraine\n• Islamic Republic of Afghanistan\n• Democratic People's Republic of Korea (North Korea)\n\nWe screen network connections at sign-in and during use to enforce these restrictions. Connections identified as originating from a restricted territory — or attempting to disguise their origin through VPNs, proxies, or other anonymisation services — are automatically denied access, and any associated account may be permanently suspended with all virtual balances forfeited.\n\nThis screening is performed to comply with applicable sanctions and export-control obligations and to protect the integrity of the platform.`,
  },
  {
    title: '10. Children\'s Privacy',
    body: `This App is not directed to children under the age of 13. We do not knowingly collect personal data from children. If you are a parent or guardian and believe your child has provided us with personal information, please contact us to have it removed. Accounts identified as belonging to users under the minimum age will be terminated.`,
  },
  {
    title: '11. Push Notifications',
    body: `The App may send local push notifications to inform you when your mining session is complete or when a withdrawal changes status. These notifications are triggered locally on your device and do not involve transmitting personal data to external servers. You can disable notifications at any time through your device's notification settings.`,
  },
  {
    title: '12. Account Deletion & Identity Verification',
    body: `To protect your security, permanently deleting your Shiba Hit account requires email-based One-Time Password (OTP) verification. When you initiate an account deletion request:\n\n• A 6-digit OTP is generated and sent to your registered email address.\n• The OTP is valid for 5 minutes and can only be used once.\n• Upon successful verification, all account data — including your virtual balance, mining history, and referral records — is permanently and irreversibly deleted from our systems.\n\nThis verification step ensures that only the legitimate account owner can delete an account, protecting you against unauthorised deletion.`,
  },
  {
    title: '13. Fraud Prevention & Account Blacklisting',
    body: `To protect the integrity of the platform and comply with anti-fraud obligations, we maintain a permanent blacklist of email addresses associated with deleted or banned accounts.\n\nWhen your Shiba Hit account is permanently deleted or banned for fraud:\n\n• The registered email address is saved to a secure blacklist database before account data is erased.\n• A blacklisted email cannot be used to create a new Shiba Hit account at any time in the future.\n• This restriction is permanent and cannot be reversed.\n\nThis measure exists to prevent fraudulent abuse of new-user welcome bonuses, referral rewards, and withdrawal thresholds. By using the App, you acknowledge and consent to this policy.\n\nAny attempt to circumvent this restriction — including through email aliasing, temporary email addresses, or using another person's email address — constitutes a material breach of our Terms of Service and may be reported to the relevant authorities.`,
  },
  {
    title: '14. Your Rights',
    body: `Depending on your jurisdiction, you may have the right to access, correct, export, or delete the personal data we hold about you. You can exercise these rights directly in the App (profile editing, account deletion) or by contacting us at the address below. We respond to verified requests within 30 days.\n\nNote that data essential to fraud prevention (Section 8) and sanctions compliance (Section 9), and blacklist entries (Section 13), may be retained where we have an overriding legitimate interest or legal obligation to do so.`,
  },
  {
    title: '15. Changes to This Policy',
    body: `We may update this Privacy Policy periodically. Continued use of the App after any changes constitutes your acceptance of the revised policy. The "Last Updated" date at the top of this page will reflect the most recent revision. Material changes will be announced in-app where practicable.`,
  },
  {
    title: '16. Contact Us',
    body: `For questions or concerns about this Privacy Policy or your personal data, please contact:\n\nsupport@shibahit.com`,
  },
];

export default function PrivacyScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container]}>
      <View style={[styles.header, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 12) }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Privacy Policy</Text>
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
