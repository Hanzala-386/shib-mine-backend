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
import React, { useEffect } from "react";
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
import { SupportWidget } from "@/components/SupportWidget";
import { TournamentProvider } from "@/context/TournamentContext";
import { TournamentBannerPopup } from "@/components/TournamentBannerPopup";
import { DailyRewardWidget } from "@/components/DailyRewardWidget";
import { View, StyleSheet } from "react-native";
import SpinningCoin from "@/components/SpinningCoin";

SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  const { isLoading, user, firebaseUser } = useAuth();

  // Request notification permission once when app loads
  useEffect(() => {
    requestNotificationPermission().catch(() => {});
  }, []);

  // On app startup: once isLoading resolves, navigate to the right screen
  useEffect(() => {
    if (isLoading) return;
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
  }, [isLoading]);

  // Splash while loading
  if (isLoading) {
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
      </Stack>
      <TermsGateModal />
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
                </TournamentProvider>
              </NotificationsProvider>
            </AdminProvider>
          </MiningProvider>
        </WalletProvider>
      </AdProvider>
      {/* SecurityModal renders on top of all navigation — blocks the entire UI when triggered */}
      <SecurityModal />
      {/* ForceUpdateModal — non-dismissible; shown when app version < minimum_version in settings */}
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
