import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
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
import Colors from "@/constants/colors";

SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  const { user, firebaseUser, isLoading } = useAuth();
  if (isLoading) return null;

  const isVerified = user && firebaseUser?.emailVerified;
  const hasPendingVerification = firebaseUser && !firebaseUser.emailVerified;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      {isVerified ? (
        <>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="admin" options={{ presentation: 'modal' }} />
        </>
      ) : hasPendingVerification ? (
        <Stack.Screen name="verify-email" />
      ) : (
        <Stack.Screen name="auth" />
      )}
    </Stack>
  );
}

function ProvidedApp() {
  return (
    <WalletProvider>
      <MiningProvider>
        <AdminProvider>
          <RootLayoutNav />
        </AdminProvider>
      </MiningProvider>
    </WalletProvider>
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
