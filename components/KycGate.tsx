/* KycGate — glassmorphism popup shown when a non-verified user tries to open a
 * gated feature (Wallet, Multiplayer Hub). Content adapts to the user's KYC
 * status: none → Verify Now CTA; under_review → wait message; rejected →
 * reason + Re-submit CTA. Admin accounts are never gated (checked by callers
 * via useKycGate). */

import React from 'react';
import { View, Text, StyleSheet, Modal, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Colors from '@/constants/colors';
import { useAuth } from '@/context/AuthContext';

export function useKycGate() {
  const { user, pbUser, isAdmin } = useAuth();
  const kycStatus = (pbUser?.kycStatus || user?.kycStatus || 'none') as
    'none' | 'under_review' | 'verified' | 'rejected';
  const rejectReason = pbUser?.kycRejectReason || user?.kycRejectReason || '';
  const isKycVerified = isAdmin || kycStatus === 'verified';
  return { kycStatus, rejectReason, isKycVerified };
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Feature name shown in the copy, e.g. "Wallet" or "Multiplayer Hub" */
  feature?: string;
}

export default function KycGateModal({ visible, onClose, feature = 'this feature' }: Props) {
  const { kycStatus, rejectReason } = useKycGate();

  const goVerify = () => {
    onClose();
    router.push('/verify-account' as any);
  };

  let icon: keyof typeof Ionicons.glyphMap = 'shield-outline';
  let title = 'Verification Required';
  let body = `Verify your account to access ${feature}.`;
  let cta: { label: string; onPress: () => void } | null = { label: 'Verify Now', onPress: goVerify };

  if (kycStatus === 'under_review') {
    icon = 'time-outline';
    title = 'Under Review';
    body = 'Your verification request is being reviewed. You will get access once it is approved.';
    cta = { label: 'View Status', onPress: goVerify };
  } else if (kycStatus === 'rejected') {
    icon = 'close-circle-outline';
    title = 'Verification Rejected';
    body = rejectReason
      ? `Reason: ${rejectReason}\n\nPlease fix the issue and submit again.`
      : 'Your verification was rejected. Please submit again.';
    cta = { label: 'Re-submit', onPress: goVerify };
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <LinearGradient
            colors={['rgba(244,196,48,0.16)', 'rgba(255,107,0,0.06)', 'transparent']}
            style={StyleSheet.absoluteFill}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            pointerEvents="none"
          />
          <View style={styles.iconWrap}>
            <Ionicons
              name={icon}
              size={38}
              color={kycStatus === 'rejected' ? Colors.error : Colors.gold}
            />
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.body}>{body}</Text>

          {cta && (
            <Pressable onPress={cta.onPress} testID="kyc-gate-cta" style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1, width: '100%' }]}>
              <LinearGradient
                colors={[Colors.gold, Colors.neonOrange]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.ctaBtn}
              >
                <Ionicons name="shield-checkmark" size={18} color="#1A1200" />
                <Text style={styles.ctaTxt}>{cta.label}</Text>
              </LinearGradient>
            </Pressable>
          )}

          <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn} testID="kyc-gate-close">
            <Text style={styles.closeTxt}>Not Now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 24,
    backgroundColor: Colors.darkCard,
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.35)',
    paddingVertical: 28,
    paddingHorizontal: 22,
    alignItems: 'center',
    overflow: 'hidden',
  },
  iconWrap: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: 'rgba(244,196,48,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.30)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    lineHeight: 21,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: 22,
  },
  ctaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 14,
  },
  ctaTxt: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1A1200',
  },
  closeBtn: {
    marginTop: 14,
    padding: 6,
  },
  closeTxt: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textMuted,
  },
});
