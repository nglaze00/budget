import React from "react";
import { View, Text, StyleSheet, ViewStyle } from "react-native";
import { colors, radius, spacing, font } from "@/theme";

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function CardTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.titleRow}>
      <Text style={styles.title}>{children}</Text>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing(4),
    gap: spacing(3),
  },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: font.weight.semibold, textTransform: "uppercase", letterSpacing: 0.5 },
});
