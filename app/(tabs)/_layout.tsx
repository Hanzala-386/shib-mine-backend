import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs, Icon, Label } from "expo-router/unstable-native-tabs";
import { BlurView } from "expo-blur";
import { Platform, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import Colors from "@/constants/colors";
import { StickyBannerAd, BANNER_HEIGHT } from "@/components/StickyBannerAd";

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

  /*
   * Layout contract (Android & iOS native):
   *   ┌──────────────────────┐
   *   │  Screen content      │ ← fills remaining space
   *   ├──────────────────────┤
   *   │  Tab bar             │ ← position absolute, bottom: BANNER_HEIGHT, zIndex: 20
   *   ├──────────────────────┤
   *   │  Ad banner (50px)    │ ← position absolute, bottom: 0, zIndex: 5
   *   └──────────────────────┘
   *
   * The tab bar zIndex (20) is HIGHER than the banner zIndex (5), so if they
   * ever overlap the tab bar always wins — nav buttons remain fully tappable.
   * Web doesn't show a banner, so the tab bar sits at the normal bottom.
   */
  const tabBarBottom = isWeb ? undefined : BANNER_HEIGHT;

  return (
    <View style={styles.container}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: Colors.gold,
          tabBarInactiveTintColor: Colors.textMuted,
          tabBarStyle: {
            position: "absolute",
            backgroundColor: isIOS ? "transparent" : Colors.darkCard,
            borderTopWidth: isWeb ? 1 : 0,
            borderTopColor: Colors.darkBorder,
            elevation: 0,
            bottom: tabBarBottom,
            /* Critical: tab bar zIndex must be higher than the banner (zIndex 5) */
            zIndex: 20,
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

      {/* Sticky banner at zIndex 5 — below the tab bar (zIndex 20) */}
      {!isWeb && <StickyBannerAd />}
    </View>
  );
}

export default function TabLayout() {
  if (Platform.OS !== 'web') {
    try {
      if (isLiquidGlassAvailable()) {
        return <NativeTabLayout />;
      }
    } catch { /* glass effect not available */ }
  }
  return <ClassicTabLayout />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
