import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as ScreenOrientation from "expo-screen-orientation";
import React, { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { WalletProvider } from "@/context/WalletContext";
import { MiningProvider } from "@/context/MiningContext";
import { AdminProvider } from "@/context/AdminContext";
import { AdProvider } from "@/context/AdContext";
import { NotificationsProvider } from "@/context/NotificationsContext";
import Colors from "@/constants/colors";
import { requestNotificationPermission } from "@/lib/notifications";
import { TermsGateModal } from "@/components/TermsGateModal";
import { SecurityProvider } from "@/context/SecurityContext";
import { SecurityModal } from "@/components/SecurityModal";
import { ForceUpdateModal } from "@/components/ForceUpdateModal";
import { AnnouncementModal, useAnnouncementGate } from "@/components/AnnouncementModal";
import { SupportWidget } from "@/components/SupportWidget";
import { TournamentProvider } from "@/context/TournamentContext";
import { TournamentBannerPopup } from "@/components/TournamentBannerPopup";
import { TournamentWinPopup } from "@/components/TournamentWinPopup";
import { DailyRewardWidget } from "@/components/DailyRewardWidget";
import { View, StyleSheet, Platform } from "react-native";
import SpinningCoin from "@/components/SpinningCoin";

SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  const { isLoading, user, firebaseUser } = useAuth();
  // Boot-time announcement audit (PocketBase fetch + AsyncStorage frequency check).
  const { resolved: announcementResolved, announcement } = useAnnouncementGate();
  const [announcementClosed, setAnnouncementClosed] = useState(false);

  // Request notification permission once when app loads
  useEffect(() => {
    requestNotificationPermission().catch(() => {});
  }, []);

  // Lock the whole app to portrait. Individual screens (e.g. the pool match) opt
  // into landscape and re-lock portrait on unmount. No-op on web (lockAsync throws).
  useEffect(() => {
    if (Platform.OS === "web") return;
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);

  // BOOT INTERCEPTION: hold the splash until BOTH auth AND the announcement audit
  // resolve, so the banner can never pop over a live screen due to a slow API.
  const booting = isLoading || !announcementResolved;

  // On app startup: once booting resolves, navigate to the right screen.
  // (Gated on `booting` so the navigator is mounted before we replace the route.)
  useEffect(() => {
    if (booting) return;
    if (!firebaseUser) {
      // No Firebase user → auth screen
      router.replace("/auth" as any);
    } else if (user?.is_verified) {
      // Logged in and verified → tabs
      router.replace("/(tabs)" as any);
    } else {
      // Logged in but not verified → OTP screen
      router.replace("/verify-email" as any);
    }
  }, [booting]);

  // Splash while loading auth state and/or resolving the announcement audit
  if (booting) {
    return (
      <View style={splashStyles.container}>
        <SpinningCoin size={140} spinning speed="normal" />
      </View>
    );
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="auth" />
        <Stack.Screen name="verify-email" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="admin" options={{ presentation: "modal" }} />
        <Stack.Screen name="vip" />
        <Stack.Screen name="notifications" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        <Stack.Screen name="privacy" options={{ headerShown: false }} />
        <Stack.Screen name="terms" options={{ headerShown: false }} />
        <Stack.Screen name="solo-play" />
        <Stack.Screen name="hub/index" />
        <Stack.Screen name="hub/arcade-lobby" />
        <Stack.Screen name="hub/arcade-match" options={{ gestureEnabled: false }} />
        <Stack.Screen name="redeem" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
      </Stack>
      <TermsGateModal />
      {/* Announcement banner — resolved at boot; mounted on top from the first frame */}
      {announcement && !announcementClosed && (
        <AnnouncementModal
          announcement={announcement}
          onClose={() => setAnnouncementClosed(true)}
        />
      )}
    </>
  );
}

function ProvidedApp() {
  return (
    <SecurityProvider>
      <AdProvider>
        <WalletProvider>
          <MiningProvider>
            <AdminProvider>
              <NotificationsProvider>
                <TournamentProvider>
                  <RootLayoutNav />
                  {/* SupportWidget — floating above all screens, only when authenticated */}
                  <SupportWidget />
                  {/* Daily Reward Widget — draggable floating gift button + auto-popup */}
                  <DailyRewardWidget />
                  {/* Tournament banner popup — shown once per week until registered or rejected */}
                  <TournamentBannerPopup />
                  {/* Winner celebration — shown once per finalized cycle to prize winners */}
                  <TournamentWinPopup />
                </TournamentProvider>
              </NotificationsProvider>
            </AdminProvider>
          </MiningProvider>
        </WalletProvider>
      </AdProvider>
      {/* SecurityModal renders on top of all navigation — blocks the entire UI when triggered */}
      <SecurityModal />
      {/* ForceUpdateModal — non-dismissible; shown when INSTALLED_APP_VERSION < app_config.min_required_version (PocketBase) */}
      <ForceUpdateModal />
    </SecurityProvider>
  );
}

const splashStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.darkBg,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <GestureHandlerRootView style={{ flex: 1, backgroundColor: Colors.darkBg }}>
          <KeyboardProvider>
            <AuthProvider>
              <ProvidedApp />
            </AuthProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
