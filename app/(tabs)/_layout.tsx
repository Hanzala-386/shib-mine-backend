import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs, Icon, Label } from "expo-router/unstable-native-tabs";
import { BlurView } from "expo-blur";
import { Platform, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import Colors from "@/constants/colors";
import { StickyBannerAd } from "@/components/StickyBannerAd";

/* ─── NativeTabs layout (iOS 26+ liquid glass) ──────────────────────────────── */
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

/* ─── Classic tab layout (Android + older iOS + web) ────────────────────────── */
function ClassicTabLayout() {
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const isAndroid = Platform.OS === "android";

  return (
    <View style={styles.container}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: Colors.gold,
          tabBarInactiveTintColor: Colors.textMuted,
          tabBarStyle: {
            /*
             * Android: NOT absolute — stays in the flex column so the banner
             * can sit below it without any overlap.
             * iOS: absolute with BlurView for the glass effect.
             * Web: relative (same as Android).
             */
            ...(isAndroid ? {
              backgroundColor: Colors.darkCard,
              borderTopWidth: 0,
              elevation: 0,
            } : isIOS ? {
              position: 'absolute',
              backgroundColor: 'transparent',
              borderTopWidth: 0,
              elevation: 0,
            } : {
              height: 84,
              borderTopWidth: 1,
              borderTopColor: Colors.darkBorder,
              backgroundColor: Colors.darkCard,
            }),
          },
          tabBarBackground: () =>
            isIOS ? (
              <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
            ) : isWeb ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.darkCard }]} />
            ) : null,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Home",
            tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="games"
          options={{
            title: "Games",
            tabBarIcon: ({ color, size }) => <Ionicons name="game-controller" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="leaderboard"
          options={{
            title: "Top Players",
            tabBarIcon: ({ color, size }) => <Ionicons name="trophy" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="invite"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="wallet"
          options={{
            title: "Wallet",
            tabBarIcon: ({ color, size }) => <Ionicons name="wallet" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "Profile",
            tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" size={size} color={color} />,
          }}
        />
      </Tabs>

      {/*
       * Banner sits BELOW the tab bar in normal flex flow.
       * On Android the tab bar is not absolute, so this naturally stacks under it.
       * On iOS the NativeTabs layout is used instead (no banner overlap possible).
       * On web StickyBannerAd returns null.
       */}
      {isAndroid && <StickyBannerAd />}
    </View>
  );
}

export default function TabLayout() {
  // NativeTabs is iOS-only — never attempt on web or it throws a ".Provider" crash
  if (Platform.OS !== 'web') {
    try {
      if (isLiquidGlassAvailable()) {
        return <NativeTabLayout />;
      }
    } catch { /* glass effect not available in this env */ }
  }
  return <ClassicTabLayout />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
