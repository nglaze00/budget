import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getPlanning, setPlanning } from "@/lib/data";
import {
  DEFAULTS,
  mergeInputs,
  reanchorInputs,
  classifyCategory,
  median,
  todayYM,
  type Inputs,
  type Scenario,
  type ScenarioStore,
} from "@/lib/planning-engine";

// Storage + import glue for the mobile Planning screen. The full simulation /
// tax engine lives in planning-engine.ts (a verbatim port of the desktop
// model). This file owns the on-device persistence of the ScenarioStore (the
// same JSON blob the desktop writes to `planning_store`, so it round-trips
// through sync untouched) plus the local category-median import.

export type { Inputs, Scenario, ScenarioStore };

function freshStore(): ScenarioStore {
  const id = "s" + Math.random().toString(36).slice(2, 8);
  return { scenarios: [{ id, name: "Current plan", inputs: { ...DEFAULTS } }], activeId: id };
}

export async function loadStore(): Promise<ScenarioStore> {
  const raw = await getPlanning();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ScenarioStore;
      if (parsed?.scenarios?.length) {
        parsed.scenarios = parsed.scenarios.map((s) => ({ ...s, inputs: mergeInputs(s.inputs as Partial<Inputs>) }));
        if (!parsed.scenarios.find((s) => s.id === parsed.activeId)) {
          parsed.activeId = parsed.scenarios[0].id;
        }
        // Re-anchor the active scenario to the current month (matches desktop).
        parsed.scenarios = parsed.scenarios.map((s) =>
          s.id === parsed.activeId ? { ...s, inputs: reanchorInputs(s.inputs) } : s,
        );
        return parsed;
      }
    } catch {}
  }
  return freshStore();
}

export async function saveStore(store: ScenarioStore): Promise<void> {
  await setPlanning(JSON.stringify(store));
}

export function activeScenario(store: ScenarioStore): Scenario {
  return store.scenarios.find((s) => s.id === store.activeId) ?? store.scenarios[0];
}

// Compute 12-month category medians directly from the on-device DB — the mobile
// equivalent of the desktop /api/stats `categoryMonthly` query. Returns the
// median monthly spend per category (over the trailing 12 months) plus a
// suggested expense bucket. Sorted high→low.
export async function categoryMedians(): Promise<
  { category: string; med: number; bucket: ReturnType<typeof classifyCategory> }[]
> {
  const month = new Date().toISOString().slice(0, 7);
  const start = `${shiftYM(month, -11)}-01`;
  const endExclusive = `${month}-01`;
  const rows = await db.all<{ category: string; month: string; total: number }>(sql`
    WITH RECURSIVE months(m) AS (
      SELECT date(${start})
      UNION ALL
      SELECT date(m, '+1 month') FROM months WHERE m < date(${endExclusive})
    ),
    active_cats AS (
      SELECT DISTINCT category FROM transactions
      WHERE flow_type = 'spend' AND category IS NOT NULL
        AND category != 'Credit card payments'
        AND date >= date(${start})
        AND date < date(${endExclusive}, '+1 month')
    )
    SELECT
      c.category AS category,
      strftime('%Y-%m', m.m) AS month,
      ROUND(COALESCE(SUM(ABS(t.amount)), 0), 2) AS total
    FROM active_cats c
    CROSS JOIN months m
    LEFT JOIN transactions t
      ON t.category = c.category
      AND t.flow_type = 'spend'
      AND strftime('%Y-%m', t.date) = strftime('%Y-%m', m.m)
    GROUP BY c.category, m.m
    ORDER BY c.category, m.m
  `);

  const byCat = new Map<string, number[]>();
  for (const r of rows) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)!.push(r.total);
  }
  const out: { category: string; med: number; bucket: ReturnType<typeof classifyCategory> }[] = [];
  for (const [category, values] of byCat) {
    const med = median(values);
    if (med <= 0) continue;
    out.push({ category, med, bucket: classifyCategory(category) });
  }
  out.sort((a, b) => b.med - a.med);
  return out;
}

export { todayYM };

function shiftYM(ym: string, deltaMonths: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + deltaMonths;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}
