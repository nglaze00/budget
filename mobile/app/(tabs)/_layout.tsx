import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/theme";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "700" },
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accentSoft,
        tabBarInactiveTintColor: colors.textFaint,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Dashboard", tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="review"
        options={{ title: "Review", tabBarIcon: ({ color, size }) => <Ionicons name="checkmark-done" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="transactions"
        options={{ title: "Transactions", tabBarIcon: ({ color, size }) => <Ionicons name="list" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="planning"
        options={{ title: "Planning", tabBarIcon: ({ color, size }) => <Ionicons name="trending-up" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="sync"
        options={{ title: "Sync", tabBarIcon: ({ color, size }) => <Ionicons name="sync" color={color} size={size} /> }}
      />
    </Tabs>
  );
}
