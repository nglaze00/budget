import React, { useCallback, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Modal, Switch, Alert,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/components/Screen";
import { Card, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { LineChart, CategoryBar } from "@/components/Charts";
import { colors, font, radius, spacing } from "@/theme";
import { compactMoney, money } from "@/lib/format";
import {
  loadStore, saveStore, activeScenario, categoryMedians,
  type ScenarioStore, type Scenario,
} from "@/lib/planning";
import {
  DEFAULTS, simulate, mergeInputs, fmt, fmtK, parseYM, yearOffsetToYM, relativeDescription,
  GOAL_KINDS,
  type Inputs, type Child, type Goal, type GoalKind, type SimResult,
} from "@/lib/planning-engine";

// =====================================================================
// Full-parity mobile Planning. Runs the exact desktop simulation engine
// (planning-engine.ts) on-device and exposes the complete input set,
// scenario management, KPIs, net-worth projection, account-balance
// breakdown, goal/children/home editors, and category import.
// =====================================================================

type FieldKind = "money" | "pct" | "year" | "int" | "bool" | "select";
interface FieldDef {
  key: keyof Inputs;
  label: string;
  kind: FieldKind;
  options?: { value: string; label: string }[];
  help?: string;
}
interface Group { title: string; fields: FieldDef[] }

const GROUPS: Group[] = [
  {
    title: "You & timeline",
    fields: [
      { key: "userBirthYear", label: "Birth year", kind: "int" },
      { key: "filingStatus", label: "Filing status", kind: "select", options: [
        { value: "single", label: "Single" }, { value: "mfj", label: "Married (MFJ)" } ] },
      { key: "retirementYear", label: "Retire in", kind: "year", help: "0 = never retire (pure projection)" },
    ],
  },
  {
    title: "Cash compensation",
    fields: [
      { key: "baseSalaryAnnual", label: "Base salary / yr", kind: "money" },
      { key: "bonusAnnual", label: "Bonus / yr", kind: "money" },
      { key: "bonusMonth", label: "Bonus month (1-12)", kind: "int" },
      { key: "sideMonthlyCash", label: "Side income / mo", kind: "money" },
      { key: "sideEndYear", label: "Side income ends", kind: "year" },
      { key: "salaryGrowth", label: "Real raise / yr", kind: "pct" },
    ],
  },
  {
    title: "Marriage & spouse",
    fields: [
      { key: "marriageYear", label: "Marriage in", kind: "year", help: "0 = never; flips to MFJ" },
      { key: "spouseBaseAnnual", label: "Spouse base / yr", kind: "money" },
      { key: "spouseBonusAnnual", label: "Spouse bonus / yr", kind: "money" },
      { key: "spouseBonusMonth", label: "Spouse bonus month", kind: "int" },
      { key: "spouseSalaryGrowth", label: "Spouse real raise / yr", kind: "pct" },
      { key: "spouseSharePct", label: "Spouse share of home+kids", kind: "pct" },
      { key: "spouseMoveInYear", label: "Spouse moves in", kind: "year" },
      { key: "spouseRentSharePct", label: "Spouse rent share", kind: "pct" },
      { key: "spouseCollegeSharePct", label: "Spouse college share", kind: "pct" },
    ],
  },
  {
    title: "Stock awards",
    fields: [
      { key: "rsuTotalValue", label: "Unvested RSU value", kind: "money" },
      { key: "rsuFirstVestYear", label: "First vest in", kind: "year" },
      { key: "rsuTotalVests", label: "Total vests", kind: "int" },
      { key: "rsuVestsPerYear", label: "Vests / yr", kind: "int" },
      { key: "annualStockBase", label: "Annual base stock", kind: "money" },
      { key: "annualStockBonus", label: "Annual bonus stock", kind: "money" },
      { key: "haircut", label: "Stock haircut", kind: "pct" },
    ],
  },
  {
    title: "401k, HSA & ESPP",
    fields: [
      { key: "pct401k", label: "401k % of base", kind: "pct" },
      { key: "max401kAlways", label: "Always max 401k", kind: "bool" },
      { key: "limit401k", label: "401k IRS limit", kind: "money" },
      { key: "employerMatchRate", label: "Employer match", kind: "pct" },
      { key: "hsaAnnual", label: "HSA / yr", kind: "money" },
      { key: "hsaLimit", label: "HSA IRS limit", kind: "money" },
      { key: "hsaEmployerAnnual", label: "Employer HSA / yr", kind: "money" },
      { key: "hsaAutoSize", label: "Auto-size HSA", kind: "bool" },
      { key: "balHsaStart", label: "HSA starting bal", kind: "money" },
      { key: "esppRate", label: "ESPP % of base", kind: "pct" },
      { key: "esppDiscount", label: "ESPP discount", kind: "pct" },
      { key: "esppAnnualCap", label: "ESPP annual cap", kind: "money" },
    ],
  },
  {
    title: "Expenses (monthly, real $)",
    fields: [
      { key: "rentMonthly", label: "Rent", kind: "money" },
      { key: "inelasticMonthly", label: "Inelastic", kind: "money" },
      { key: "inelasticGrowth", label: "Inelastic growth / yr", kind: "pct" },
      { key: "discretionaryMonthly", label: "Discretionary", kind: "money" },
      { key: "discretionaryGrowth", label: "Discretionary growth / yr", kind: "pct" },
      { key: "costPerKidMonthly", label: "Cost per kid", kind: "money" },
      { key: "kidYears", label: "Years per kid", kind: "int" },
      { key: "medicalMonthly", label: "Medical (from HSA)", kind: "money" },
      { key: "medicalDropYear", label: "Medical drops in", kind: "year" },
      { key: "medicalAfterMonthly", label: "Medical after drop", kind: "money" },
      { key: "emergencyMonths", label: "Emergency fund (months)", kind: "int" },
      { key: "balEmergencyStart", label: "Emergency starting bal", kind: "money" },
    ],
  },
  {
    title: "Housing & mortgage",
    fields: [
      { key: "houseTargetValue", label: "Home price", kind: "money" },
      { key: "houseDownPaymentPct", label: "Down payment", kind: "pct" },
      { key: "houseClosingCostPct", label: "Closing costs", kind: "pct" },
      { key: "homePurchaseYear", label: "Buy home in", kind: "year", help: "0 = never buy" },
      { key: "mortgageRate", label: "Mortgage rate (real)", kind: "pct" },
      { key: "mortgageTermYears", label: "Mortgage term (yrs)", kind: "int" },
      { key: "propertyTaxRate", label: "Property tax rate", kind: "pct" },
      { key: "homeInsuranceRate", label: "Home insurance rate", kind: "pct" },
      { key: "maintenanceRate", label: "Maintenance rate", kind: "pct" },
      { key: "hoaMonthly", label: "HOA / mo", kind: "money" },
      { key: "secondHomeYear", label: "Second home in", kind: "year" },
      { key: "secondHomeValue", label: "Second home value", kind: "money" },
      { key: "sellingClosingCostPct", label: "Selling cost %", kind: "pct" },
    ],
  },
  {
    title: "Returns & retirement",
    fields: [
      { key: "rNomAnnual", label: "Real market return", kind: "pct" },
      { key: "rSafeAnnual", label: "Real safe return", kind: "pct" },
      { key: "inflationDisplay", label: "Inflation (display)", kind: "pct" },
      { key: "retirementExpenseMode", label: "Retire spend mode", kind: "select", options: [
        { value: "snapshot", label: "Snapshot" }, { value: "manual", label: "Manual" } ] },
      { key: "retirementAnnualSpend", label: "Retirement spend / yr", kind: "money" },
      { key: "capGainsTaxRate", label: "Cap-gains tax rate", kind: "pct" },
      { key: "retirementWithdrawTaxRate", label: "401k withdraw tax", kind: "pct" },
      { key: "earlyWithdrawPenalty", label: "Early-withdraw penalty", kind: "pct" },
    ],
  },
  {
    title: "Starting balances",
    fields: [
      { key: "bal401kStart", label: "401k", kind: "money" },
      { key: "balBrokerageStart", label: "Brokerage", kind: "money" },
      { key: "bal529Start", label: "529", kind: "money" },
      { key: "balHouseStart", label: "House fund", kind: "money" },
    ],
  },
  {
    title: "Advanced — tax constants",
    fields: [
      { key: "ssWageCap", label: "SS wage cap", kind: "money" },
      { key: "medicareSurtaxThreshold", label: "Medicare surtax (single)", kind: "money" },
      { key: "medicareSurtaxThresholdMFJ", label: "Medicare surtax (MFJ)", kind: "money" },
      { key: "ctcPerChild", label: "Child tax credit", kind: "money" },
      { key: "ctcPhaseoutSingle", label: "CTC phaseout (single)", kind: "money" },
      { key: "ctcPhaseoutMFJ", label: "CTC phaseout (MFJ)", kind: "money" },
      { key: "ctcChildMaxAge", label: "CTC max child age", kind: "int" },
      { key: "fedStdDeductionSingle", label: "Fed std deduction (single)", kind: "money" },
      { key: "fedStdDeductionMFJ", label: "Fed std deduction (MFJ)", kind: "money" },
      { key: "maPersonalExemptionSingle", label: "MA exemption (single)", kind: "money" },
      { key: "maPersonalExemptionMFJ", label: "MA exemption (MFJ)", kind: "money" },
      { key: "maRate", label: "MA income rate", kind: "pct" },
      { key: "maSurtaxRate", label: "MA surtax rate", kind: "pct" },
      { key: "maSurtaxThreshold", label: "MA surtax threshold", kind: "money" },
    ],
  },
];

// ---- Year-by-year aggregation (mirrors the desktop `yearly` memo) ----
interface YearAgg { year: number; gross: number; taxes: number; expensesTotal: number; fcf: number; endNetWorth: number }
function summarizeYears(sim: SimResult): YearAgg[] {
  const map = new Map<number, YearAgg>();
  for (const r of sim.rows) {
    let y = map.get(r.year);
    if (!y) { y = { year: r.year, gross: 0, taxes: 0, expensesTotal: 0, fcf: 0, endNetWorth: 0 }; map.set(r.year, y); }
    y.gross += r.iGross;
    y.taxes += r.taxTotal + r.taxProperty + r.taxCapGains;
    y.expensesTotal += r.expensesTotal;
    y.fcf += r.fcf;
    y.endNetWorth = r.netWorth;
  }
  return Array.from(map.values()).sort((a, b) => a.year - b.year);
}

export default function PlanningScreen() {
  const [store, setStore] = useState<ScenarioStore | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [namePrompt, setNamePrompt] = useState<{ mode: "new" | "rename"; value: string } | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    const s = await loadStore();
    setStore(s);
    setLoaded(true);
    setDirty(false);
  }, []);

  useFocusEffect(useCallback(() => { if (!dirty) load(); }, [load, dirty]));

  const active = store ? activeScenario(store) : undefined;

  const I = useMemo<Inputs | null>(() => (active ? mergeInputs(active.inputs as Partial<Inputs>) : null), [active]);
  const sim = useMemo<SimResult | null>(() => {
    if (!I) return null;
    const planY = parseYM(I.planStartDate)?.y ?? new Date().getFullYear();
    const yearsToAge100 = Math.max(1, 100 - (planY - 2000));
    return simulate({ ...I, horizonYears: yearsToAge100 });
  }, [I]);
  const yearly = useMemo(() => (sim ? summarizeYears(sim) : []), [sim]);

  function mutate(fn: (inputs: Inputs) => Inputs) {
    if (!store || !active) return;
    setStore({
      ...store,
      scenarios: store.scenarios.map((s) =>
        s.id === active.id ? { ...s, inputs: fn(mergeInputs(s.inputs as Partial<Inputs>)) } : s,
      ),
    });
    setDirty(true);
  }
  const setField = (key: keyof Inputs, value: unknown) => mutate((inp) => ({ ...inp, [key]: value }));

  function selectScenario(id: string) {
    if (!store) return;
    setStore({ ...store, activeId: id });
    setDirty(true);
  }

  async function save() {
    if (!store) return;
    setSaving(true);
    try { await saveStore(store); setDirty(false); }
    finally { setSaving(false); }
  }

  function commitName(name: string) {
    if (!store || !active || !namePrompt) return;
    if (namePrompt.mode === "new") {
      const id = "s" + Math.random().toString(36).slice(2, 8);
      setStore({
        scenarios: [...store.scenarios, { id, name, inputs: JSON.parse(JSON.stringify(active.inputs)) }],
        activeId: id,
        baselineId: store.baselineId,
      });
    } else {
      setStore({
        ...store,
        scenarios: store.scenarios.map((s) => (s.id === active.id ? { ...s, name } : s)),
      });
    }
    setDirty(true);
    setNamePrompt(null);
  }

  function deleteActive() {
    if (!store || !active) return;
    if (store.scenarios.length <= 1) { Alert.alert("Can't delete", "Keep at least one scenario."); return; }
    Alert.alert("Delete scenario", `Delete "${active.name}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => {
        const remaining = store.scenarios.filter((s) => s.id !== active.id);
        setStore({ scenarios: remaining, activeId: remaining[0].id, baselineId: store.baselineId });
        setDirty(true);
      } },
    ]);
  }

  function resetActive() {
    if (!active) return;
    Alert.alert("Reset scenario", `Reset "${active.name}" to defaults?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Reset", style: "destructive", onPress: () => mutate(() => ({ ...DEFAULTS })) },
    ]);
  }

  async function importCategories() {
    try {
      setImporting(true);
      const meds = await categoryMedians();
      const rows = meds
        .filter((m) => m.bucket !== "ignore")
        .map((m) => ({ category: m.category, monthly: Math.round(m.med), bucket: m.bucket as "rent" | "inelastic" | "discretionary" | "medical" }));
      if (rows.length === 0) { Alert.alert("No data", "No spending categories found to import yet."); return; }
      mutate((inp) => ({ ...inp, categoryOverrides: rows, categoriesImportedYM: new Date().toISOString().slice(0, 7) }));
      Alert.alert("Imported", `Loaded ${rows.length} categories from your last 12 months of spending. These now drive the expense buckets.`);
    } catch (e) {
      Alert.alert("Import failed", e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  const final = sim && sim.rows.length ? sim.rows[sim.rows.length - 1] : null;
  const nwPoints = yearly.map((y) => ({ x: y.year, y: y.endNetWorth }));
  const horizonYears = yearly.length ? yearly[yearly.length - 1].year : 0;
  const yr1 = yearly[0];
  const nominalFinal = final && I && I.inflationDisplay > 0
    ? final.netWorth * Math.pow(1 + I.inflationDisplay, horizonYears) : null;

  return (
    <Screen onRefresh={load} contentStyle={{ gap: spacing(4), paddingBottom: spacing(12) }}>
      <View style={styles.header}>
        <Text style={styles.h1}>Planning</Text>
        {dirty && (
          <Pressable onPress={save} style={styles.saveBtn} disabled={saving}>
            {saving ? <ActivityIndicator size="small" color="#04210f" /> : <Text style={styles.saveText}>Save</Text>}
          </Pressable>
        )}
      </View>

      {!loaded ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing(8) }} />
      ) : !store || !active || !I || !sim ? (
        <Card><CardTitle>No plan</CardTitle><Text style={styles.muted}>Something went wrong loading the planner.</Text></Card>
      ) : (
        <>
          {/* Scenario manager */}
          <Card>
            <CardTitle>Scenarios</CardTitle>
            <View style={styles.scenarioRow}>
              {store.scenarios.map((s: Scenario) => (
                <Pressable key={s.id} onPress={() => selectScenario(s.id)} style={[styles.chip, s.id === active.id && styles.chipOn]}>
                  <Text style={[styles.chipText, s.id === active.id && styles.chipTextOn]} numberOfLines={1}>{s.name}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.actionRow}>
              <Button title="New" small variant="secondary" onPress={() => setNamePrompt({ mode: "new", value: active.name + " copy" })} />
              <Button title="Rename" small variant="secondary" onPress={() => setNamePrompt({ mode: "rename", value: active.name })} />
              <Button title="Reset" small variant="ghost" onPress={resetActive} />
              <Button title="Delete" small variant="danger" onPress={deleteActive} disabled={store.scenarios.length <= 1} />
            </View>
          </Card>

          {/* KPIs */}
          <View style={styles.kpiGrid}>
            <Kpi label="Net worth @ age 100" value={final ? fmt(final.netWorth) : "—"} sub={nominalFinal ? `≈ ${fmtK(nominalFinal)} nominal` : undefined} />
            <Kpi label="Yr 1 gross" value={yr1 ? fmt(yr1.gross) : "—"} />
            <Kpi label="Yr 1 total tax" value={yr1 ? fmt(yr1.taxes) : "—"} />
            <Kpi label="Yr 1 effective rate" value={yr1 && yr1.gross > 0 ? ((yr1.taxes / yr1.gross) * 100).toFixed(1) + "%" : "—"} />
          </View>

          {/* Warnings */}
          {(sim.brokerageDepleteYear !== null || sim.cascadeYear !== null) && (
            <Card style={{ borderColor: colors.warn }}>
              <CardTitle>Plan health</CardTitle>
              {sim.brokerageDepleteYear !== null && (
                <Text style={styles.warnText}>
                  ⚠ Liquid net worth depletes around {yearOffsetToYM(sim.brokerageDepleteYear, I.planStartDate)}.
                </Text>
              )}
              {sim.cascadeYear !== null && (
                <Text style={styles.warnText}>
                  ⚠ Brokerage runs short around {yearOffsetToYM(sim.cascadeYear, I.planStartDate)} — dipping into emergency / house / 529 / 401k / HSA.
                </Text>
              )}
            </Card>
          )}

          {/* Net worth chart */}
          <Card>
            <CardTitle>Projected net worth (real $)</CardTitle>
            <LineChart data={nwPoints} valueFormatter={compactMoney} />
            <Text style={styles.footnote}>
              Full desktop model — MA tax brackets, mortgage amortization, RSU vesting, and the capital-allocation waterfall. Runs to age 100.
            </Text>
          </Card>

          {/* Final account balances */}
          {final && (
            <Card>
              <CardTitle>Final account balances</CardTitle>
              {(() => {
                const buckets = [
                  { label: "Brokerage", value: final.balBrokerage },
                  { label: "401k", value: final.bal401k },
                  { label: "House equity", value: final.balHouse },
                  { label: "HSA", value: final.balHsa },
                  { label: "529", value: final.bal529 },
                  { label: "Emergency", value: final.balEmergency },
                ];
                const max = Math.max(1, ...buckets.map((b) => Math.abs(b.value)));
                return buckets.map((b) => (
                  <CategoryBar key={b.label} label={b.label} value={b.value} max={max} color={b.value < 0 ? colors.negative : colors.accent} />
                ));
              })()}
            </Card>
          )}

          {/* Children */}
          <ChildrenEditor children={I.children} planStart={I.planStartDate}
            onChange={(c) => setField("children", c)} />

          {/* Goals */}
          <GoalsEditor goals={I.goals} planStart={I.planStartDate}
            onChange={(g) => setField("goals", g)} />

          {/* Additional homes */}
          <HomesEditor homes={I.additionalHomes} planStart={I.planStartDate}
            onChange={(h) => setField("additionalHomes", h)} />

          {/* Category overrides + import */}
          <Card>
            <CardTitle right={
              <Pressable onPress={importCategories} disabled={importing} style={styles.importBtn}>
                {importing ? <ActivityIndicator size="small" color={colors.accentSoft} /> :
                  <Text style={styles.importText}>Import from spending</Text>}
              </Pressable>
            }>Expense categories</CardTitle>
            {I.categoryOverrides.length === 0 ? (
              <Text style={styles.muted}>
                No per-category overrides — using the lump rent / inelastic / discretionary fields above.
                Tap “Import from spending” to pull your last-12-month medians from this device.
              </Text>
            ) : (
              <CategoryOverrideList rows={I.categoryOverrides}
                onChange={(rows) => setField("categoryOverrides", rows)} />
            )}
          </Card>

          {/* Scalar input groups */}
          {GROUPS.map((g) => (
            <CollapsibleGroup key={g.title} title={g.title} defaultOpen={g.title === "Cash compensation"}>
              {g.fields.map((f) => (
                <FieldRow key={String(f.key)} field={f} value={I[f.key]} planStart={I.planStartDate}
                  onChange={(v) => setField(f.key, v)} />
              ))}
            </CollapsibleGroup>
          ))}
        </>
      )}

      {/* Name prompt modal */}
      <Modal visible={!!namePrompt} transparent animationType="fade" onRequestClose={() => setNamePrompt(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{namePrompt?.mode === "new" ? "New scenario" : "Rename scenario"}</Text>
            <TextInput
              defaultValue={namePrompt?.value}
              onChangeText={(t) => setNamePrompt((p) => (p ? { ...p, value: t } : p))}
              placeholder="Scenario name"
              placeholderTextColor={colors.textFaint}
              autoFocus
              style={styles.modalInput}
            />
            <View style={styles.actionRow}>
              <Button title="Cancel" small variant="ghost" onPress={() => setNamePrompt(null)} />
              <Button title="Save" small onPress={() => namePrompt?.value.trim() && commitName(namePrompt.value.trim())} />
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

// ---- Scalar field row ----
function FieldRow({ field, value, planStart, onChange }: {
  field: FieldDef; value: unknown; planStart: string; onChange: (v: unknown) => void;
}) {
  if (field.kind === "bool") {
    return (
      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>{field.label}</Text>
        <Switch value={!!value} onValueChange={onChange}
          trackColor={{ true: colors.accentDeep, false: colors.surfaceAlt }} thumbColor={value ? colors.accentSoft : colors.textFaint} />
      </View>
    );
  }
  if (field.kind === "select") {
    const opts = field.options ?? [];
    const idx = Math.max(0, opts.findIndex((o) => o.value === value));
    return (
      <Pressable style={styles.fieldRow} onPress={() => onChange(opts[(idx + 1) % opts.length].value)}>
        <Text style={styles.fieldLabel}>{field.label}</Text>
        <View style={styles.selectPill}><Text style={styles.selectText}>{opts[idx]?.label ?? String(value)}</Text></View>
      </Pressable>
    );
  }
  return <NumField field={field} value={typeof value === "number" ? value : 0} planStart={planStart} onChange={onChange} />;
}

function NumField({ field, value, planStart, onChange }: {
  field: FieldDef; value: number; planStart: string; onChange: (v: number) => void;
}) {
  const toText = (v: number) =>
    field.kind === "pct" ? (v * 100).toFixed(2).replace(/\.?0+$/, "") :
    field.kind === "money" ? String(Math.round(v)) : String(v);
  const [text, setText] = useState(toText(value));
  const display = useMemo(() => toText(value), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { setText(display); }, [display]);

  function commit(raw: string) {
    const cleaned = raw.replace(/[^0-9.\-]/g, "");
    const n = parseFloat(cleaned);
    if (!isNaN(n)) onChange(field.kind === "pct" ? n / 100 : n);
    else if (cleaned === "" || cleaned === "-") onChange(0);
  }

  const yearHint = field.kind === "year" && value > 0 ? relativeDescription(value) + " · " + yearOffsetToYM(value, planStart) : null;

  return (
    <View style={[styles.fieldRow, { alignItems: "flex-start" }]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.fieldLabel}>{field.label}</Text>
        {field.help ? <Text style={styles.fieldHelp}>{field.help}</Text> : null}
        {yearHint ? <Text style={styles.fieldHelp}>{yearHint}</Text> : null}
      </View>
      <View style={styles.fieldInputWrap}>
        {field.kind === "money" && <Text style={styles.affix}>$</Text>}
        <TextInput value={text} onChangeText={setText} onEndEditing={(e) => commit(e.nativeEvent.text)}
          keyboardType="numbers-and-punctuation" style={styles.fieldInput} selectTextOnFocus />
        {field.kind === "pct" && <Text style={styles.affix}>%</Text>}
        {field.kind === "year" && <Text style={styles.affix}>yr</Text>}
      </View>
    </View>
  );
}

// ---- Collapsible section ----
function CollapsibleGroup({ title, children, defaultOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <Card>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.collapseHeader}>
        <Text style={styles.collapseTitle}>{title}</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.textFaint} />
      </Pressable>
      {open && <View style={{ gap: spacing(1) }}>{children}</View>}
    </Card>
  );
}

// ---- KPI tile ----
function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel} numberOfLines={2}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
      {sub ? <Text style={styles.kpiSub} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

// ---- Children editor ----
function ChildrenEditor({ children, planStart, onChange }: {
  children: Child[]; planStart: string; onChange: (c: Child[]) => void;
}) {
  const add = () => onChange([...children, {
    id: "c" + Math.random().toString(36).slice(2, 7), name: `Kid ${children.length + 1}`,
    birthYear: 2, amount529: 0, contribMode529: "monthly", collegeAnnualCost: 0, monthlyCost: 1000,
  }]);
  const upd = (id: string, patch: Partial<Child>) => onChange(children.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const del = (id: string) => onChange(children.filter((c) => c.id !== id));

  return (
    <Card>
      <CardTitle right={<Pressable onPress={add} style={styles.importBtn}><Text style={styles.importText}>+ Add kid</Text></Pressable>}>Children</CardTitle>
      {children.length === 0 && <Text style={styles.muted}>No children. Each adds monthly cost + an optional 529 and college draw.</Text>}
      {children.map((c) => (
        <View key={c.id} style={styles.subCard}>
          <View style={styles.subHeader}>
            <TextInput value={c.name} onChangeText={(t) => upd(c.id, { name: t })} style={styles.subName} placeholder="Name" placeholderTextColor={colors.textFaint} />
            <Pressable onPress={() => del(c.id)}><Ionicons name="trash-outline" size={18} color={colors.negative} /></Pressable>
          </View>
          <MiniNum label="Born in (yrs)" value={c.birthYear} onChange={(v) => upd(c.id, { birthYear: v })} hint={relativeDescription(c.birthYear)} />
          <MiniNum label="Monthly cost $" value={c.monthlyCost ?? 0} onChange={(v) => upd(c.id, { monthlyCost: v })} money />
          <MiniNum label="529 / mo $" value={c.amount529} onChange={(v) => upd(c.id, { amount529: v })} money />
          <MiniNum label="College / yr $" value={c.collegeAnnualCost ?? 0} onChange={(v) => upd(c.id, { collegeAnnualCost: v })} money />
        </View>
      ))}
    </Card>
  );
}

// ---- Goals editor ----
function GoalsEditor({ goals, planStart, onChange }: {
  goals: Goal[]; planStart: string; onChange: (g: Goal[]) => void;
}) {
  const add = () => onChange([...goals, {
    id: "g" + Math.random().toString(36).slice(2, 7), kind: "car", name: "New goal",
    startYear: 2, amount: 30000, ownershipMonthly: 0,
  }]);
  const upd = (id: string, patch: Partial<Goal>) => onChange(goals.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const del = (id: string) => onChange(goals.filter((g) => g.id !== id));
  const cycleKind = (g: Goal) => {
    const idx = GOAL_KINDS.findIndex((k) => k.value === g.kind);
    const next = GOAL_KINDS[(idx + 1) % GOAL_KINDS.length];
    upd(g.id, { kind: next.value as GoalKind, endYear: next.recurring ? (g.endYear ?? g.startYear + 4) : undefined });
  };

  return (
    <Card>
      <CardTitle right={<Pressable onPress={add} style={styles.importBtn}><Text style={styles.importText}>+ Add goal</Text></Pressable>}>Life goals</CardTitle>
      {goals.length === 0 && <Text style={styles.muted}>One-time or recurring withdrawals (car, college, kid expenses, big purchases).</Text>}
      {goals.map((g) => {
        const recurring = GOAL_KINDS.find((k) => k.value === g.kind)?.recurring;
        return (
          <View key={g.id} style={styles.subCard}>
            <View style={styles.subHeader}>
              <TextInput value={g.name} onChangeText={(t) => upd(g.id, { name: t })} style={styles.subName} placeholder="Name" placeholderTextColor={colors.textFaint} />
              <Pressable onPress={() => del(g.id)}><Ionicons name="trash-outline" size={18} color={colors.negative} /></Pressable>
            </View>
            <Pressable style={styles.fieldRow} onPress={() => cycleKind(g)}>
              <Text style={styles.fieldLabel}>Kind</Text>
              <View style={styles.selectPill}><Text style={styles.selectText}>{GOAL_KINDS.find((k) => k.value === g.kind)?.label ?? g.kind}</Text></View>
            </Pressable>
            <MiniNum label="Starts in (yrs)" value={g.startYear} onChange={(v) => upd(g.id, { startYear: v })} hint={relativeDescription(g.startYear)} />
            {recurring && <MiniNum label="Ends in (yrs)" value={g.endYear ?? g.startYear + 4} onChange={(v) => upd(g.id, { endYear: v })} />}
            <MiniNum label={recurring ? "Amount / yr $" : "Amount $"} value={g.amount} onChange={(v) => upd(g.id, { amount: v })} money />
            <MiniNum label="Ongoing cost / mo $" value={g.ownershipMonthly ?? 0} onChange={(v) => upd(g.id, { ownershipMonthly: v })} money />
          </View>
        );
      })}
    </Card>
  );
}

// ---- Additional homes editor ----
function HomesEditor({ homes, planStart, onChange }: {
  homes: { id: string; year: number; value: number; name?: string }[]; planStart: string;
  onChange: (h: { id: string; year: number; value: number; name?: string }[]) => void;
}) {
  const add = () => onChange([...homes, { id: "h" + Math.random().toString(36).slice(2, 7), year: 10, value: 1000000, name: `Home ${homes.length + 2}` }]);
  const upd = (id: string, patch: Partial<{ year: number; value: number; name: string }>) =>
    onChange(homes.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  const del = (id: string) => onChange(homes.filter((h) => h.id !== id));

  return (
    <Card>
      <CardTitle right={<Pressable onPress={add} style={styles.importBtn}><Text style={styles.importText}>+ Add home</Text></Pressable>}>Additional home moves</CardTitle>
      {homes.length === 0 && <Text style={styles.muted}>Extra sell-current → buy-new transitions beyond the first/second home above.</Text>}
      {homes.map((h) => (
        <View key={h.id} style={styles.subCard}>
          <View style={styles.subHeader}>
            <TextInput value={h.name ?? ""} onChangeText={(t) => upd(h.id, { name: t })} style={styles.subName} placeholder="Label" placeholderTextColor={colors.textFaint} />
            <Pressable onPress={() => del(h.id)}><Ionicons name="trash-outline" size={18} color={colors.negative} /></Pressable>
          </View>
          <MiniNum label="Move in (yrs)" value={h.year} onChange={(v) => upd(h.id, { year: v })} hint={relativeDescription(h.year)} />
          <MiniNum label="Home value $" value={h.value} onChange={(v) => upd(h.id, { value: v })} money />
        </View>
      ))}
    </Card>
  );
}

// ---- Category override list ----
const BUCKETS: ("rent" | "inelastic" | "discretionary" | "medical")[] = ["rent", "inelastic", "discretionary", "medical"];
function CategoryOverrideList({ rows, onChange }: {
  rows: { category: string; monthly: number; bucket: "rent" | "inelastic" | "discretionary" | "medical" }[];
  onChange: (r: typeof rows) => void;
}) {
  const total = rows.reduce((s, r) => s + r.monthly, 0);
  const cycle = (i: number) => {
    const idx = BUCKETS.indexOf(rows[i].bucket);
    onChange(rows.map((r, j) => (j === i ? { ...r, bucket: BUCKETS[(idx + 1) % BUCKETS.length] } : r)));
  };
  const setMonthly = (i: number, v: number) => onChange(rows.map((r, j) => (j === i ? { ...r, monthly: v } : r)));
  const del = (i: number) => onChange(rows.filter((_, j) => j !== i));
  return (
    <View style={{ gap: spacing(1) }}>
      <Text style={styles.muted}>{rows.length} categories · {money(total, { cents: false })}/mo total</Text>
      {rows.map((r, i) => (
        <View key={r.category + i} style={styles.catRow}>
          <Text style={styles.catName} numberOfLines={1}>{r.category}</Text>
          <Pressable onPress={() => cycle(i)} style={styles.bucketPill}><Text style={styles.bucketText}>{r.bucket}</Text></Pressable>
          <MiniInline value={r.monthly} onChange={(v) => setMonthly(i, v)} />
          <Pressable onPress={() => del(i)}><Ionicons name="close" size={16} color={colors.textFaint} /></Pressable>
        </View>
      ))}
    </View>
  );
}

// ---- Small numeric inputs ----
function MiniNum({ label, value, onChange, money: isMoney, hint }: {
  label: string; value: number; onChange: (v: number) => void; money?: boolean; hint?: string;
}) {
  const [text, setText] = useState(isMoney ? String(Math.round(value)) : String(value));
  const display = useMemo(() => (isMoney ? String(Math.round(value)) : String(value)), [value, isMoney]);
  React.useEffect(() => { setText(display); }, [display]);
  return (
    <View style={styles.fieldRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {hint ? <Text style={styles.fieldHelp}>{hint}</Text> : null}
      </View>
      <View style={styles.fieldInputWrap}>
        {isMoney && <Text style={styles.affix}>$</Text>}
        <TextInput value={text} onChangeText={setText}
          onEndEditing={(e) => { const n = parseFloat(e.nativeEvent.text.replace(/[^0-9.\-]/g, "")); onChange(isNaN(n) ? 0 : n); }}
          keyboardType="numbers-and-punctuation" style={styles.fieldInput} selectTextOnFocus />
      </View>
    </View>
  );
}

function MiniInline({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(Math.round(value)));
  const display = useMemo(() => String(Math.round(value)), [value]);
  React.useEffect(() => { setText(display); }, [display]);
  return (
    <View style={styles.inlineWrap}>
      <Text style={styles.affix}>$</Text>
      <TextInput value={text} onChangeText={setText}
        onEndEditing={(e) => { const n = parseFloat(e.nativeEvent.text.replace(/[^0-9.\-]/g, "")); onChange(isNaN(n) ? 0 : n); }}
        keyboardType="numbers-and-punctuation" style={styles.inlineInput} selectTextOnFocus />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  h1: { color: colors.text, fontSize: font.size.xl, fontWeight: font.weight.bold },
  saveBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: spacing(4), paddingVertical: spacing(2), minWidth: 64, alignItems: "center" },
  saveText: { color: "#04210f", fontWeight: font.weight.semibold },
  muted: { color: colors.textMuted, fontSize: font.size.sm, lineHeight: 20 },
  footnote: { color: colors.textFaint, fontSize: font.size.xs, marginTop: spacing(2), lineHeight: 16 },
  warnText: { color: colors.warn, fontSize: font.size.sm, lineHeight: 20 },

  scenarioRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2) },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2), alignItems: "center" },
  chip: { borderColor: colors.border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing(3), paddingVertical: spacing(1), maxWidth: 180 },
  chipOn: { backgroundColor: colors.accentDeep, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: font.size.sm },
  chipTextOn: { color: colors.text, fontWeight: font.weight.semibold },

  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing(2) },
  kpi: { flexGrow: 1, flexBasis: "47%", backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: spacing(3), gap: spacing(1) },
  kpiLabel: { color: colors.textFaint, fontSize: font.size.xs },
  kpiValue: { color: colors.text, fontSize: font.size.lg, fontWeight: font.weight.bold, fontVariant: ["tabular-nums"] },
  kpiSub: { color: colors.textFaint, fontSize: font.size.xs },

  collapseHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  collapseTitle: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: font.weight.semibold, textTransform: "uppercase", letterSpacing: 0.5 },

  fieldRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing(2), borderBottomColor: colors.borderSubtle, borderBottomWidth: 1, gap: spacing(2) },
  fieldLabel: { color: colors.text, fontSize: font.size.sm },
  fieldHelp: { color: colors.textFaint, fontSize: font.size.xs, marginTop: 2 },
  fieldInputWrap: { flexDirection: "row", alignItems: "center", gap: spacing(1), backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing(3), minWidth: 120 },
  affix: { color: colors.textFaint, fontSize: font.size.sm },
  fieldInput: { color: colors.text, fontSize: font.size.base, paddingVertical: spacing(2), flex: 1, textAlign: "right", fontVariant: ["tabular-nums"], minWidth: 60 },

  selectPill: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing(3), paddingVertical: spacing(2) },
  selectText: { color: colors.accentSoft, fontSize: font.size.sm, fontWeight: font.weight.medium },

  importBtn: { paddingHorizontal: spacing(2), paddingVertical: spacing(1) },
  importText: { color: colors.accentSoft, fontSize: font.size.sm, fontWeight: font.weight.semibold },

  subCard: { backgroundColor: colors.bg, borderColor: colors.borderSubtle, borderWidth: 1, borderRadius: radius.md, padding: spacing(3), gap: spacing(1), marginTop: spacing(2) },
  subHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing(1) },
  subName: { color: colors.text, fontSize: font.size.base, fontWeight: font.weight.semibold, flex: 1, paddingVertical: spacing(1) },

  catRow: { flexDirection: "row", alignItems: "center", gap: spacing(2), paddingVertical: spacing(1), borderBottomColor: colors.borderSubtle, borderBottomWidth: 1 },
  catName: { color: colors.text, fontSize: font.size.sm, flex: 1 },
  bucketPill: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: spacing(2), paddingVertical: 2 },
  bucketText: { color: colors.accentSoft, fontSize: font.size.xs },
  inlineWrap: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: spacing(2), minWidth: 80 },
  inlineInput: { color: colors.text, fontSize: font.size.sm, paddingVertical: spacing(1), flex: 1, textAlign: "right", fontVariant: ["tabular-nums"] },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: spacing(6) },
  modalCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderColor: colors.border, borderWidth: 1, padding: spacing(4), gap: spacing(3) },
  modalTitle: { color: colors.text, fontSize: font.size.lg, fontWeight: font.weight.semibold },
  modalInput: { backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, color: colors.text, paddingHorizontal: spacing(3), paddingVertical: spacing(3), fontSize: font.size.base },
});
