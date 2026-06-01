import React from "react";
import { Text, StyleSheet, TextStyle } from "react-native";
import { colors, font } from "@/theme";
import { money } from "@/lib/format";

// Coloured monetary value. Positive = green (money in), negative = rose (money out),
// unless `neutral` is set (e.g. for totals where sign isn't semantic).
export function Money({
  value,
  neutral,
  size = font.size.base,
  weight = font.weight.semibold,
  showSign,
  style,
}: {
  value: number | null | undefined;
  neutral?: boolean;
  size?: number;
  weight?: TextStyle["fontWeight"];
  showSign?: boolean;
  style?: TextStyle;
}) {
  const v = value ?? 0;
  const color = neutral ? colors.text : v < 0 ? colors.negative : colors.positive;
  return <Text style={[{ color, fontSize: size, fontWeight: weight }, styles.mono, style]}>{money(v, { sign: showSign })}</Text>;
}

const styles = StyleSheet.create({
  mono: { fontVariant: ["tabular-nums"] },
});
