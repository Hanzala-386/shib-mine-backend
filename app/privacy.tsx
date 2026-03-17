import React from 'react';
import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable } from 'react-native';
import Colors from '@/constants/colors';

const SECTIONS = [
  {
    title: '1. Overview',
    body: `SHIB Mine ("the App") is a gamified engagement and rewards platform. It is NOT a cryptocurrency mining application. No device hardware (CPU, GPU, or any compute resource) is used for actual cryptocurrency mining or blockchain computation of any kind.\n\nVirtual rewards ("SHIB tokens") are awarded based purely on in-app engagement, rewarded advertisement interactions, and gamified activities. These virtual rewards have no inherent monetary value until explicitly converted through the App's approved withdrawal reward model.`,
  },
  {
    title: '2. Information We Collect',
    body: `We collect the following personal data when you register or use the App:\n\n• Email Address – used for account creation, identity verification, and transactional communications.\n• Display Name / Username – shown publicly on the leaderboard and within the App.\n• Referral Code – generated for each user to enable the referral rewards program.\n\nWe do NOT collect: financial information, government ID, biometric data, or device location.`,
  },
  {
    title: '3. How We Use Your Information',
    body: `Your data is used to:\n\n• Authenticate and maintain your account.\n• Calculate and distribute in-app virtual rewards.\n• Process withdrawal requests through our manual review process.\n• Display public leaderboard rankings (username and balance only).\n• Send transactional notifications (e.g., mining session complete).`,
  },
  {
    title: '4. Advertising & Third-Party SDKs',
    body: `We display advertisements through the following certified advertising partners:\n\n• Google AdMob — Governed by Google's Privacy Policy (policies.google.com/privacy). AdMob may collect device identifiers and usage data to serve relevant ads.\n\n• Unity Ads (Unity Technologies) — Governed by Unity's Privacy Policy (unity.com/legal/privacy-policy). Unity may collect device identifiers and gameplay data to serve ads.\n\n• AppLovin MAX (AppLovin Corporation) — Governed by AppLovin's Privacy Policy (applovin.com/privacy). AppLovin may collect device and behavioral data to deliver and optimize ad delivery.\n\nBy using this App, you consent to the display of advertisements from these networks. You may opt out of personalized advertising through your device's ad settings (Settings > Privacy > Advertising on iOS; Settings > Google > Ads on Android). You may also visit each partner's privacy portal to manage your preferences.`,
  },
  {
    title: '5. Data Storage & Security',
    body: `Account and balance data is stored securely on our backend servers. We use industry-standard encryption for data in transit (TLS/HTTPS). We do not sell, rent, or share your personal data with third parties for marketing purposes.`,
  },
  {
    title: '6. Children\'s Privacy',
    body: `This App is not directed to children under the age of 13. We do not knowingly collect personal data from children. If you are a parent or guardian and believe your child has provided us with personal information, please contact us to have it removed.`,
  },
  {
    title: '7. Push Notifications',
    body: `The App may send local push notifications to inform you when your mining session is complete. These notifications are triggered locally on your device and do not involve transmitting personal data to external servers. You can disable notifications at any time through your device's notification settings.`,
  },
  {
    title: '8. Account Deletion & Identity Verification',
    body: `To protect your security, permanently deleting your SHIB Mine account requires email-based One-Time Password (OTP) verification. When you initiate an account deletion request:\n\n• A 6-digit OTP is generated and sent to your registered email address.\n• The OTP is valid for 5 minutes and can only be used once.\n• Upon successful verification, all account data — including your virtual balance, mining history, and referral records — is permanently and irreversibly deleted from our systems.\n\nThis verification step ensures that only the legitimate account owner can delete an account, protecting you against unauthorised deletion.`,
  },
  {
    title: '9. Changes to This Policy',
    body: `We may update this Privacy Policy periodically. Continued use of the App after any changes constitutes your acceptance of the revised policy. The "Last Updated" date at the top of this page will reflect the most recent revision.`,
  },
  {
    title: '10. Contact Us',
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
        <Text style={styles.lastUpdated}>Last Updated: March 15, 2026</Text>
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
