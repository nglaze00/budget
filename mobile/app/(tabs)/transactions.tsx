import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable } from "react-native";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/components/Screen";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { colors, font, radius, spacing } from "@/theme";
import { listTransactions, TxnRow } from "@/lib/data";
import { shortDate, monthLabel, shiftMonth, todayMonth } from "@/lib/format";

export default function TransactionsScreen() {
  const [month, setMonth] = useState(todayMonth());
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<TxnRow[]>([]);
  const [allMonths, setAllMonths] = useState(false);

  const load = useCallback(async () => {
    setRows(await listTransactions({ month: allMonths ? undefined : month, search, limit: 300 }));
  }, [month, search, allMonths]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const total = useMemo(() => rows.reduce((s, r) => s + (r.flowType === "spend" ? -Math.abs(r.amount) : r.amount > 0 ? r.amount : 0), 0), [rows]);

  return (
    <Screen scroll={false} contentStyle={{ flex: 1, paddingBottom: spacing(4) }}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={colors.textFaint} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={load}
          placeholder="Search description or payee…"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          style={styles.search}
          returnKeyType="search"
        />
        {search ? <Pressable onPress={() => { setSearch(""); }}><Ionicons name="close-circle" size={16} color={colors.textFaint} /></Pressable> : null}
      </View>

      <View style={styles.monthBar}>
        <Pressable onPress={() => setAllMonths((a) => !a)} style={[styles.toggle, allMonths && styles.toggleOn]}>
          <Text style={[styles.toggleText, allMonths && styles.toggleTextOn]}>All</Text>
        </Pressable>
        {!allMonths && (
          <>
            <Pressable onPress={() => setMonth((m) => shiftMonth(m, -1))} hitSlop={10}><Ionicons name="chevron-back" size={20} color={colors.textMuted} /></Pressable>
            <Text style={styles.monthLabel}>{monthLabel(month)}</Text>
            <Pressable onPress={() => setMonth((m) => shiftMonth(m, 1))} hitSlop={10} disabled={month >= todayMonth()}>
              <Ionicons name="chevron-forward" size={20} color={month >= todayMonth() ? colors.borderSubtle : colors.textMuted} />
            </Pressable>
          </>
        )}
        <View style={{ flex: 1 }} />
        <Text style={styles.count}>{rows.length} txns</Text>
      </View>

      <Card style={{ flex: 1, padding: 0, overflow: "hidden" }}>
        <Flatish rows={rows} />
      </Card>
    </Screen>
  );
}

// Simple virtualization-free list inside a scroll; fine for a few hundred rows.
import { FlatList } from "react-native";
function Flatish({ rows }: { rows: TxnRow[] }) {
  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.transactionId}
      contentContainerStyle={{ padding: spacing(4), gap: spacing(1) }}
      ListEmptyComponent={<Text style={styles.empty}>No transactions.</Text>}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.desc} numberOfLines={1}>{item.description || item.payee || "—"}</Text>
            <Text style={styles.meta}>{shortDate(item.date)} · {item.category ?? "uncategorized"}</Text>
          </View>
          <Money value={item.amount} />
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: "row", alignItems: "center", gap: spacing(2), backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing(3) },
  search: { flex: 1, color: colors.text, paddingVertical: spacing(3), fontSize: font.size.base },
  monthBar: { flexDirection: "row", alignItems: "center", gap: spacing(2), paddingVertical: spacing(1) },
  monthLabel: { color: colors.text, fontSize: font.size.base, fontWeight: font.weight.semibold, minWidth: 120, textAlign: "center" },
  count: { color: colors.textFaint, fontSize: font.size.xs },
  toggle: { borderColor: colors.border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing(3), paddingVertical: spacing(1) },
  toggleOn: { backgroundColor: colors.accentDeep, borderColor: colors.accent },
  toggleText: { color: colors.textMuted, fontSize: font.size.sm },
  toggleTextOn: { color: colors.text, fontWeight: font.weight.semibold },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing(3), paddingVertical: spacing(2), borderBottomColor: colors.borderSubtle, borderBottomWidth: 1 },
  desc: { color: colors.text, fontSize: font.size.sm, fontWeight: font.weight.medium },
  meta: { color: colors.textFaint, fontSize: font.size.xs },
  empty: { color: colors.textFaint, fontSize: font.size.sm, textAlign: "center", padding: spacing(6) },
});
