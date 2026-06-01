import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Rect, Line, Polyline, Path, Circle } from "react-native-svg";
import { colors, radius, spacing, font } from "@/theme";
import { compactMoney } from "@/lib/format";

export interface BarDatum {
  label: string;
  value: number;
  highlight?: boolean;
  secondary?: number; // optional overlay (e.g. income vs spend)
}

// Lightweight SVG bar chart — no heavy chart lib, Expo Go compatible.
export function BarChart({ data, height = 140, valueFormatter = compactMoney }: { data: BarDatum[]; height?: number; valueFormatter?: (n: number) => string }) {
  if (data.length === 0) return <Text style={styles.empty}>No data</Text>;
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.secondary ?? 0)));
  const barW = 100 / data.length;
  const innerW = barW * 0.6;
  const pad = (barW - innerW) / 2;

  return (
    <View>
      <Svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 4);
          const x = i * barW + pad;
          const secH = d.secondary != null ? (d.secondary / max) * (height - 4) : 0;
          return (
            <React.Fragment key={i}>
              {d.secondary != null && (
                <Rect x={x} y={height - secH} width={innerW} height={secH} fill="rgba(52,211,153,0.25)" rx={1} />
              )}
              <Rect
                x={x}
                y={height - h}
                width={innerW}
                height={Math.max(h, 1)}
                fill={d.highlight ? colors.accent : colors.accentDeep}
                rx={1}
              />
            </React.Fragment>
          );
        })}
      </Svg>
      <View style={styles.labels}>
        {data.map((d, i) => (
          <View key={i} style={styles.labelCol}>
            <Text style={[styles.value, d.highlight && styles.valueHi]} numberOfLines={1}>{valueFormatter(d.value)}</Text>
            <Text style={[styles.label, d.highlight && styles.labelHi]} numberOfLines={1}>{d.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// Lightweight SVG line chart for projections (e.g. net worth over years).
export function LineChart({ data, height = 160, valueFormatter = compactMoney }: { data: { x: number; y: number }[]; height?: number; valueFormatter?: (n: number) => string }) {
  if (data.length < 2) return <Text style={styles.empty}>No data</Text>;
  const W = 100;
  const xs = data.map((d) => d.x);
  const ys = data.map((d) => d.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys), maxY = Math.max(1, ...ys);
  const sx = (x: number) => ((x - minX) / Math.max(1e-9, maxX - minX)) * W;
  const sy = (y: number) => height - ((y - minY) / Math.max(1e-9, maxY - minY)) * (height - 4) - 2;
  const pts = data.map((d) => `${sx(d.x).toFixed(2)},${sy(d.y).toFixed(2)}`).join(" ");
  const area = `M ${sx(minX)},${height} L ${data.map((d) => `${sx(d.x).toFixed(2)},${sy(d.y).toFixed(2)}`).join(" L ")} L ${sx(maxX)},${height} Z`;
  const last = data[data.length - 1];
  const zeroY = sy(0);

  return (
    <View>
      <Svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none">
        {minY < 0 && <Line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke={colors.borderSubtle} strokeWidth={0.5} />}
        <Path d={area} fill="rgba(52,211,153,0.12)" />
        <Polyline points={pts} fill="none" stroke={colors.accent} strokeWidth={1.5} />
        <Circle cx={sx(last.x)} cy={sy(last.y)} r={1.8} fill={colors.accent} />
      </Svg>
      <View style={styles.lineLabels}>
        <Text style={styles.label}>yr {minX}</Text>
        <Text style={[styles.value, styles.valueHi]}>{valueFormatter(last.y)}</Text>
        <Text style={styles.label}>yr {maxX}</Text>
      </View>
    </View>
  );
}

// Balance-over-time area line with red overlay segments where the balance rose due to
// a "flagged" inflow (Investments transfer or big Zelle). Mirrors the desktop Chase
// cash-flow-history chart. `points` are pre-sliced to the visible window.
export function BalanceChart({
  points,
  height = 160,
}: {
  points: { date: string; balance: number; flagged: boolean }[];
  height?: number;
}) {
  if (points.length < 2) return <Text style={styles.empty}>Not enough history</Text>;
  const W = 100;
  const ys = points.map((p) => p.balance);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(1, ...ys);
  const sx = (i: number) => (i / (points.length - 1)) * W;
  const sy = (y: number) => height - ((y - minY) / Math.max(1e-9, maxY - minY)) * (height - 4) - 2;
  const linePts = points.map((p, i) => `${sx(i).toFixed(2)},${sy(p.balance).toFixed(2)}`).join(" ");
  const area = `M ${sx(0)},${height} L ${points.map((p, i) => `${sx(i).toFixed(2)},${sy(p.balance).toFixed(2)}`).join(" L ")} L ${sx(points.length - 1)},${height} Z`;
  const zeroY = sy(0);

  // Red overlay: each segment i-1 → i where the balance rose into a flagged day.
  const redSegs: string[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].flagged && points[i].balance > points[i - 1].balance) {
      redSegs.push(`M ${sx(i - 1).toFixed(2)},${sy(points[i - 1].balance).toFixed(2)} L ${sx(i).toFixed(2)},${sy(points[i].balance).toFixed(2)}`);
    }
  }

  return (
    <View>
      <Svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none">
        {minY < 0 && <Line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke={colors.borderSubtle} strokeWidth={0.5} />}
        <Path d={area} fill="rgba(59,130,246,0.14)" />
        <Polyline points={linePts} fill="none" stroke={colors.info} strokeWidth={1.4} />
        {redSegs.map((d, i) => (
          <Path key={i} d={d} fill="none" stroke={colors.negative} strokeWidth={2.4} />
        ))}
      </Svg>
      <View style={styles.lineLabels}>
        <Text style={styles.label}>{points[0].date}</Text>
        <Text style={styles.label}>{points[points.length - 1].date}</Text>
      </View>
    </View>
  );
}

// Horizontal "category bar" — a labelled progress bar with current value and a colour.
export function CategoryBar({ label, value, max, color, sub }: { label: string; value: number; max: number; color: string; sub?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <View style={styles.catRow}>
      <View style={styles.catHeader}>
        <Text style={styles.catLabel} numberOfLines={1}>{label}</Text>
        <Text style={styles.catValue}>{compactMoney(value)}</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      {sub ? <Text style={styles.catSub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.textFaint, fontSize: font.size.sm, textAlign: "center", paddingVertical: spacing(4) },
  labels: { flexDirection: "row", marginTop: spacing(1) },
  lineLabels: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: spacing(1) },
  labelCol: { flex: 1, alignItems: "center" },
  value: { color: colors.textFaint, fontSize: font.size.xs, fontVariant: ["tabular-nums"] },
  valueHi: { color: colors.accentSoft, fontWeight: font.weight.semibold },
  label: { color: colors.textFaint, fontSize: font.size.xs },
  labelHi: { color: colors.text, fontWeight: font.weight.semibold },
  catRow: { gap: spacing(1) },
  catHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  catLabel: { color: colors.text, fontSize: font.size.sm, flex: 1, marginRight: spacing(2) },
  catValue: { color: colors.textMuted, fontSize: font.size.sm, fontVariant: ["tabular-nums"] },
  catSub: { color: colors.textFaint, fontSize: font.size.xs },
  track: { height: 8, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, overflow: "hidden" },
  fill: { height: 8, borderRadius: radius.pill },
});
