// Dark theme tokens mirroring the desktop app (Tailwind neutral + emerald accent on a
// near-black background). Centralized so every screen stays visually consistent.

export const colors = {
  bg: "#0a0a0a", // neutral-950
  surface: "#171717", // neutral-900
  surfaceAlt: "#1f1f1f",
  border: "#262626", // neutral-800
  borderSubtle: "#1c1c1c",

  text: "#f5f5f5", // neutral-100
  textMuted: "#a3a3a3", // neutral-400
  textFaint: "#737373", // neutral-500

  accent: "#10b981", // emerald-500
  accentSoft: "#34d399", // emerald-400
  accentDeep: "#047857", // emerald-700

  positive: "#34d399", // money in / under budget
  negative: "#f43f5e", // rose-500 — money out / over budget
  warn: "#f59e0b", // amber-500
  info: "#3b82f6", // blue-500

  // Category-bar gradient anchors (match desktop colorForRatio).
  deepGreen: [4, 120, 87] as const,
  green: [52, 211, 153] as const,
  neutral: [120, 113, 108] as const,
  red: [244, 63, 94] as const,
  deepRed: [136, 19, 55] as const,
};

export const spacing = (n: number) => n * 4;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
};

export const font = {
  size: {
    xs: 11,
    sm: 13,
    base: 15,
    lg: 18,
    xl: 22,
    xxl: 28,
    huge: 34,
  },
  weight: {
    regular: "400" as const,
    medium: "500" as const,
    semibold: "600" as const,
    bold: "700" as const,
  },
};

// Interpolate a category bar colour from current/median ratio. Mirrors the desktop
// dashboard's colorForRatio: below-median = green, at = neutral, above = rose.
export function colorForRatio(current: number, median: number): string {
  if (median <= 0 || current <= 0) return colors.info;
  const ratio = current / median;
  const lerp = (a: readonly number[], b: readonly number[], t: number) =>
    `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(", ")})`;
  if (ratio < 0.5) return lerp(colors.deepGreen, colors.green, ratio / 0.5);
  if (ratio < 1.0) return lerp(colors.green, colors.neutral, (ratio - 0.5) / 0.5);
  if (ratio < 2.0) return lerp(colors.neutral, colors.red, (ratio - 1.0) / 1.0);
  return lerp(colors.red, colors.deepRed, Math.min(1, (ratio - 2.0) / 1.0));
}
