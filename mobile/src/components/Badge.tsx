import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, radius, spacing, font } from "@/theme";

export function Badge({ label, color = colors.textMuted, bg }: { label: string; color?: string; bg?: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg ?? "rgba(255,255,255,0.06)" }]}>
      <Text style={[styles.text, { color }]}>{label}</Text>
    </View>
  );
}

// Confidence → colour mapping mirroring the desktop review UI.
export function confidenceColor(c: string | null): string {
  switch (c) {
    case "unsure": return colors.negative;
    case "somewhat_sure": return colors.warn;
    case "mostly_sure": return colors.info;
    case "completely_sure": return colors.positive;
    default: return colors.textFaint;
  }
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: spacing(2), paddingVertical: 2, borderRadius: radius.pill, alignSelf: "flex-start" },
  text: { fontSize: font.size.xs, fontWeight: font.weight.semibold },
});
