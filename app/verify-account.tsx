/* Verify Account — KYC submission form.
 * Flow: Full Name → Country (searchable dropdown, auto dial code) → Phone →
 * destination fields routed by Binance support (supported → Binance Email +
 * BEP20; unsupported → BEP20 only; Iran → blocked entirely).
 * Status views: under_review → pending screen; verified → success screen;
 * rejected → reason banner + form for re-submission.
 * Duplicate check is server-side → 409 {duplicate:true, fields:[...]} shows
 * "Field already in use" + Contact Support mailto. */

import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput, Modal, FlatList,
  ActivityIndicator, Platform, Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import Colors from '@/constants/colors';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import {
  KYC_COUNTRIES, findKycCountry, isBinanceSupported, isKycCountryBlocked,
  validateBep20Address, validateKycEmail, validateKycPhone,
  type KycCountry,
} from '@shared/kyc';

const SUPPORT_EMAIL = 'support@shibahit.com';

export default function VerifyAccountScreen() {
  const insets = useSafeAreaInsets();
  const { user, pbUser, refreshUser } = useAuth();
  const webTop = Platform.OS === 'web' ? 67 : 0;
  const webBottom = Platform.OS === 'web' ? 34 : 0;

  const kycStatus = pbUser?.kycStatus || user?.kycStatus || 'none';
  const rejectReason = pbUser?.kycRejectReason || user?.kycRejectReason || '';

  const [fullName, setFullName] = useState(pbUser?.kycFullName || '');
  const [country, setCountry] = useState<KycCountry | null>(
    pbUser?.kycCountry ? findKycCountry(pbUser.kycCountry) ?? null : null,
  );
  const [phone, setPhone] = useState(pbUser?.kycPhone || '');
  const [binanceEmail, setBinanceEmail] = useState(pbUser?.kycBinanceEmail || '');
  const [bep20, setBep20] = useState(pbUser?.kycBep20Address || '');

  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [dupFields, setDupFields] = useState<string[]>([]);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const binanceRoute = !!country && isBinanceSupported(country.name);
  const countryBlocked = !!country && isKycCountryBlocked(country.name);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return KYC_COUNTRIES;
    return KYC_COUNTRIES.filter((c) => c.name.toLowerCase().includes(q));
  }, [search]);

  /* ── Validation ── */
  const nameOk = fullName.trim().length >= 3;
  const phoneOk = validateKycPhone(phone);
  const bepOk = validateBep20Address(bep20);
  const emailOk = !binanceRoute || validateKycEmail(binanceEmail);
  const canSubmit =
    !!country && !countryBlocked && nameOk && phoneOk && bepOk && emailOk && !submitting;

  const fieldError = (field: string) => dupFields.includes(field);

  async function handleSubmit() {
    if (!canSubmit || !country || !pbUser?.pbId) return;
    setSubmitting(true);
    setError('');
    setDupFields([]);
    try {
      await api.submitVerification({
        pbId: pbUser.pbId,
        fullName: fullName.trim(),
        country: country.name,
        phone: phone.trim(),
        binanceEmail: binanceRoute ? binanceEmail.trim() : undefined,
        bep20Address: bep20.trim(),
      });
      await refreshUser().catch(() => {});
      setJustSubmitted(true);
    } catch (e: any) {
      if (e?.data?.duplicate) {
        setDupFields(Array.isArray(e.data.fields) ? e.data.fields : []);
        setError('Field already in use. If this is your data, contact support.');
      } else if (e?.data?.countryBlocked) {
        setError('Verification is not available in your country.');
      } else {
        setError(e?.message || 'Submission failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function contactSupport() {
    Linking.openURL(
      `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Verification — Field already in use')}&body=${encodeURIComponent(`My account email: ${user?.email || ''}\n\nI got "Field already in use" while verifying my account. Please help.`)}`,
    ).catch(() => {});
  }

  /* ── Status screens ── */
  if (kycStatus === 'verified') {
    return (
      <StatusShell insets={insets} webTop={webTop}>
        <View style={[styles.statusIcon, { borderColor: 'rgba(0,230,118,0.4)', backgroundColor: 'rgba(0,230,118,0.08)' }]}>
          <Ionicons name="shield-checkmark" size={44} color={Colors.success} />
        </View>
        <Text style={styles.statusTitle}>Account Verified</Text>
        <Text style={styles.statusBody}>
          Your account is verified. Withdrawals will be sent to your verified{' '}
          {pbUser?.kycCountry === 'India' && pbUser?.kycBinanceEmail
            ? 'Binance email or BEP-20 address'
            : 'BEP-20 address'}.
        </Text>
        <View style={styles.destCard}>
          {!!pbUser?.kycBinanceEmail && (
            <DestRow icon="mail" label="Binance Email" value={pbUser.kycBinanceEmail} />
          )}
          {!!pbUser?.kycBep20Address && (
            <DestRow icon="wallet" label="BEP-20 Address" value={pbUser.kycBep20Address} />
          )}
        </View>
        <PrimaryBtn label="Done" onPress={() => router.back()} />
      </StatusShell>
    );
  }

  if (kycStatus === 'under_review' || justSubmitted) {
    return (
      <StatusShell insets={insets} webTop={webTop}>
        <View style={styles.statusIcon}>
          <Ionicons name="time" size={44} color={Colors.gold} />
        </View>
        <Text style={styles.statusTitle}>Under Review</Text>
        <Text style={styles.statusBody}>
          Your verification request has been submitted and is being reviewed by our team.
          You will get full access once it is approved.
        </Text>
        <PrimaryBtn label="OK" onPress={() => router.back()} />
      </StatusShell>
    );
  }

  /* ── Form ── */
  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
        pointerEvents="none"
      />
      <KeyboardAwareScrollView
        bottomOffset={40}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: insets.top + webTop + 12,
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + webBottom + 40,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn} testID="verify-back">
            <Ionicons name="chevron-back" size={24} color={Colors.gold} />
          </Pressable>
          <Text style={styles.pageTitle}>Verify Account</Text>
          <View style={styles.backBtn} />
        </View>

        <Text style={styles.introTxt}>
          Complete verification to unlock the Wallet and Multiplayer Hub. Your withdrawal
          destination is locked to the details you verify here.
        </Text>

        {/* Rejected banner */}
        {kycStatus === 'rejected' && (
          <View style={styles.rejectBanner}>
            <Ionicons name="close-circle" size={20} color={Colors.error} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rejectTitle}>Previous request rejected</Text>
              <Text style={styles.rejectTxt}>{rejectReason || 'Please review your details and submit again.'}</Text>
            </View>
          </View>
        )}

        {/* Full name */}
        <Text style={styles.label}>Full Name</Text>
        <TextInput
          style={[styles.input, fieldError('fullName') && styles.inputDup]}
          value={fullName}
          onChangeText={setFullName}
          placeholder="Your legal full name"
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="words"
          testID="kyc-fullname"
        />

        {/* Country */}
        <Text style={styles.label}>Country</Text>
        <Pressable
          style={styles.input}
          onPress={() => { setSearch(''); setPickerOpen(true); }}
          testID="kyc-country"
        >
          <View style={styles.countryRow}>
            <Text style={[styles.countryTxt, !country && { color: Colors.textMuted }]} numberOfLines={1}>
              {country ? country.name : 'Select your country'}
            </Text>
            <Ionicons name="chevron-down" size={18} color={Colors.textMuted} />
          </View>
        </Pressable>

        {countryBlocked && (
          <View style={styles.blockedBanner}>
            <Ionicons name="ban" size={18} color={Colors.error} />
            <Text style={styles.blockedTxt}>
              Verification and withdrawals are not available in {country?.name}.
            </Text>
          </View>
        )}

        {!countryBlocked && (
          <>
            {/* Phone with auto dial code */}
            <Text style={styles.label}>Phone Number</Text>
            <View style={[styles.phoneRow, fieldError('phone') && styles.inputDup]}>
              <View style={styles.dialBox}>
                <Text style={styles.dialTxt}>{country?.dial || '+—'}</Text>
              </View>
              <TextInput
                style={styles.phoneInput}
                value={phone}
                onChangeText={(t) => setPhone(t.replace(/[^0-9]/g, ''))}
                placeholder="Phone number"
                placeholderTextColor={Colors.textMuted}
                keyboardType="number-pad"
                maxLength={15}
                testID="kyc-phone"
              />
            </View>
            {phone.length > 0 && !phoneOk && (
              <Text style={styles.fieldErr}>Enter 5–15 digits (numbers only)</Text>
            )}

            {/* Destination fields — routed by Binance support */}
            {country && binanceRoute && (
              <>
                <Text style={styles.label}>Binance Email</Text>
                <TextInput
                  style={[styles.input, fieldError('binanceEmail') && styles.inputDup]}
                  value={binanceEmail}
                  onChangeText={setBinanceEmail}
                  placeholder="Email linked to your Binance account"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  testID="kyc-binance-email"
                />
                {binanceEmail.length > 0 && !validateKycEmail(binanceEmail) && (
                  <Text style={styles.fieldErr}>Invalid email format</Text>
                )}
              </>
            )}

            {country && (
              <>
                <Text style={styles.label}>BEP-20 Wallet Address</Text>
                <TextInput
                  style={[styles.input, fieldError('bep20Address') && styles.inputDup]}
                  value={bep20}
                  onChangeText={setBep20}
                  placeholder="0x..."
                  placeholderTextColor={Colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="kyc-bep20"
                />
                {bep20.length > 0 && !bepOk && (
                  <Text style={styles.fieldErr}>Invalid BEP-20 address (0x + 40 hex characters)</Text>
                )}
                {!binanceRoute && (
                  <Text style={styles.hintTxt}>
                    Binance email withdrawals are not supported in {country.name}. Your
                    withdrawals will be sent to this BEP-20 address.
                  </Text>
                )}
              </>
            )}
          </>
        )}

        {/* Error + contact support */}
        {!!error && (
          <View style={styles.errBox}>
            <Text style={styles.errTxt}>{error}</Text>
            {dupFields.length > 0 && (
              <Pressable onPress={contactSupport} testID="kyc-contact-support">
                <Text style={styles.supportLink}>Contact Support</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Submit */}
        {!countryBlocked && (
          <Pressable
            onPress={handleSubmit}
            disabled={!canSubmit}
            testID="kyc-submit"
            style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1, marginTop: 22 }]}
          >
            <LinearGradient
              colors={canSubmit ? [Colors.gold, Colors.neonOrange] : [Colors.darkSurface, Colors.darkSurface]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.submitBtn}
            >
              {submitting ? (
                <ActivityIndicator color="#1A1200" />
              ) : (
                <>
                  <Ionicons name="shield-checkmark" size={19} color={canSubmit ? '#1A1200' : Colors.textMuted} />
                  <Text style={[styles.submitTxt, !canSubmit && { color: Colors.textMuted }]}>
                    Submit for Verification
                  </Text>
                </>
              )}
            </LinearGradient>
          </Pressable>
        )}
      </KeyboardAwareScrollView>

      {/* Country picker modal */}
      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.pickerBackdrop}>
          <View style={[styles.pickerSheet, { paddingBottom: insets.bottom + webBottom + 12 }]}>
            <View style={styles.pickerHead}>
              <Text style={styles.pickerTitle}>Select Country</Text>
              <Pressable onPress={() => setPickerOpen(false)} hitSlop={10} testID="kyc-picker-close">
                <Ionicons name="close" size={24} color={Colors.textSecondary} />
              </Pressable>
            </View>
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Search country..."
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
              testID="kyc-country-search"
            />
            <FlatList
              data={filtered}
              keyExtractor={(c) => c.name}
              keyboardShouldPersistTaps="handled"
              scrollEnabled={filtered.length > 0}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.countryItem}
                  onPress={() => {
                    setCountry(item);
                    setPickerOpen(false);
                  }}
                  testID={`kyc-country-${item.name}`}
                >
                  <Text style={styles.countryItemName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.countryItemDial}>{item.dial}</Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* ── Small shared pieces ── */

function StatusShell({ children, insets, webTop }: { children: React.ReactNode; insets: { top: number; bottom: number }; webTop: number }) {
  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
        pointerEvents="none"
      />
      <View style={[styles.statusWrap, { paddingTop: insets.top + webTop + 24, paddingBottom: insets.bottom + 24 }]}>
        {children}
      </View>
    </View>
  );
}

function DestRow({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={styles.destRow}>
      <Ionicons name={icon} size={16} color={Colors.gold} />
      <View style={{ flex: 1 }}>
        <Text style={styles.destLabel}>{label}</Text>
        <Text style={styles.destValue} numberOfLines={1}>{value}</Text>
      </View>
    </View>
  );
}

function PrimaryBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1, width: '100%', marginTop: 26 }]} testID="kyc-status-btn">
      <LinearGradient
        colors={[Colors.gold, Colors.neonOrange]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.submitBtn}
      >
        <Text style={styles.submitTxt}>{label}</Text>
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.darkBg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  backBtn: { width: 40, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
  pageTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary },
  introTxt: { fontSize: 13, lineHeight: 19, color: Colors.textSecondary, marginBottom: 18 },
  rejectBanner: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: 'rgba(255,61,87,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,61,87,0.35)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 16,
    alignItems: 'flex-start',
  },
  rejectTitle: { fontSize: 13, fontWeight: '800', color: Colors.error, marginBottom: 2 },
  rejectTxt: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  label: { fontSize: 13, fontWeight: '700', color: Colors.gold, marginBottom: 6, marginTop: 14 },
  input: {
    backgroundColor: Colors.darkCard,
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: Colors.textPrimary,
  },
  inputDup: { borderColor: Colors.error },
  countryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  countryTxt: { fontSize: 15, color: Colors.textPrimary, flex: 1, marginRight: 8 },
  blockedBanner: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    backgroundColor: 'rgba(255,61,87,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,61,87,0.35)',
    borderRadius: 12,
    padding: 12,
    marginTop: 14,
  },
  blockedTxt: { flex: 1, fontSize: 13, color: Colors.error, fontWeight: '600', lineHeight: 18 },
  phoneRow: {
    flexDirection: 'row',
    backgroundColor: Colors.darkCard,
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    borderRadius: 14,
    overflow: 'hidden',
  },
  dialBox: {
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: Colors.darkBorder,
    backgroundColor: 'rgba(244,196,48,0.06)',
  },
  dialTxt: { fontSize: 15, fontWeight: '700', color: Colors.gold },
  phoneInput: { flex: 1, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, color: Colors.textPrimary },
  fieldErr: { fontSize: 12, color: Colors.error, marginTop: 5 },
  hintTxt: { fontSize: 12, color: Colors.textMuted, marginTop: 7, lineHeight: 17 },
  errBox: {
    backgroundColor: 'rgba(255,61,87,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,61,87,0.35)',
    borderRadius: 12,
    padding: 12,
    marginTop: 18,
  },
  errTxt: { fontSize: 13, color: Colors.error, fontWeight: '600', lineHeight: 18 },
  supportLink: {
    fontSize: 13,
    fontWeight: '800',
    color: Colors.gold,
    marginTop: 8,
    textDecorationLine: 'underline',
  },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 15,
  },
  submitTxt: { fontSize: 16, fontWeight: '800', color: '#1A1200' },
  /* status screens */
  statusWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  statusIcon: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: 'rgba(244,196,48,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(244,196,48,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  statusTitle: { fontSize: 24, fontWeight: '800', color: Colors.textPrimary, marginBottom: 10, textAlign: 'center' },
  statusBody: { fontSize: 14, lineHeight: 21, color: Colors.textSecondary, textAlign: 'center' },
  destCard: {
    width: '100%',
    backgroundColor: Colors.darkCard,
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    borderRadius: 16,
    padding: 14,
    gap: 12,
    marginTop: 20,
  },
  destRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  destLabel: { fontSize: 11, color: Colors.textMuted, fontWeight: '700', textTransform: 'uppercase' },
  destValue: { fontSize: 13, color: Colors.textPrimary, fontWeight: '600', marginTop: 1 },
  /* country picker */
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: Colors.darkCard,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    maxHeight: '80%',
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  pickerHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  pickerTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  searchInput: {
    backgroundColor: Colors.darkSurface,
    borderWidth: 1,
    borderColor: Colors.darkBorder,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: Colors.textPrimary,
    marginBottom: 10,
  },
  countryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.darkBorder,
  },
  countryItemName: { flex: 1, fontSize: 15, color: Colors.textPrimary, marginRight: 12 },
  countryItemDial: { fontSize: 14, fontWeight: '700', color: Colors.gold },
});
