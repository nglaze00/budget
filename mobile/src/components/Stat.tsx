import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, font } from "@/theme";

// A compact labelled metric (used in the net-worth / overview grid).
export function Stat({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, { color: color ?? colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minWidth: 120, gap: 2 },
  label: { color: colors.textFaint, fontSize: font.size.xs, textTransform: "uppercase", letterSpacing: 0.5 },
  value: { fontSize: font.size.xl, fontWeight: font.weight.bold, fontVariant: ["tabular-nums"] },
  sub: { color: colors.textMuted, fontSize: font.size.xs },
});
