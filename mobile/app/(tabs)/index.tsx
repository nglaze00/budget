import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Modal, ScrollView, FlatList } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/components/Screen";
import { Card, CardTitle } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { BarChart, CategoryBar, BalanceChart, BarDatum } from "@/components/Charts";
import { Money } from "@/components/Money";
import { colors, font, spacing, radius, colorForRatio } from "@/theme";
import { computeStats, Stats } from "@/lib/stats";
import {
  listInflows, getPaycheckSplits, cashFlowHistory, categorySpendTxns, setUserCategory,
  listCategories, InflowTxn, CashFlowHistory, TxnRow,
} from "@/lib/data";
import { compactMoney, money, monthLabel, shortMonthLabel, shortDate, shiftMonth, todayMonth } from "@/lib/format";

function median(values: number[]): number {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function pct(n: number): string {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(0)}%`;
}

interface CatRow {
  category: string; current_month: number; txn_count: number; median_monthly: number; delta: number; pct: number | null;
}

export default function DashboardScreen() {
  const router = useRouter();
  const [month, setMonth] = useState(todayMonth());
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  // Auxiliary dashboard data (loaded alongside stats).
  const [inflows, setInflows] = useState<InflowTxn[] | null>(null);
  const [splitsByTx, setSplitsByTx] = useState<Map<string, { portion: string; amount: number }[]>>(new Map());
  const [paycheckCats, setPaycheckCats] = useState<Set<string>>(new Set());
  const [cashHist, setCashHist] = useState<CashFlowHistory | null>(null);
  const [drilldown, setDrilldown] = useState<{ category: string; month: string } | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    try {
      const [s, inf, splits, hist, cats] = await Promise.all([
        computeStats(m), listInflows(m), getPaycheckSplits(m), cashFlowHistory(), listCategories(),
      ]);
      setStats(s);
      setInflows(inf);
      setSplitsByTx(splits);
      setCashHist(hist);
      setPaycheckCats(new Set(cats.filter((c) => c.isPaycheckSource === 1).map((c) => c.name)));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(month); }, [load, month]));

  const nav = (delta: number) => setMonth((m) => shiftMonth(m, delta));

  // ── Category rows: 12-mo median, delta vs median, sorted by median (desktop parity) ──
  const { categoryRows, movers, medians } = useMemo(() => {
    const empty = { categoryRows: [] as CatRow[], movers: [] as CatRow[], medians: new Map<string, number>() };
    if (!stats) return empty;
    const byCat = new Map<string, number[]>();
    for (const r of stats.categoryMonthly) {
      const list = byCat.get(r.category) ?? [];
      list.push(r.total);
      byCat.set(r.category, list);
    }
    const medians = new Map<string, number>();
    for (const [c, vals] of byCat) medians.set(c, median(vals));

    const rows: CatRow[] = stats.categorySpend.map((c) => {
      const med = medians.get(c.category) ?? 0;
      return {
        category: c.category, current_month: c.current_month, txn_count: c.txn_count,
        median_monthly: med, delta: c.current_month - med, pct: med > 0 ? ((c.current_month - med) / med) * 100 : null,
      };
    });
    // Categories with history this window but no current-month spend.
    for (const [cat, vals] of byCat) {
      if (!rows.find((r) => r.category === cat)) {
        const med = median(vals);
        if (med > 0) rows.push({ category: cat, current_month: 0, txn_count: 0, median_monthly: med, delta: -med, pct: -100 });
      }
    }
    rows.sort((a, b) => b.median_monthly - a.median_monthly);
    const movers = rows.filter((c) => c.median_monthly > 0 && c.pct != null)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4);
    return { categoryRows: rows, movers, medians };
  }, [stats]);

  // ── KPI inputs ──────────────────────────────────────────────────────────
  const kpi = useMemo(() => {
    if (!stats) return null;
    const cur = stats.monthlySpend.find((m) => m.month === month);
    const currentSpend = cur?.total ?? 0;
    const currentIncome = cur?.income ?? 0;
    const currentNet = cur?.net ?? 0;

    const priorKey = shiftMonth(month, -1);
    const priorSpend = stats.monthlySpend.find((m) => m.month === priorKey)?.total ?? null;
    const momDelta = priorSpend && priorSpend > 0 ? ((currentSpend - priorSpend) / priorSpend) * 100 : null;

    const windowMedian = median(stats.monthlySpend.map((m) => m.total));
    const windowSize = stats.monthlySpend.length;

    const curYear = month.slice(0, 4);
    const yoyPrior = stats.yoySpend.filter((y) => y.year < curYear).slice(-1)[0] ?? null;
    const yoyDelta = yoyPrior && yoyPrior.total > 0 ? ((currentSpend - yoyPrior.total) / yoyPrior.total) * 100 : null;

    const cashIn = stats.cashFlow.find((c) => c.direction === "in")?.total ?? 0;
    const cashOut = stats.cashFlow.find((c) => c.direction === "out")?.total ?? 0;
    const cashNet = cashIn - cashOut;

    const savingsRate = currentIncome > 0 ? (currentNet / currentIncome) * 100 : null;
    const ratios = stats.monthlySpend.filter((m) => m.income > 0).map((m) => (m.net / m.income) * 100);
    const medianSavingsRate = ratios.length ? median(ratios.map((r) => r + 1000)) - 1000 : null; // median allowing negatives

    const today = new Date();
    const [yNum, mNum] = month.split("-").map(Number);
    const isCurrentCal = today.getFullYear() === yNum && today.getMonth() + 1 === mNum;
    const daysInMonth = new Date(yNum, mNum, 0).getDate();
    const daysElapsed = isCurrentCal ? today.getDate() : daysInMonth;
    const dailySpend = daysElapsed > 0 ? currentSpend / daysElapsed : 0;
    const projectedSpend = isCurrentCal ? dailySpend * daysInMonth : currentSpend;

    const invTotal = stats.investmentAccounts.reduce((s, a) => s + a.balance, 0);
    const invContrib = stats.investmentAccounts.reduce((s, a) => s + a.contributions, 0);

    return {
      currentSpend, currentIncome, currentNet, priorSpend, momDelta, windowMedian, windowSize,
      yoyPrior, yoyDelta, cashIn, cashOut, cashNet, savingsRate, medianSavingsRate,
      isCurrentCal, daysInMonth, daysElapsed, dailySpend, projectedSpend, invTotal, invContrib,
    };
  }, [stats, month]);

  const trend: BarDatum[] = (stats?.monthlySpend ?? []).map((m) => ({
    label: shortMonthLabel(m.month), value: m.total, secondary: m.income, highlight: m.month === month,
  }));
  const maxCat = Math.max(1, ...categoryRows.map((c) => Math.max(c.current_month, c.median_monthly)));
  const nw = stats?.netWorth;
  const invTotal = kpi?.invTotal ?? 0;

  // Inflows grouping (paycheck employers vs other), bonus portions treated as "other".
  const { paycheckSections, otherInflows, inflowTotal } = useMemo(() => {
    const all = inflows ?? [];
    const buckets = new Map<string, InflowTxn[]>();
    const other: InflowTxn[] = [];
    for (const t of all) {
      if (!t.category || !paycheckCats.has(t.category)) { other.push(t); continue; }
      const bucket = buckets.get(t.category) ?? [];
      const splits = splitsByTx.get(t.transactionId);
      if (!splits || splits.length === 0) {
        bucket.push(t);
      } else {
        const reg = splits.find((s) => s.portion === "regular")?.amount ?? 0;
        const bon = splits.find((s) => s.portion === "bonus")?.amount ?? 0;
        if (reg > 0) bucket.push({ ...t, amount: reg, description: (t.description ?? "") + " (regular)" });
        if (bon > 0) other.push({ ...t, transactionId: t.transactionId + ":bonus", amount: bon, description: (t.description ?? "") + " (bonus / stock)" });
      }
      buckets.set(t.category, bucket);
    }
    other.sort((a, b) => b.amount - a.amount);
    const sections = Array.from(buckets.entries())
      .map(([category, rows]) => ({ category, rows: rows.sort((a, b) => b.amount - a.amount), total: rows.reduce((s, t) => s + t.amount, 0) }))
      .sort((a, b) => b.total - a.total);
    return { paycheckSections: sections, otherInflows: other, inflowTotal: all.reduce((s, t) => s + t.amount, 0) };
  }, [inflows, splitsByTx, paycheckCats]);

  // Cash-flow history: clamp to a ~13-month visible window so the early negative drift
  // doesn't dominate; show daily points within it.
  const cashSeries = useMemo(() => {
    const raw = cashHist?.series ?? [];
    if (raw.length === 0) return [];
    const [y, m] = month.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 13, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const win = raw.filter((p) => p.date >= start && p.date <= end);
    return (win.length >= 2 ? win : raw.slice(-90)).map((p) => ({ date: shortDate(p.date), balance: p.balance, flagged: p.flagged }));
  }, [cashHist, month]);

  return (
    <Screen onRefresh={() => load(month)} refreshing={loading}>
      <View style={styles.monthBar}>
        <Pressable onPress={() => nav(-1)} hitSlop={12}><Ionicons name="chevron-back" size={22} color={colors.textMuted} /></Pressable>
        <Text style={styles.monthLabel}>{monthLabel(month)}</Text>
        <Pressable onPress={() => nav(1)} hitSlop={12} disabled={month >= todayMonth()}>
          <Ionicons name="chevron-forward" size={22} color={month >= todayMonth() ? colors.borderSubtle : colors.textMuted} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.push("/settings")} hitSlop={12}><Ionicons name="settings-outline" size={20} color={colors.textMuted} /></Pressable>
      </View>

      {loading && !stats ? (
        <View style={styles.loading}><ActivityIndicator color={colors.accent} /></View>
      ) : !stats || !kpi ? null : (
        <>
          {/* ── KPI strip ── */}
          <View style={styles.kpiGrid}>
            <Kpi
              label="Saved this month"
              value={money(kpi.currentNet, { sign: true, cents: false })}
              color={kpi.currentNet >= 0 ? colors.positive : colors.negative}
              sub={kpi.savingsRate != null
                ? `${kpi.savingsRate.toFixed(0)}% of income${kpi.medianSavingsRate != null ? ` · med ${kpi.medianSavingsRate.toFixed(0)}%` : ""}`
                : "no income recorded"}
            />
            <Kpi
              label={kpi.isCurrentCal ? "On pace for" : "Spent"}
              value={money(kpi.projectedSpend, { cents: false })}
              color={kpi.windowMedian > 0
                ? kpi.projectedSpend > kpi.windowMedian * 1.05 ? colors.negative
                : kpi.projectedSpend < kpi.windowMedian * 0.95 ? colors.positive : colors.text
                : colors.text}
              sub={kpi.isCurrentCal
                ? `$${kpi.dailySpend.toFixed(0)}/day · day ${kpi.daysElapsed} of ${kpi.daysInMonth}`
                : kpi.windowMedian > 0 ? `${pct(((kpi.currentSpend - kpi.windowMedian) / kpi.windowMedian) * 100)} vs ${kpi.windowSize}-mo median` : ""}
            />
            <Kpi
              label="Cash flow (Chase)"
              value={money(kpi.cashNet, { sign: true, cents: false })}
              color={kpi.cashNet >= 0 ? colors.positive : colors.negative}
              sub={`${compactMoney(kpi.cashIn)} in · ${compactMoney(kpi.cashOut)} out`}
            />
            <Kpi
              label="Net worth"
              value={money(nw?.total, { cents: false })}
              color={(nw?.total ?? 0) >= 0 ? colors.positive : colors.negative}
              sub={`${compactMoney(nw?.investments)} invest · ${compactMoney(nw?.cash)} cash${(nw?.credit ?? 0) < 0 ? ` · ${compactMoney(Math.abs(nw!.credit))} debt` : ""}`}
            />
          </View>

          {/* ── Income, spending & net ── */}
          <Card>
            <CardTitle right={<Text style={styles.legend}>spend · income</Text>}>Income, spending & net</CardTitle>
            <BarChart data={trend} />
            <View style={styles.flowRow}>
              <Stat label="Income" value={compactMoney(kpi.currentIncome)} color={colors.positive} />
              <Stat label="Spent" value={compactMoney(kpi.currentSpend)} color={colors.negative} />
              <Stat label="Net" value={money(kpi.currentNet, { sign: true, cents: false })} color={kpi.currentNet >= 0 ? colors.positive : colors.negative} />
            </View>
            <View style={styles.diffRow}>
              <Text style={styles.diffLabel}>{kpi.windowSize}-mo median spend</Text>
              <Text style={styles.diffVal}>{money(kpi.windowMedian, { cents: false })}</Text>
            </View>
            {kpi.priorSpend != null && (
              <DiffStat label="vs last month" diff={kpi.currentSpend - kpi.priorSpend} percent={kpi.momDelta} />
            )}
            {kpi.yoyPrior && (
              <DiffStat label={`vs ${shortMonthLabel(month)} last year`} diff={kpi.currentSpend - kpi.yoyPrior.total} percent={kpi.yoyDelta} />
            )}
          </Card>

          {/* ── Spending by category ── */}
          <Card>
            <CardTitle right={<Text style={styles.legend}>{categoryRows.length} categories</Text>}>Spending by category</CardTitle>
            {movers.length > 0 && (
              <View style={styles.moverWrap}>
                {movers.map((m) => (
                  <Pressable
                    key={m.category}
                    onPress={() => setDrilldown({ category: m.category, month })}
                    style={[styles.moverChip, { borderColor: m.delta > 0 ? "#7f1d1d" : "#065f46", backgroundColor: m.delta > 0 ? "rgba(127,29,29,0.25)" : "rgba(6,95,70,0.25)" }]}
                  >
                    <Text style={[styles.moverText, { color: m.delta > 0 ? "#fca5a5" : "#6ee7b7" }]}>
                      {m.category} {pct(m.pct ?? 0)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            {categoryRows.length === 0 && <Text style={styles.muted}>No spending this month.</Text>}
            {categoryRows.map((c) => (
              <Pressable key={c.category} onPress={() => setDrilldown({ category: c.category, month })}>
                <CategoryBar
                  label={c.category}
                  value={c.current_month}
                  max={maxCat}
                  color={c.current_month > 0 ? colorForRatio(c.current_month, c.median_monthly) : colors.surfaceAlt}
                  sub={c.median_monthly > 0
                    ? `median ${compactMoney(c.median_monthly)}${c.txn_count > 0 ? ` · ${c.txn_count} txns` : " · none this month"}`
                    : `${c.txn_count} txns`}
                />
              </Pressable>
            ))}
            {categoryRows.length > 0 && (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total</Text>
                <Text style={styles.totalVal}>{money(categoryRows.reduce((s, r) => s + r.current_month, 0), { cents: false })}</Text>
              </View>
            )}
          </Card>

          {/* ── Inflows ── */}
          <Card>
            <CardTitle right={<Text style={styles.legend}>{compactMoney(inflowTotal)}</Text>}>Inflows</CardTitle>
            {(inflows?.length ?? 0) === 0 ? (
              <Text style={styles.muted}>No inflows in {monthLabel(month)}.</Text>
            ) : (
              <>
                {paycheckSections.map((sec) => (
                  <InflowSection key={sec.category} title={sec.category} total={sec.total} rows={sec.rows} />
                ))}
                {otherInflows.length > 0 && (
                  <InflowSection title="Other inflows" total={otherInflows.reduce((s, t) => s + t.amount, 0)} rows={otherInflows} />
                )}
              </>
            )}
          </Card>

          {/* ── Unusual transactions ── */}
          {stats.anomalies.length > 0 && (
            <Card>
              <CardTitle right={<Text style={styles.legend}>top 10% by size</Text>}>Unusual purchases</CardTitle>
              {stats.anomalies.map((a) => (
                <View key={a.transaction_id} style={styles.anomRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.anomDesc} numberOfLines={1}>{a.payee || a.description || "—"}</Text>
                    <Text style={styles.anomMeta}>{a.category} · {a.date} · ≥ {compactMoney(a.category_p90)}</Text>
                  </View>
                  <Money value={-a.amount} />
                </View>
              ))}
            </Card>
          )}

          {/* ── Chase balance over time ── */}
          {cashSeries.length >= 2 && (
            <Card>
              <CardTitle right={<Text style={styles.legend}>{cashHist?.account?.name ?? "Chase"}</Text>}>Balance over time</CardTitle>
              <View style={styles.flowRow}>
                <Stat label="In" value={compactMoney(kpi.cashIn)} color={colors.positive} />
                <Stat label="Out" value={compactMoney(kpi.cashOut)} color={colors.negative} />
                <Stat label="Balance" value={compactMoney(cashHist?.account?.balance)} color={(cashHist?.account?.balance ?? 0) >= 0 ? colors.positive : colors.negative} />
              </View>
              <BalanceChart points={cashSeries} />
              <Text style={styles.muted}>Red = balance rose from an Investments transfer or a Zelle deposit ≥ $1k.</Text>
            </Card>
          )}

          {/* ── Investments ── */}
          {stats.investmentAccounts.length > 0 && (
            <Card>
              <CardTitle right={kpi.invContrib !== 0 ? <Text style={styles.legend}>{money(kpi.invContrib, { sign: true, cents: false })} {shortMonthLabel(month)}</Text> : undefined}>Investments</CardTitle>
              <Text style={styles.netTotal}>{money(invTotal, { cents: false })}</Text>
              {stats.investmentAccounts.map((a) => {
                const share = invTotal > 0 ? (a.balance / invTotal) * 100 : 0;
                return (
                  <CategoryBar
                    key={a.account_id}
                    label={a.name}
                    value={a.balance}
                    max={invTotal}
                    color="#8b5cf6"
                    sub={`${share.toFixed(0)}%${a.contributions !== 0 ? ` · ${money(a.contributions, { sign: true, cents: false })} ${shortMonthLabel(month)}` : ""}`}
                  />
                );
              })}
            </Card>
          )}
        </>
      )}

      <DrilldownModal
        target={drilldown}
        onClose={() => setDrilldown(null)}
        onChanged={() => load(month)}
      />
    </Screen>
  );
}

// ── KPI tile ────────────────────────────────────────────────────────────────
function Kpi({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color: color ?? colors.text }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {sub ? <Text style={styles.kpiSub} numberOfLines={2}>{sub}</Text> : null}
    </View>
  );
}

function DiffStat({ label, diff, percent }: { label: string; diff: number; percent: number | null }) {
  const up = diff > 0;
  const color = up ? colors.negative : colors.positive; // more spend = bad
  return (
    <View style={styles.diffRow}>
      <Text style={styles.diffLabel}>{label}</Text>
      <Text style={[styles.diffVal, { color }]}>
        {money(diff, { sign: true, cents: false })}{percent != null ? ` (${pct(percent)})` : ""}
      </Text>
    </View>
  );
}

function InflowSection({ title, total, rows }: { title: string; total: number; rows: InflowTxn[] }) {
  return (
    <View style={styles.inflowSection}>
      <View style={styles.inflowHeader}>
        <Text style={styles.inflowTitle}>{title} · {rows.length}</Text>
        <Text style={styles.inflowTotal}>{compactMoney(total)}</Text>
      </View>
      {rows.slice(0, 12).map((t) => (
        <View key={t.transactionId} style={styles.inflowRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.inflowDesc} numberOfLines={1}>{t.payee || t.description || "—"}</Text>
            <Text style={styles.inflowMeta}>{t.date}{t.accountOrgName ? ` · ${t.accountOrgName}` : ""}</Text>
          </View>
          <Money value={t.amount} size={font.size.sm} />
        </View>
      ))}
    </View>
  );
}

// ── Category drilldown (transactions + recategorize) ─────────────────────────
function DrilldownModal({ target, onClose, onChanged }: {
  target: { category: string; month: string } | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [txns, setTxns] = useState<TxnRow[] | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [picking, setPicking] = useState<TxnRow | null>(null);
  const [dirty, setDirty] = useState(false);

  const visible = target != null;

  React.useEffect(() => {
    if (!target) { setTxns(null); setDirty(false); return; }
    let canceled = false;
    setTxns(null);
    Promise.all([categorySpendTxns(target.month, target.category), listCategories()]).then(([t, c]) => {
      if (canceled) return;
      setTxns(t);
      setCats(c.map((x) => x.name).sort());
    });
    return () => { canceled = true; };
  }, [target]);

  const total = txns?.reduce((s, t) => s + Math.abs(t.amount), 0) ?? 0;

  async function recategorize(t: TxnRow, newCat: string) {
    setPicking(null);
    if (!target || newCat === target.category) return;
    await setUserCategory(t.transactionId, newCat);
    setTxns((cur) => (cur ?? []).filter((x) => x.transactionId !== t.transactionId));
    setDirty(true);
  }

  function close() {
    if (dirty) onChanged();
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalTitle}>{target?.category}</Text>
              {txns && <Text style={styles.modalSub}>{txns.length} txns · {money(total, { cents: false })} · {monthLabel(target?.month ?? "")}</Text>}
            </View>
            <Pressable onPress={close} hitSlop={12}><Ionicons name="close" size={24} color={colors.textMuted} /></Pressable>
          </View>
          {!txns ? (
            <View style={styles.loading}><ActivityIndicator color={colors.accent} /></View>
          ) : txns.length === 0 ? (
            <Text style={styles.muted}>No spending in this category.</Text>
          ) : (
            <FlatList
              data={txns}
              keyExtractor={(t) => t.transactionId}
              style={{ maxHeight: 460 }}
              renderItem={({ item: t }) => (
                <Pressable style={styles.drillRow} onPress={() => setPicking(t)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.drillDesc} numberOfLines={1}>{t.description || t.payee || "—"}</Text>
                    <Text style={styles.drillMeta}>{t.date}{t.accountOrgName ? ` · ${t.accountOrgName}` : ""}</Text>
                  </View>
                  <Text style={styles.drillAmt}>{money(Math.abs(t.amount), { cents: false })}</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={{ marginLeft: 4 }} />
                </Pressable>
              )}
            />
          )}
        </View>
      </View>

      {/* Category picker for the tapped transaction. */}
      <Modal visible={picking != null} animationType="fade" transparent onRequestClose={() => setPicking(null)}>
        <Pressable style={styles.pickerBackdrop} onPress={() => setPicking(null)}>
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>Move to…</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {cats.map((c) => (
                <Pressable key={c} style={styles.pickerRow} onPress={() => picking && recategorize(picking, c)}>
                  <Text style={[styles.pickerText, target?.category === c && { color: colors.accent }]}>{c}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  monthBar: { flexDirection: "row", alignItems: "center", gap: spacing(3), paddingVertical: spacing(1) },
  monthLabel: { color: colors.text, fontSize: font.size.lg, fontWeight: font.weight.bold },
  loading: { paddingVertical: spacing(10), alignItems: "center" },
  netTotal: { color: colors.text, fontSize: font.size.huge, fontWeight: font.weight.bold, fontVariant: ["tabular-nums"] },
  legend: { color: colors.textFaint, fontSize: font.size.xs },
  muted: { color: colors.textFaint, fontSize: font.size.sm },

  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2) },
  kpi: { flexBasis: "48%", flexGrow: 1, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: spacing(3), gap: 2 },
  kpiLabel: { color: colors.textFaint, fontSize: font.size.xs, textTransform: "uppercase", letterSpacing: 0.4 },
  kpiValue: { fontSize: font.size.xl, fontWeight: font.weight.bold, fontVariant: ["tabular-nums"] },
  kpiSub: { color: colors.textMuted, fontSize: font.size.xs },

  flowRow: { flexDirection: "row", gap: spacing(3), flexWrap: "wrap" },
  diffRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  diffLabel: { color: colors.textMuted, fontSize: font.size.sm },
  diffVal: { color: colors.text, fontSize: font.size.sm, fontWeight: font.weight.medium, fontVariant: ["tabular-nums"] },

  moverWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2) },
  moverChip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing(3), paddingVertical: spacing(1) },
  moverText: { fontSize: font.size.xs, fontWeight: font.weight.medium },

  totalRow: { flexDirection: "row", justifyContent: "space-between", borderTopColor: colors.border, borderTopWidth: 1, paddingTop: spacing(2) },
  totalLabel: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: font.weight.medium },
  totalVal: { color: colors.accentSoft, fontSize: font.size.sm, fontWeight: font.weight.semibold, fontVariant: ["tabular-nums"] },

  inflowSection: { gap: spacing(1) },
  inflowHeader: { flexDirection: "row", justifyContent: "space-between", borderBottomColor: colors.borderSubtle, borderBottomWidth: 1, paddingBottom: spacing(1) },
  inflowTitle: { color: colors.textMuted, fontSize: font.size.xs, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: font.weight.medium },
  inflowTotal: { color: colors.positive, fontSize: font.size.sm, fontWeight: font.weight.medium, fontVariant: ["tabular-nums"] },
  inflowRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing(2), paddingVertical: spacing(1) },
  inflowDesc: { color: colors.text, fontSize: font.size.sm },
  inflowMeta: { color: colors.textFaint, fontSize: font.size.xs },

  anomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing(2), borderTopColor: colors.borderSubtle, borderTopWidth: 1, gap: spacing(3) },
  anomDesc: { color: colors.text, fontSize: font.size.sm, fontWeight: font.weight.medium },
  anomMeta: { color: colors.textFaint, fontSize: font.size.xs },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing(4), gap: spacing(3), borderTopColor: colors.border, borderTopWidth: 1 },
  modalHeader: { flexDirection: "row", alignItems: "center", gap: spacing(2) },
  modalTitle: { color: colors.text, fontSize: font.size.lg, fontWeight: font.weight.bold },
  modalSub: { color: colors.textFaint, fontSize: font.size.xs },
  drillRow: { flexDirection: "row", alignItems: "center", paddingVertical: spacing(2), borderTopColor: colors.borderSubtle, borderTopWidth: 1, gap: spacing(2) },
  drillDesc: { color: colors.text, fontSize: font.size.sm },
  drillMeta: { color: colors.textFaint, fontSize: font.size.xs },
  drillAmt: { color: colors.text, fontSize: font.size.sm, fontWeight: font.weight.medium, fontVariant: ["tabular-nums"] },

  pickerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: spacing(6) },
  pickerSheet: { backgroundColor: colors.surface, borderRadius: radius.lg, borderColor: colors.border, borderWidth: 1, padding: spacing(4), gap: spacing(2) },
  pickerTitle: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: font.weight.semibold, textTransform: "uppercase", letterSpacing: 0.5 },
  pickerRow: { paddingVertical: spacing(2), borderTopColor: colors.borderSubtle, borderTopWidth: 1 },
  pickerText: { color: colors.text, fontSize: font.size.base },
});
