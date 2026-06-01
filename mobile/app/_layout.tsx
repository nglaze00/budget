import React, { useEffect, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ensureSchema } from "@/db/migrate";
import { seedCategoriesIfEmpty } from "@/lib/seed";
import { preloadSettings } from "@/lib/settings";
import { colors, font, spacing } from "@/theme";

// App bootstrap: create the on-device schema, seed default categories, warm the settings
// cache — then render the navigator. Runs once at launch (cheap; no network).
function useInit() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        ensureSchema();
        await seedCategoriesIfEmpty();
        await preloadSettings();
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);
  return { ready, error };
}

export default function RootLayout() {
  const { ready, error } = useInit();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {error ? (
          <View style={styles.center}>
            <Text style={styles.errTitle}>Startup error</Text>
            <Text style={styles.errBody}>{error}</Text>
          </View>
        ) : !ready ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={styles.loading}>Preparing your budget…</Text>
          </View>
        ) : (
          <Stack screenOptions={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.bg } }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ title: "Settings", presentation: "modal" }} />
            <Stack.Screen name="chat" options={{ title: "Categorize Assistant", presentation: "modal" }} />
          </Stack>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", gap: spacing(3), padding: spacing(6) },
  loading: { color: colors.textMuted, fontSize: font.size.base },
  errTitle: { color: colors.negative, fontSize: font.size.lg, fontWeight: font.weight.bold },
  errBody: { color: colors.textMuted, fontSize: font.size.sm, textAlign: "center" },
});
