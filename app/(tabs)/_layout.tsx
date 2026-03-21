import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs, Icon, Label } from "expo-router/unstable-native-tabs";
import { BlurView } from "expo-blur";
import { Platform, StyleSheet, View, Text, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import Colors from "@/constants/colors";
import { InlineBannerAd, BANNER_HEIGHT } from "@/components/StickyBannerAd";

/* ─── Route metadata ─────────────────────────────────────────────────────── */
type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

const TAB_META: Record<string, { label: string; icon: IoniconName; iconFocused: IoniconName }> = {
  index:       { label: "Home",        icon: "home-outline",           iconFocused: "home" },
  games:       { label: "Games",       icon: "game-controller-outline", iconFocused: "game-controller" },
  leaderboard: { label: "Top Players", icon: "trophy-outline",          iconFocused: "trophy" },
  wallet:      { label: "Wallet",      icon: "wallet-outline",          iconFocused: "wallet" },
  profile:     { label: "Profile",     icon: "person-circle-outline",   iconFocused: "person-circle" },
};

/* ─── Custom tab bar — banner lives ABOVE the tab buttons ────────────────── */
/*
 *  Layout (bottom → top):
 *    [System nav / safe area]
 *    [Tab buttons ~56px]
 *    [Banner ad   ~50px]   ← InlineBannerAd, in normal flex flow above buttons
 *    [Screen content]
 *
 *  React Navigation measures the rendered height of this tabBar component and
 *  automatically adds the correct paddingBottom to every screen so no content
 *  is hidden beneath it.
 */
function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === "web";

  const visibleRoutes = state.routes.filter((r) => TAB_META[r.name]);

  return (
    <View style={styles.tabBarContainer}>
      {/* Banner ad — renders ABOVE the tab buttons */}
      {!isWeb && <InlineBannerAd />}

      {/* Tab buttons row */}
      <View
        style={[
          styles.tabRow,
          {
            paddingBottom: insets.bottom,
            height: 56 + insets.bottom,
          },
        ]}
      >
        {visibleRoutes.map((route) => {
          const globalIndex = state.routes.indexOf(route);
          const isFocused = state.index === globalIndex;
          const meta = TAB_META[route.name];
          const color = isFocused ? Colors.gold : Colors.textMuted;

          const onPress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              style={styles.tabButton}
              android_ripple={{ color: Colors.darkBorder, borderless: true }}
            >
              <Ionicons
                name={isFocused ? meta.iconFocused : meta.icon}
                size={22}
                color={color}
              />
              <Text style={[styles.tabLabel, { color }]}>{meta.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* ─── Classic tab layout (Android + older iOS + web) ────────────────────── */
function ClassicTabLayout() {
  const isWeb = Platform.OS === "web";

  return (
    <View style={styles.container}>
      <Tabs
        screenOptions={{ headerShown: false }}
        tabBar={isWeb ? undefined : (props) => <CustomTabBar {...props} />}
      >
        <Tabs.Screen name="index"       options={{ title: "Home",        tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} /> }} />
        <Tabs.Screen name="games"       options={{ title: "Games",       tabBarIcon: ({ color, size }) => <Ionicons name="game-controller" size={size} color={color} /> }} />
        <Tabs.Screen name="leaderboard" options={{ title: "Top Players", tabBarIcon: ({ color, size }) => <Ionicons name="trophy" size={size} color={color} /> }} />
        <Tabs.Screen name="invite"      options={{ href: null }} />
        <Tabs.Screen name="wallet"      options={{ title: "Wallet",      tabBarIcon: ({ color, size }) => <Ionicons name="wallet" size={size} color={color} /> }} />
        <Tabs.Screen name="profile"     options={{ title: "Profile",     tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" size={size} color={color} /> }} />
      </Tabs>

      {/* Web: fallback banner (web uses default Tabs tab bar) */}
      {isWeb && (
        <View style={styles.webBanner}>
          <InlineBannerAd />
        </View>
      )}
    </View>
  );
}

/* ─── NativeTabs layout (iOS 26+ liquid glass) ──────────────────────────── */
function NativeTabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "house", selected: "house.fill" }} />
        <Label>Home</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="games">
        <Icon sf={{ default: "gamecontroller", selected: "gamecontroller.fill" }} />
        <Label>Games</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="leaderboard">
        <Icon sf={{ default: "trophy", selected: "trophy.fill" }} />
        <Label>Top Players</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="wallet">
        <Icon sf={{ default: "wallet.pass", selected: "wallet.pass.fill" }} />
        <Label>Wallet</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <Icon sf={{ default: "person.circle", selected: "person.circle.fill" }} />
        <Label>Profile</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

export default function TabLayout() {
  if (Platform.OS !== "web") {
    try {
      if (isLiquidGlassAvailable()) return <NativeTabLayout />;
    } catch { /* glass effect not available */ }
  }
  return <ClassicTabLayout />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  /* Custom tab bar — absolutely positioned at the bottom of the screen */
  tabBarContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    elevation: 20,
    backgroundColor: Colors.darkCard,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.darkBorder,
  },
  tabRow: {
    flexDirection: "row",
    backgroundColor: Colors.darkCard,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 6,
  },
  tabLabel: {
    fontSize: 10,
    marginTop: 2,
  },
  webBanner: {
    position: "absolute",
    bottom: 49,
    left: 0,
    right: 0,
    alignItems: "center",
  },
});
