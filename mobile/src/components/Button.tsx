import React from "react";
import { Pressable, Text, ActivityIndicator, StyleSheet, View, ViewStyle } from "react-native";
import { colors, radius, spacing, font } from "@/theme";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  title,
  onPress,
  variant = "primary",
  loading,
  disabled,
  small,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: ViewStyle;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        small && styles.small,
        variantStyles[variant],
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      <View style={styles.inner}>
        {loading && <ActivityIndicator size="small" color={variant === "primary" ? "#04210f" : colors.text} />}
        <Text style={[styles.text, small && styles.textSmall, variantText[variant]]}>{title}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.md, paddingVertical: spacing(3), paddingHorizontal: spacing(4), alignItems: "center" },
  small: { paddingVertical: spacing(2), paddingHorizontal: spacing(3) },
  inner: { flexDirection: "row", alignItems: "center", gap: spacing(2) },
  text: { fontSize: font.size.base, fontWeight: font.weight.semibold },
  textSmall: { fontSize: font.size.sm },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
});

const variantStyles: Record<Variant, ViewStyle> = {
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  ghost: { backgroundColor: "transparent" },
  danger: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.negative },
};

const variantText: Record<Variant, { color: string }> = {
  primary: { color: "#04210f" },
  secondary: { color: colors.text },
  ghost: { color: colors.accentSoft },
  danger: { color: colors.negative },
};
