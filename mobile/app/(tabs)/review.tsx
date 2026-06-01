import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Alert } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/components/Screen";
import { Card, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { Money } from "@/components/Money";
import { Badge, confidenceColor } from "@/components/Badge";
import { colors, font, radius, spacing } from "@/theme";
import {
  getReviewData, listCategories, setUserCategory, confirmSplit, pendingCount,
  ReviewTxn, PaycheckRow, CategoryRow,
} from "@/lib/data";
import { categorizeUncategorized } from "@/lib/categorize";
import { shortDate } from "@/lib/format";

export default function ReviewScreen() {
  const router = useRouter();
  const [txns, setTxns] = useState<ReviewTxn[]>([]);
  const [paychecks, setPaychecks] = useState<PaycheckRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [pending, setPending] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");

  const load = useCallback(async () => {
    const [rev, cats, p] = await Promise.all([getReviewData(), listCategories(), pendingCount()]);
    setTxns(rev.transactions);
    setPaychecks(rev.paychecks);
    setCategories(cats);
    setPending(p);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function categorize() {
    try {
      setRunning(true);
      setProgress("Starting…");
      const res = await categorizeUncategorized((pr) => setProgress(`Categorizing ${pr.done}/${pr.total}…`));
      setProgress("");
      Alert.alert("Done", `Categorized ${res.categorized} transaction(s).`);
      load();
    } catch (e) {
      setProgress("");
      Alert.alert("Categorization failed", e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function pick(txnId: string, category: string) {
    await setUserCategory(txnId, category);
    setTxns((prev) => prev.filter((t) => t.transactionId !== txnId));
    setExpanded(null);
    setPending((p) => Math.max(0, p - 1));
  }

  return (
    <Screen onRefresh={load}>
      <Card>
        <CardTitle right={<Text style={styles.count}>{pending} pending</Text>}>Categorize</CardTitle>
        <Text style={styles.body}>Run the AI categorizer over anything uncategorized, then confirm the unsure ones below.</Text>
        {progress ? <Text style={styles.progress}>{progress}</Text> : null}
        <Button title="Categorize uncategorized" onPress={categorize} loading={running} disabled={running} />
        <Button title="Bulk-categorize with chat assistant" variant="ghost" onPress={() => router.push("/chat")} disabled={running} />
      </Card>

      {txns.length > 0 && (
        <Card>
          <CardTitle right={<Text style={styles.count}>{txns.length}</Text>}>Needs review</CardTitle>
          {txns.map((t) => {
            const alts: string[] = t.categoryAlternatives ? safeParse(t.categoryAlternatives) : [];
            const chips = dedupe([t.category, ...alts].filter(Boolean) as string[]);
            const isOpen = expanded === t.transactionId;
            return (
              <View key={t.transactionId} style={styles.txn}>
                <Pressable onPress={() => setExpanded(isOpen ? null : t.transactionId)}>
                  <View style={styles.txnHead}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.txnDesc} numberOfLines={1}>{t.description || t.payee || "—"}</Text>
                      <Text style={styles.txnMeta}>{shortDate(t.date)} · {t.accountOrgName ?? ""}</Text>
                    </View>
                    <Money value={t.amount} />
                  </View>
                </Pressable>
                <View style={styles.chipRow}>
                  {chips.map((c) => (
                    <Chip key={c} label={c} active={c === t.category} onPress={() => pick(t.transactionId, c)} />
                  ))}
                  <Pressable onPress={() => setExpanded(isOpen ? null : t.transactionId)} style={styles.moreChip}>
                    <Text style={styles.moreText}>{isOpen ? "Less" : "More…"}</Text>
                  </Pressable>
                </View>
                {t.categoryConfidence && (
                  <Badge label={t.categoryConfidence.replace("_", " ")} color={confidenceColor(t.categoryConfidence)} />
                )}
                {isOpen && (
                  <View style={styles.chipRow}>
                    {categories.map((c) => (
                      <Chip key={c.name} label={c.name} active={c.name === t.category} onPress={() => pick(t.transactionId, c.name)} />
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </Card>
      )}

      {paychecks.length > 0 && (
        <Card>
          <CardTitle right={<Text style={styles.count}>{paychecks.length}</Text>}>Confirm paychecks</CardTitle>
          {paychecks.map((p) => (
            <PaycheckCard key={p.transactionId} paycheck={p} onConfirmed={() => { setPaychecks((prev) => prev.filter((x) => x.transactionId !== p.transactionId)); }} />
          ))}
        </Card>
      )}

      {txns.length === 0 && paychecks.length === 0 && (
        <Card>
          <View style={styles.allClear}>
            <Ionicons name="checkmark-circle" size={28} color={colors.positive} />
            <Text style={styles.allClearText}>Nothing to review — you're all caught up.</Text>
          </View>
        </Card>
      )}
    </Screen>
  );
}

function PaycheckCard({ paycheck, onConfirmed }: { paycheck: PaycheckRow; onConfirmed: () => void }) {
  const autoRegular = paycheck.splits.find((s) => s.portion === "regular")?.amount ?? Math.abs(paycheck.amount);
  const autoBonus = paycheck.splits.find((s) => s.portion === "bonus")?.amount ?? 0;
  const [regular, setRegular] = useState(String(round2(autoRegular)));
  const [bonus, setBonus] = useState(String(round2(autoBonus)));
  const [saving, setSaving] = useState(false);

  async function confirm() {
    try {
      setSaving(true);
      await confirmSplit(paycheck.transactionId, Number(regular) || 0, Number(bonus) || 0);
      onConfirmed();
    } catch (e) {
      Alert.alert("Failed", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.txn}>
      <View style={styles.txnHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.txnDesc} numberOfLines={1}>{paycheck.category ?? paycheck.description ?? "Paycheck"}</Text>
          <Text style={styles.txnMeta}>{shortDate(paycheck.date)}</Text>
        </View>
        <Money value={paycheck.amount} />
      </View>
      <View style={styles.splitRow}>
        <View style={styles.splitField}>
          <Text style={styles.splitLabel}>Regular</Text>
          <TextInput value={regular} onChangeText={setRegular} keyboardType="numeric" style={styles.splitInput} />
        </View>
        <View style={styles.splitField}>
          <Text style={styles.splitLabel}>Bonus</Text>
          <TextInput value={bonus} onChangeText={setBonus} keyboardType="numeric" style={styles.splitInput} />
        </View>
        <Button title="Confirm" small onPress={confirm} loading={saving} />
      </View>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function safeParse(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
function dedupe(arr: string[]): string[] { return Array.from(new Set(arr)); }
function round2(n: number): number { return Math.round(n * 100) / 100; }

const styles = StyleSheet.create({
  body: { color: colors.textMuted, fontSize: font.size.sm, lineHeight: 20 },
  count: { color: colors.textFaint, fontSize: font.size.xs },
  progress: { color: colors.accentSoft, fontSize: font.size.sm },
  txn: { gap: spacing(2), paddingVertical: spacing(3), borderTopColor: colors.borderSubtle, borderTopWidth: 1 },
  txnHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing(3) },
  txnDesc: { color: colors.text, fontSize: font.size.base, fontWeight: font.weight.medium },
  txnMeta: { color: colors.textFaint, fontSize: font.size.xs },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2) },
  chip: { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing(3), paddingVertical: spacing(1) },
  chipActive: { backgroundColor: colors.accentDeep, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: font.size.sm },
  chipTextActive: { color: colors.text, fontWeight: font.weight.semibold },
  moreChip: { paddingHorizontal: spacing(3), paddingVertical: spacing(1) },
  moreText: { color: colors.accentSoft, fontSize: font.size.sm },
  splitRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing(2) },
  splitField: { flex: 1, gap: 2 },
  splitLabel: { color: colors.textFaint, fontSize: font.size.xs },
  splitInput: { backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm, color: colors.text, paddingHorizontal: spacing(2), paddingVertical: spacing(2), fontSize: font.size.sm },
  allClear: { alignItems: "center", gap: spacing(2), paddingVertical: spacing(4) },
  allClearText: { color: colors.textMuted, fontSize: font.size.sm },
});
