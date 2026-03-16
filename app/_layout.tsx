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
import Colors from "@/constants/colors";
import { requestNotificationPermission } from "@/lib/notifications";

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

  // Blank while loading
  if (isLoading) return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="verify-email" />
      <Stack.Screen name="admin" options={{ presentation: "modal" }} />
      <Stack.Screen name="privacy" options={{ headerShown: false }} />
      <Stack.Screen name="terms" options={{ headerShown: false }} />
    </Stack>
  );
}

function ProvidedApp() {
  return (
    <AdProvider>
      <WalletProvider>
        <MiningProvider>
          <AdminProvider>
            <RootLayoutNav />
          </AdminProvider>
        </MiningProvider>
      </WalletProvider>
    </AdProvider>
  );
}

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
