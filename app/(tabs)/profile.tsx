import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Alert, Switch, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useAuth } from '@/context/AuthContext';
import { useWallet } from '@/context/WalletContext';
import Colors from '@/constants/colors';

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatShib(val: number) {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(0)}K`;
  return val.toLocaleString();
}

interface MenuItemProps {
  icon: string;
  iconLib?: 'ionicons' | 'material-community';
  label: string;
  value?: string;
  danger?: boolean;
  onPress?: () => void;
  rightEl?: React.ReactNode;
}

function MenuItem({ icon, iconLib = 'ionicons', label, value, danger, onPress, rightEl }: MenuItemProps) {
  const IconComp = iconLib === 'material-community' ? MaterialCommunityIcons : Ionicons;
  return (
    <Pressable
      style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.7 : 1 }]}
      onPress={onPress}
    >
      <View style={[styles.menuIconWrap, { backgroundColor: (danger ? '#FF3D57' : Colors.neonOrange) + '20' }]}>
        <IconComp name={icon as any} size={18} color={danger ? Colors.error : Colors.neonOrange} />
      </View>
      <Text style={[styles.menuLabel, danger && { color: Colors.error }]}>{label}</Text>
      <View style={styles.menuRight}>
        {value && <Text style={styles.menuValue}>{value}</Text>}
        {rightEl}
        {!rightEl && <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />}
      </View>
    </Pressable>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const { shibBalance, powerTokens, transactions } = useWallet();
  const [hapticsEnabled, setHapticsEnabled] = useState(true);

  const miningCount = transactions.filter(t => t.type === 'mining_claim').length;
  const gameWins = transactions.filter(t => t.type === 'game_reward').length;

  async function handleSignOut() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out', style: 'destructive',
        onPress: async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          await signOut();
        }
      }
    ]);
  }

  const initials = user?.displayName?.slice(0, 2).toUpperCase() ?? 'MM';

  return (
    <View style={[styles.container, { backgroundColor: Colors.darkBg }]}>
      <LinearGradient
        colors={['rgba(244,196,48,0.12)', 'rgba(255,107,0,0.08)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16), paddingBottom: 120 }]}
      >
        <Animated.View entering={FadeInDown.delay(100).springify()} style={styles.profileCard}>
          <LinearGradient colors={[Colors.gold, Colors.neonOrange]} style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </LinearGradient>
          <Text style={styles.displayName}>{user?.displayName}</Text>
          <Text style={styles.email}>{user?.email}</Text>
          {user?.createdAt && (
            <Text style={styles.joinDate}>Member since {formatDate(user.createdAt)}</Text>
          )}
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(200).springify()} style={styles.statsGrid}>
          <View style={styles.statCell}>
            <MaterialCommunityIcons name="pickaxe" size={20} color={Colors.gold} />
            <Text style={styles.statNum}>{miningCount}</Text>
            <Text style={styles.statLbl}>Mine Sessions</Text>
          </View>
          <View style={[styles.statCell, styles.statCellBorder]}>
            <MaterialCommunityIcons name="knife" size={20} color={Colors.neonOrange} />
            <Text style={styles.statNum}>{gameWins}</Text>
            <Text style={styles.statLbl}>Game Wins</Text>
          </View>
          <View style={styles.statCell}>
            <MaterialCommunityIcons name="bitcoin" size={20} color={Colors.gold} />
            <Text style={styles.statNum}>{formatShib(shibBalance)}</Text>
            <Text style={styles.statLbl}>SHIB Earned</Text>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(300).springify()}>
          <Text style={styles.sectionTitle}>Account</Text>
          <View style={styles.menuGroup}>
            <MenuItem
              icon="mail-outline"
              label="Email"
              value={user?.email ?? ''}
            />
            <MenuItem
              icon="gift-outline"
              label="Referral Code"
              value={user?.referralCode ?? ''}
            />
            <MenuItem
              icon="lightning-bolt"
              iconLib="material-community"
              label="Power Tokens"
              value={`${powerTokens} PT`}
            />
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(400).springify()}>
          <Text style={styles.sectionTitle}>Preferences</Text>
          <View style={styles.menuGroup}>
            <MenuItem
              icon="phone-portrait-outline"
              label="Haptic Feedback"
              rightEl={
                <Switch
                  value={hapticsEnabled}
                  onValueChange={(v) => setHapticsEnabled(v)}
                  trackColor={{ false: Colors.darkSurface, true: Colors.gold + '60' }}
                  thumbColor={hapticsEnabled ? Colors.gold : Colors.textMuted}
                />
              }
            />
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(500).springify()}>
          <Text style={styles.sectionTitle}>App Info</Text>
          <View style={styles.menuGroup}>
            <MenuItem icon="information-circle-outline" label="Version" value="1.0.0" />
            <MenuItem icon="shield-checkmark-outline" label="Privacy Policy" onPress={() => {}} />
            <MenuItem icon="document-text-outline" label="Terms of Service" onPress={() => {}} />
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(600).springify()}>
          <View style={styles.menuGroup}>
            <MenuItem
              icon="log-out-outline"
              label="Sign Out"
              danger
              onPress={handleSignOut}
            />
          </View>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 20 },
  profileCard: {
    alignItems: 'center', gap: 8, marginBottom: 24,
    paddingBottom: 8,
  },
  avatar: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
  },
  avatarText: { fontFamily: 'Inter_700Bold', fontSize: 28, color: '#000' },
  displayName: { fontFamily: 'Inter_700Bold', fontSize: 22, color: Colors.textPrimary },
  email: { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary },
  joinDate: { fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textMuted },
  statsGrid: {
    flexDirection: 'row', backgroundColor: Colors.darkCard,
    borderRadius: 18, padding: 20, marginBottom: 28,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  statCell: { flex: 1, alignItems: 'center', gap: 6 },
  statCellBorder: {
    borderLeftWidth: 1, borderRightWidth: 1, borderColor: Colors.darkBorder,
  },
  statNum: { fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.textPrimary },
  statLbl: { fontFamily: 'Inter_400Regular', fontSize: 10, color: Colors.textMuted, textAlign: 'center' },
  sectionTitle: {
    fontFamily: 'Inter_600SemiBold', fontSize: 12, color: Colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 4,
  },
  menuGroup: {
    backgroundColor: Colors.darkCard, borderRadius: 18,
    overflow: 'hidden', marginBottom: 20,
    borderWidth: 1, borderColor: Colors.darkBorder,
  },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: Colors.darkBorder,
  },
  menuIconWrap: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  menuLabel: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 15, color: Colors.textPrimary },
  menuRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  menuValue: { fontFamily: 'Inter_400Regular', fontSize: 13, color: Colors.textSecondary },
});
